# The Saver

An Expo Go React Native app for saving authorized videos from X, Facebook Pages, and linked Instagram professional accounts. Official OAuth API access is now the default. Follow [Official API setup](docs/OFFICIAL_APIS.md) to register developer apps, configure server-side credentials, and connect accounts. Provider consent has not been live-tested yet; developer apps are still needed.

The public yt-dlp downloader remains available only when `MEDIA_ACCESS_MODE=legacy` is explicitly set in `server/.env`. The original public-video instructions and five-link verification below describe that legacy mode.

## Run on your phone

Prerequisites: Node.js 22.13+ (Node 24 recommended), Python 3.10+, and an Expo Go version that supports SDK 57. The server setup creates a project-local Python environment. On this workstation it can also discover the bundled Python runtime.

```sh
npm install
npm run setup:server
```

Start the companion server in one terminal:

```sh
npm run server
```

Start Expo in another terminal:

```sh
npm start
```

Connect the phone and computer to the same Wi-Fi and scan the Expo QR code. The app derives the server address from Expo's LAN host. If needed, open Settings and set `http://YOUR_COMPUTER_IP:8787`, then tap **Test connection**. Windows Firewall may ask you to allow Node on your private network. An Expo tunnel does not tunnel the media server; use LAN mode or a separately secured reachable server.

## Use

1. Copy a public video post or reel URL from X, Instagram, or Facebook.
2. Return to The Saver. A compatible clipboard URL is pasted automatically, subject to the phone's clipboard permission. Manual paste is also available. Disable auto-paste in Settings if preferred.
3. Tap **Preview video** to fetch the thumbnail, title, creator, duration, and available resolution.
4. Tap **Download video**. The app reports the platform download progress, followed by the transfer to your phone. Keep the app open during the download.
5. The completed MP4 is stored in the app's document directory. The app then requests permission to also save it to Photos/Gallery. Denying gallery access does not discard the app copy.
6. Open **Saved** for offline video playback, sharing/export, retrying gallery save, or removing the app copy.

## Scope and limitations

- Video posts and reels are supported. Photo-only posts are not implemented. For multi-video posts, the first video is selected.
- The backend uses yt-dlp's platform extractors. Platform changes, rate limits, region restrictions, private posts, and login requirements can prevent extraction. No account credentials or cookies are collected and access controls are not bypassed. See [yt-dlp supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).
- Downloads use the best available progressive MP4 containing both audio and video. This avoids requiring FFmpeg and keeps playback compatible, but some posts expose only segmented formats and will fail with a clear message. Higher-resolution separate audio/video merging is not implemented.
- Maximum video size is 500 MB. Temporary server jobs expire after one hour; re-preview expired jobs. The server must be running for new previews/downloads, but already saved videos play offline.
- Expo Go's app data is not permanent device storage: uninstalling Expo Go or clearing its data removes app-local files. Use gallery save or Share to retain exported copies.
- iOS may ask permission to paste. Android/Expo Go may restrict gallery permissions; the local library and Share remain available. True OS-managed background downloads are not implemented.
- The web version is for interface/preview testing; local downloads and gallery features require Android or iOS.
- The companion server is intended for a trusted development LAN. It has no public authentication, uses bounded extraction concurrency, and must not be exposed directly to the internet. Production hosting needs authentication, TLS, rate limiting, isolated extractor workers, storage quotas, and network egress restrictions.

## Development

```sh
npm run typecheck
npm test
npm run build
npm run web
```

Tests cover link validation, platform errors, size limits, download job progress, retries, and file/range responses using an injected extractor fixture. A regression test also runs the real yt-dlp format selector against X-style MP4 metadata with unknown codecs. Physical-device gallery permissions still require device testing.

## Verified X downloads — 12 September 2026

The running companion API successfully previewed, prepared, and downloaded all five posts below to local MP4 files. Verification checked complete byte counts, MP4 container structure, audio/video tracks, and HTTP range responses. Results, SHA-256 hashes, and observed progress are in `verification/x-downloads.json`; the downloaded videos are in `verification/downloads/` (gitignored).

| X post | Downloaded bytes | Resolution |
| --- | ---: | --- |
| [Blaqclips07](https://x.com/Blaqclips07/status/2098569453155807630?s=20) | 2,485,752 | 716 × 906 |
| [Simpsons DG](https://x.com/simpsons_DG/status/2095957790141383056) | 1,012,257 | 640 × 480 |
| [Brooklyn Nets](https://x.com/BrooklynNets/status/1349794411333394432) | 18,026,188 | 1280 × 720 |
| [Oshtru](https://x.com/oshtru/status/1577855540407197696) | 1,787,622 | 720 × 900 |
| [Southampton FC](https://x.com/SouthamptonFC/status/1347577658079641604) | 9,740,490 | 1280 × 720 |

With the server running, repeat these live tests with `node scripts/verify-x-downloads.mjs`. Optional command arguments replace the default URL list. Live tests use the network and download real media; post availability may change.

The original failure was caused by redundant codec filters rejecting progressive MP4s whose codecs X did not specify. The corrected selector accepts unknown codec metadata while excluding explicit audio-only/video-only streams. Format failures, unavailable posts, rate limiting, and connection failures now have distinct messages; full extractor diagnostics stay in the companion server log.

`App.tsx` contains the phone interface and local download lifecycle. `src/api.ts` holds the API client and types; `shared/links.mjs` is shared URL validation. `server/index.mjs` provides `/resolve`, `/media/:id`, `/media/:id/download`, `/media/:id/file`, and `/health`. `server/runner.mjs` runs yt-dlp without invoking a shell. `server/requirements.txt` pins the extractor release; update and test it when platforms change.

Native functionality uses Expo Go modules: [Clipboard](https://docs.expo.dev/versions/latest/sdk/clipboard/), [FileSystem](https://docs.expo.dev/versions/latest/sdk/filesystem-legacy/), [Video](https://docs.expo.dev/versions/latest/sdk/video/), and [MediaLibrary](https://docs.expo.dev/versions/latest/sdk/media-library/).
