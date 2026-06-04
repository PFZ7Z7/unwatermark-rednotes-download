# Public Enhanced Cookie Flow

## Goal

The app has no separate management page. Normal note-link parsing is available by default. Keyword search and creator-note search require enhanced mode, which is enabled from the top-right dialog on the public page.

## User-Facing Behavior

- The top-right button opens the enhanced-mode dialog.
- The dialog shows driver status, Cookie configured state, verified account metadata, and last validation timestamps.
- Any visitor can paste a Xiaohongshu Cookie header that contains `web_session`.
- Any visitor can clear the saved Cookie.
- The Cookie is never rendered back to the browser after save.
- Search and creator flows open the dialog and stop early when enhanced mode is not ready.
- Normal single-link parsing is not gated by enhanced mode.

## API Contract

```http
GET /api/login-status
```

Returns safe status metadata:

```json
{
  "success": true,
  "data": {
    "mode": "SHARED_COOKIE",
    "canSelfLogin": true,
    "driverRunning": true,
    "loginValid": true,
    "enhancedModeAvailable": true,
    "loginMessage": "增强模式已可用",
    "hint": null,
    "cookieConfigured": true,
    "cookieValidFormat": true,
    "cookieVerified": true,
    "cookieAccount": {
      "nickname": "example",
      "avatar": "https://...",
      "userId": "example_id"
    },
    "cookieUpdatedAt": "2026-06-04T00:00:00.000Z",
    "cookieValidatedAt": "2026-06-04T00:00:00.000Z"
  }
}
```

```http
POST /api/enhanced-cookie
Content-Type: application/json
```

Request:

```json
{ "cookie": "a=1; web_session=..." }
```

Validation:

- Cookie must be a string.
- Cookie must be non-empty.
- Cookie length must be at most 50000 characters.
- Cookie must not contain line breaks or control characters.
- Cookie must include a non-empty `web_session` key.
- The driver must verify the Cookie against Xiaohongshu `selfinfo`.
- Successful validation stores only the raw Cookie server-side plus safe account metadata.
- Any validation failure clears the previously stored Cookie and runtime result caches before returning an error.

```http
POST /api/enhanced-cookie/clear
```

Clears the saved Cookie and returns the same safe status shape.

## Storage

- `XHS_COOKIE_STORE_PATH` controls where the shared Cookie record is stored.
- Default path is `runtime/xhs-cookie.json`.
- Docker sets it to `/app/runtime/xhs-cookie.json`.
- File permissions are set to `0600`.
- The runtime directory is persisted by the `xhs_downloader_runtime` Docker volume.

## Docker Deployment

Default deployment remains:

```bash
docker compose up -d --build
```

Compose starts:

- `xhs-downloader`: frontend, backend, public API, static assets.
- `xhs-driver`: enhanced-mode driver with pinned MediaCrawler, Playwright, and Chromium.

MediaCrawler source is cloned at driver-image build time and is not committed to this repo.
The driver image also installs a project-owned `/api/xhs/validate-cookie` route and disables persistent browser login state so old browser-profile Cookies are not reused.

Domestic mirror knobs remain in `.env.docker.example`:

- `USE_ALIYUN_APT_MIRROR`
- `NPM_REGISTRY`
- `PIP_INDEX_URL`
- `PLAYWRIGHT_DOWNLOAD_HOST`
- `MEDIACRAWLER_REPO`

## Security Boundaries

- This is a public shared state model, not a privileged owner-only model.
- Anyone who can access the page can submit, overwrite, or clear the saved Cookie.
- The backend must not log or return the raw Cookie.
- The frontend must not persist Cookie content in localStorage/sessionStorage.
- Search and creator result caches must be scoped by Cookie fingerprint, not only by keyword or creator ID.
- The project still relies on same-origin deployment or configured CORS origins.

## Verification

Local verification should not use real Xiaohongshu Cookies unless explicitly requested.

Required no-Cookie checks:

```bash
rm -f backend/runtime/xhs-cookie.json
curl -s http://127.0.0.1:3001/api/login-status
curl -s -X POST http://127.0.0.1:3001/api/enhanced-cookie \
  -H 'Content-Type: application/json' \
  -d '{"cookie":"a=1"}'
curl -s -X POST http://127.0.0.1:3001/api/enhanced-cookie \
  -H 'Content-Type: application/json' \
  -d '{"cookie":"web_session=invalid"}'
curl -s -X POST http://127.0.0.1:3001/api/enhanced-cookie/clear
```

Expected:

- Status reports `cookieConfigured: false`.
- Invalid Cookie save returns HTTP 400 and does not create `runtime/xhs-cookie.json`.
- Search/creator with no verified Cookie returns `needLogin: true` and never serves old cached results.
- Clear endpoint succeeds and leaves Cookie unconfigured.
- Browser UI shows the enhanced-mode dialog from the top-right button.
- Keyword search and creator search open the dialog when enhanced mode is not ready.
- Normal link parsing remains available.
