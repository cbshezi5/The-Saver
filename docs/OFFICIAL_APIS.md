# Official API setup

This implementation is ready for developer-app configuration and consent testing. No real X or Meta app has been registered or connected yet. Automated tests use simulated provider responses; they do not certify app-review approval or live API access.

## What can be downloaded

- **X:** video attachments on posts authored by the currently connected X account. Knowing a post URL or having permission to view another account does not make that account an authorized owner in this app. Another owner must connect their own account in their own session.
- **Facebook:** videos returned by the Graph API for Pages the consenting user manages. Personal-profile videos, Groups, and arbitrary public posts are not included.
- **Instagram:** videos/reels (including the first video in a carousel) on a professional account linked to an authorized Facebook Page. Consumer/personal Instagram accounts are not supported by this Facebook Login integration. This is Meta's [Instagram API with Facebook Login](https://www.postman.com/meta/instagram/folder/u4g5a2a/instagram-api-with-facebook-login), not its separate Instagram Login flow.

Meta URL matching is bounded to the first 25 returned Pages and their first 100 media records. Use original `/reel/SHORTCODE/` or `/p/SHORTCODE/` Instagram URLs, and Facebook `/reel/NUMERIC_ID/`, `/PAGE/videos/NUMERIC_ID/` or `/watch/?v=NUMERIC_ID` URLs. Shortened/share URLs and older content outside that lookup window return a clear error. No scraping fallback runs in official mode.

## 1. Prepare the server configuration

From the project folder, copy the template once (do not overwrite an existing configuration):

```powershell
Copy-Item server/.env.example server/.env
```

Edit `server/.env` locally. Do not paste credentials into chat or commit that file. The server loads it automatically with `npm run server`.

```dotenv
MEDIA_ACCESS_MODE=official
OAUTH_PUBLIC_BASE_URL=https://YOUR-BACKEND-HOST
X_CLIENT_ID=
X_CLIENT_SECRET=
META_APP_ID=
META_APP_SECRET=
META_GRAPH_VERSION=
```

Choose `META_GRAPH_VERSION` from the supported version shown in your Meta app dashboard, using the `vNN.0` format. No version is silently selected for your app.

Use a public HTTPS origin that routes to this companion server for the provider callbacks. Register **exactly** these callback URLs:

```text
https://YOUR-BACKEND-HOST/oauth/x/callback
https://YOUR-BACKEND-HOST/oauth/meta/callback
```

`OAUTH_PUBLIC_BASE_URL` must contain only the scheme and host (and port if applicable), with no path/query. An Expo tunnel only exposes Metro; it does not expose the media backend. No hosting or tunnel has been created by this change. For computer-only testing, the code allows HTTP localhost callbacks; your provider's registration rules still apply. On a phone, localhost points to the phone.

The app's media-server address must reach the **same backend instance** as the callback origin. For initial development, expose only the two `/oauth/.../callback` routes through your HTTPS reverse proxy and keep the other API routes on the trusted LAN. Use the LAN backend address on your phone. Serving the entire API publicly needs the production controls listed below. Provider secrets must never use an `EXPO_PUBLIC_` prefix. The only optional public environment setting remains `EXPO_PUBLIC_API_URL`.

## 2. Register X

