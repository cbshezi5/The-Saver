# Deploy the media server to Render

The root `Dockerfile` builds the Node media backend with Python and the pinned yt-dlp release. It runs as a non-root user and does not install Expo or copy credentials, local media, or node_modules. Both official and explicitly selected legacy modes are available.

## Deploy

1. Push this repository, including `Dockerfile`, `.dockerignore`, and `render.yaml`, to your Git provider.
2. In Render, choose **New → Blueprint**, connect the repository, and select the root `render.yaml`. Review the service configuration before deploying. The example uses one free instance.
3. Alternatively, create a **Web Service**, select **Docker**, set Dockerfile Path to `./Dockerfile`, Docker Build Context to `.`, and Health Check Path to `/health`. Leave Docker Command empty to use the Dockerfile's startup command.
4. Set the environment variables below in the Render service dashboard. Redeploy after changing them.

These paths assume the Git repository root contains `package.json`, `server/`, and `Dockerfile`. On this workstation that root is the nested `The-Saver` folder. Do not set Render's Root Directory to `server`: the image also requires `shared/`.

Render builds the image from the Dockerfile and runs its `CMD`; the server already binds to `0.0.0.0` and honors `PORT`. The supplied configuration uses port 10000 and an HTTP health check. See [Render Docker deployment](https://render.com/docs/docker) and [health checks](https://render.com/docs/health-checks).

## Official OAuth environment

| Variable | Value |
| --- | --- |
| `MEDIA_ACCESS_MODE` | `official` (default) |
| `OAUTH_PUBLIC_BASE_URL` | Your actual service origin, e.g. `https://the-saver-media-xxxx.onrender.com` |
| `X_CLIENT_ID` | OAuth 2.0 client ID from your X developer app |
| `X_CLIENT_SECRET` | Required for a confidential X web client; omit for a public client |
| `META_APP_ID` | Meta developer App ID |
| `META_APP_SECRET` | Meta developer App Secret |
| `META_GRAPH_VERSION` | A supported version selected in your Meta dashboard, in `vNN.0` format |

Configure only the providers you intend to use. App registration/approval and consent are still required. Missing credentials leave the corresponding Connect button disabled; `/health` can pass before provider setup is complete.

Register these exact redirect URLs in the respective developer dashboards, using your actual Render hostname:

```text
https://YOUR-SERVICE.onrender.com/oauth/x/callback
https://YOUR-SERVICE.onrender.com/oauth/meta/callback
```

Set the mobile app's **Settings → Media server** to `https://YOUR-SERVICE.onrender.com` (without `:10000`), save it, then connect the accounts. You can also set `EXPO_PUBLIC_API_URL` when starting/building the mobile app. Do not add provider secrets to the mobile app or use Docker build arguments for them. Render supplies configured environment variables at runtime; see [Render environment variables](https://render.com/docs/configure-environment-variables).

Full OAuth instructions and account restrictions: [OFFICIAL_APIS.md](OFFICIAL_APIS.md).

## Existing public download mode

For public yt-dlp downloads, explicitly set `MEDIA_ACCESS_MODE=legacy` in Render and redeploy. OAuth credentials are not used for downloads in that mode. This exposes the development downloader to anyone who can reach the service; use an access-controlled deployment for personal testing. The container does not add a scraper fallback to official mode.

## Current hosting limitations

The Dockerfile packages the existing development companion; it does not turn it into a hardened public service. Sessions, OAuth grants, and job metadata are held in memory, and downloaded server files are temporary. Restarts, deploys, and instance replacement lose connections/jobs. Reconnect accounts and re-preview links afterwards. A disk alone would not persist the in-memory state.

Keep one instance: callbacks and subsequent requests must reach the instance holding their session. Render free services can sleep, which adds cold-start latency; interrupted long downloads may need retrying. Before opening this to arbitrary users, add application login/access control, durable encrypted token/session storage, quotas, and the remaining production controls described in the OAuth guide. Docker isolation does not supply these controls.

## Local Docker check

Run from the repository root:

```sh
docker build -t the-saver-media .
docker run --rm --name the-saver-media -p 8787:10000 --env-file server/.env the-saver-media
```

Omit `--env-file server/.env` if it does not exist and you only want to check the unconfigured service. The image defaults to official mode. Visit `http://localhost:8787/health`; expect `{"ok":true,"mode":"official"}`. The container uses port 10000 unless you override `PORT`.

```sh
docker stop the-saver-media
```
