# Admin Cookie Authentication Development Plan

## Background

The deployed `xhs.pfz7z7.cn` site works for public parsing/download flows, but the public "扫码登录" flow fails because the backend tries to start a GUI QR-code login task through MediaCrawler. This is not a good production user experience on a headless server.

The chosen design is an admin-maintained enhanced mode:

- Public users do not scan QR codes.
- Admin logs in to Xiaohongshu in a normal browser, copies the raw `Cookie` header, and submits it in `/admin`.
- Backend stores that cookie server-side and passes it to MediaCrawler requests with `login_type: "cookie"`.
- Public UI only shows whether enhanced mode is available or under maintenance.

No code should be pushed or deployed during this development pass.

## Branch And Safety Constraints

- Work branch: `codex/admin-cookie-auth`.
- Do not develop on `main` or `master`.
- Do not push any branch.
- Do not deploy to the Aliyun server.
- Do not store admin tokens in frontend persistent storage.
- Do not log or return the full Xiaohongshu cookie.
- Keep public anonymous parse/download behavior unchanged.

## Target User Experience

### Public User

- Header badge reflects enhanced mode availability:
  - available: "增强模式已可用"
  - unavailable: "增强模式维护中"
- No public QR-code login button.
- If a search/creator/detail fallback needs login and the admin cookie is missing/invalid, public users see a maintenance-style message, not terminal commands or internal MediaCrawler errors.
- Anonymous direct note parsing and downloads continue to work without admin cookie.

### Admin User

- Visits `/admin`.
- Enters admin token for the current page session.
- Pastes a raw Xiaohongshu `Cookie` header into a textarea.
- Can:
  - save cookie
  - clear cookie
  - stop current MediaCrawler task
  - refresh status
- Sees safe metadata only:
  - MediaCrawler running or not
  - cookie present or not
  - cookie format valid or not
  - updatedAt / validatedAt when available
  - public enhanced-mode status

## Backend Design

### Environment Variables

Add to `backend/.env.example`:

- `ADMIN_TOKEN=`
- `XHS_COOKIE_STORE_PATH=runtime/xhs-cookie.json`

### Cookie Store Module

Create `backend/src/services/adminCookieStore.ts`.

Responsibilities:

- Resolve cookie store path:
  - `process.env.XHS_COOKIE_STORE_PATH` if set.
  - otherwise `runtime/xhs-cookie.json` under backend process cwd.
- Validate raw Cookie input:
  - must be a string.
  - trim outer whitespace.
  - max length: `50_000`.
  - must include a non-empty `web_session=` cookie pair.
  - reject newline/control-character injection.
- Store server-side JSON:
  - `cookie`
  - `updatedAt`
  - optional `validatedAt`
  - `status`
- Write file with directory creation and mode `0600`.
- Read safe status without exposing cookie.
- Clear stored cookie by deleting the file if present.

Public return shape should never include raw cookie.

### Admin API Auth

Add middleware in `backend/src/index.ts`.

Authentication:

- Requires `ADMIN_TOKEN` environment variable.
- Accepts either:
  - `Authorization: Bearer <token>`
  - `X-Admin-Token: <token>`
- Compares tokens using `crypto.timingSafeEqual` when buffers have same length.

Responses:

- `503` if `ADMIN_TOKEN` is not configured.
- `401` for missing/invalid token.
- Never include the configured token in logs or responses.

### API Contract

Public:

- `GET /api/login-status`
  - return safe enhanced-mode state.
  - no cookie content.
  - no "扫码登录" hint.

Admin:

- `GET /api/admin/auth/status`
  - protected.
  - returns MediaCrawler status and safe cookie status.
- `POST /api/admin/auth/cookie`
  - protected.
  - body: `{ "cookie": "<raw Cookie header>" }`
  - validates and stores cookie.
- `POST /api/admin/auth/clear`
  - protected.
  - clears stored cookie.
- `POST /api/admin/crawler/stop`
  - protected.
  - calls `xhsService.stopCrawler()`.

