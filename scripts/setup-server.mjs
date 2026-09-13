import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
const candidates = [process.env.YTDLP_PYTHON, 'python', 'python3', path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')].filter(Boolean);
const python = candidates.find(command => spawnSync(command, ['--version'], { windowsHide: true, timeout: 5000 }).status === 0);
if (!python) throw new Error('Install Python 3.10 or newer, then run npm run setup:server again.');
for (const [command, args] of [[python, ['-m', 'venv', 'server/.venv']], [path.resolve('server/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), ['-m', 'pip', 'install', '-r', 'server/requirements.txt']]]) {
  if (spawnSync(command, args, { stdio: 'inherit', windowsHide: true }).status !== 0) process.exit(1);
}
console.log('Media server is ready. Run npm run server.');