Create a developer project/app with access to user and post lookup in the [X developer console](https://console.x.com/). Verify API entitlement and budget there; the code does not purchase access or assume a rate-limit tier.

Enable OAuth 2.0 and register the X callback above. Set `X_CLIENT_ID` to the OAuth 2.0 client ID. For a confidential web client, also set `X_CLIENT_SECRET`; public clients omit it. These are not the older OAuth 1.0 API key/secret pair.

The app requests `tweet.read users.read offline.access`, using an S256 PKCE challenge and a one-use random state. Read scopes permit lookup; offline access supplies refresh tokens. See [X OAuth authorization code flow](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code).

After consent, the server calls `/2/users/me`, checks the post's `author_id` against that account, then selects an MP4 from the post's attached media variants. See [X media fields](https://docs.x.com/x-api/fundamentals/data-dictionary). X refresh tokens rotate when needed. Revoked/invalid authorization requires reconnecting.

## 3. Register Meta

Create a suitable business app in [Meta for Developers](https://developers.facebook.com/apps/) and configure Facebook Login for the Page/Instagram use case, with the Meta callback above. Copy its App ID and App Secret to the server configuration.

Request only these read permissions for this implementation:

```text
pages_show_list
pages_read_engagement
instagram_basic
```

Use an app-role/test account with permission to manage a Page, and link its Instagram Business/Creator account to that Page if testing Instagram. Meta's [official Page-token collection](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api) describes using `/me/accounts` to obtain tokens for managed Pages; its [Instagram collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-4b9737aa-d320-498a-a092-7225a0a785b7) describes the linked account IDs.

For users outside app roles, complete the permissions/access review, business verification where required, privacy policy and data-deletion requirements shown in your Meta dashboard. Registering an app or implementing OAuth does not grant approval. Publishing, messaging, and advertising permissions are not requested here.

The server exchanges the code for a user token, exchanges that for a longer-lived token, and retrieves Page tokens only when resolving media. Expired Meta grants require reconnecting; no perpetual refresh is assumed. Some Page video types may not return a `source` field for your version/permissions. The app will report that limitation rather than scrape around it.

## 4. Connect and test in Expo Go

Run `npm run server` and `npm start` in separate terminals. In the app, save the correct backend address under Settings, reopen Settings, then:

1. Open **Connected accounts** and choose **Connect account**.
2. Complete the provider's consent flow in the system browser.
3. The backend callback displays a success or failure message. Return to The Saver and tap **Refresh accounts** (the app also refreshes when foregrounded).
4. Paste a video URL owned by that connection, preview, and download.
5. Verify progress, the local file, and gallery save on a physical device.

Expo Go requires no custom OAuth redirect scheme here: OAuth returns to the backend, not to an Expo proxy. Provider access/refresh tokens never appear in callback responses or app storage. The phone stores only its own opaque backend session credential in Expo SecureStore; the web preview holds that credential in memory.

## Development boundaries

Sessions and provider grants are intentionally memory-only, expire after 24 hours, and disappear when the server restarts. Reconnect after a restart. This avoids storing real provider credentials on disk before a production token vault is designed.

Every official preview, download job, and file request requires its owning session. Disconnecting here removes the local grant, cancels its in-progress transfers, and invalidates that provider's server-side jobs in the session; copies already saved on a device remain. It does not revoke the app at the provider. Use the provider's connected-app controls to revoke there.

API rate limits return HTTP 429 and `Retry-After`; the code does not retry rate-limited API requests automatically. Signed media URLs are re-resolved at download time. Only HTTPS media CDN hosts for the selected platform are accepted, including redirect targets. Provider tokens are not forwarded to CDNs. Transfers enforce the 500 MB limit and reject non-MP4/incomplete responses.

This remains a development companion, not a production multi-user service. Before public hosting, add application login and pairing, persistent encrypted token storage, shared session/job storage, per-user/IP quotas, constrained CORS, network egress controls, and the provider-required privacy/revocation/deletion workflows. Do not expose the development service to arbitrary users.

## Verification

```powershell
npm test
npm run typecheck
npm run build
```

Tests cover PKCE, state mismatch/expiry/replay/denial, refresh rotation, ownership, session isolation, Meta account-scoped lookup, rate limits, and CDN/transfer restrictions using mock responses. Real consent and media access must be tested after app registration. The earlier five public X download tests apply to **legacy mode only** and are not proof of official API access.

To deliberately return to public yt-dlp behavior for local development, set `MEDIA_ACCESS_MODE=legacy` in `server/.env` and restart. Official requests never automatically fall back to legacy mode.
