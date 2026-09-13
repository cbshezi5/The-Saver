import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractorMessage } from "./errors.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const venv = path.join(
  here,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python"
);
export function runExtractor(args, onLine = () => {}, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const executable =
      process.env.YTDLP_PYTHON || (existsSync(venv) ? venv : "python");
    const child = spawn(
      executable,
      [
        "-m",
        "yt_dlp",
        "--ignore-config",
        "--no-playlist",
        "--playlist-items",
        "1",
        "--no-colors",
        "--socket-timeout",
        "20",
        ...args,
      ],
      { windowsHide: true }
    );
    let output = "",
      errors = "",
      pending = "",
      settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("The platform took too long to respond. Try again."));
    }, timeout);
    child.on("error", () =>
      finish(
        new Error(
          "Media server needs setup. Run npm run setup:server on the computer."
        )
      )
    );
    child.stdout.on("data", (data) => {
      output += data;
      pending += data;
      if (output.length > 16 * 1024 * 1024) {
        child.kill();
        finish(new Error("Post metadata is too large."));
      }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr.on("data", (data) => {
      errors = (errors + data).slice(-12000);
    });
    child.on("close", (code) => {
      if (pending) onLine(pending);
      if (code === 0) return finish(null, output);
      // Keep actionable diagnostics on the trusted companion server. Never send
      // upstream URLs or headers in API errors to the phone.
      console.error("[media extractor]", errors.trim());
      finish(new Error(extractorMessage(errors)));
    });
  });
}