Deprecated public auth endpoints:

- `POST /api/login`
  - no longer starts QR-code login.
  - return a clear disabled/deprecated response.
- `POST /api/logout`
  - no longer clears admin cookie publicly.
  - return a clear disabled/deprecated response.

### MediaCrawler Integration

Change `XiaohongshuService.assertLoginValid()` to:

- confirm MediaCrawler API is reachable.
- read the stored admin cookie.
- require valid cookie format.
- return the cookie string.

Pass returned cookie into MediaCrawler start payloads:

- detail fallback
- keyword search
- creator crawl

Payload addition:

```json
{
  "cookies": "<admin cookie>"
}
```

Keep:

- `login_type: "cookie"`
- `headless: true`

Update `LoginRequiredError` default messages to admin-maintained wording.

## Frontend Design

### Public App

Modify `frontend/src/App.tsx`:

- Extend `LoginStatus` with optional fields such as:
  - `mode`
  - `canSelfLogin`
  - `enhancedModeAvailable`
- Remove public QR login action.
- Convert "login required" error action into "查看增强模式状态".
- Login modal becomes a read-only enhanced-mode status modal.
- No public logout button.

### Admin Page

Create `frontend/src/AdminPage.tsx`.

Route selection:

- If `window.location.pathname === "/admin"`, render admin page.
- Otherwise render existing public app.

Admin page behavior:

- token input uses React state only.
- cookie textarea uses React state only.
- status can be refreshed on demand.
- buttons call protected admin endpoints.
- never save token to localStorage/sessionStorage.
- do not render full saved cookie because backend never returns it.

Update `frontend/src/App.css` with admin-specific styles that fit the current app.

## TDD And Verification Plan

### Backend Unit Tests First

Add `backend/src/services/adminCookieStore.test.ts` before implementation.

Expected tests:

1. rejects cookie without `web_session`.
2. stores valid cookie and returns safe metadata only.
3. reads stored cookie for internal service use.
4. clear removes stored cookie and reports missing status.
5. rejects oversized cookie.

Add backend test script:

```json
"test": "node --test -r ts-node/register \"src/**/*.test.ts\""
```

Run and confirm RED failure before production implementation.

### Backend Verification

After implementation:

- `cd backend && npm test`
- `cd backend && npm run build`
- local smoke:
  - `GET /api/health`
  - `GET /api/login-status`
  - protected admin endpoints reject without token
  - protected admin endpoints work with `ADMIN_TOKEN`

### Frontend Verification

- `cd frontend && npm run build`
- start local Vite dev server with backend API base.
- inspect public page and `/admin`.
- verify public page no longer exposes QR login.
- verify `/admin` can load and call backend status.

Implementation note:

- `@vitejs/plugin-react@5.2.0` uses TypeScript syntax that fails on `typescript~5.3.0`.
- Upgrade frontend TypeScript to `^5.9.3` if the build fails in `node_modules/@vitejs/plugin-react/dist/index.d.ts`.

## Local Test Runtime

Backend:

```bash
cd backend
PORT=3001 ADMIN_TOKEN=<your-admin-token> XHS_COOKIE_STORE_PATH=runtime/xhs-cookie.json npm run dev
```

Frontend:

```bash
cd frontend
VITE_API_URL=http://localhost:3001 npm run dev -- --host 127.0.0.1
```

Expected local URLs:

- Public app: `http://127.0.0.1:5173/`
- Admin app: `http://127.0.0.1:5173/admin`
- Backend health: `http://127.0.0.1:3001/api/health`

## Acceptance Criteria

- Technical document exists in `docs/superpowers/plans/`.
- Backend cookie store tests pass.
- Backend TypeScript build passes.
- Frontend TypeScript/Vite build passes.
- Local backend and frontend can start.
- Public UI has no QR-code login action.
- Admin UI can submit and clear cookie through protected endpoints.
- No push and no server deployment were performed.
