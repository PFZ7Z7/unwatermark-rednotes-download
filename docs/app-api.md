# App API: Xiaohongshu note resources

This document is for the mobile app agent/client. The server parses a Xiaohongshu note URL and returns ordered media links plus text metadata. PDF generation should happen in the mobile app; the server only provides structured resources.

## Base URL

Production:

```text
https://xhs.pfz7z7.cn
```

Local development:

```text
http://localhost:3001
```

## Authentication

Every App API request must include a Bearer token:

```http
Authorization: Bearer <APP_API_TOKEN>
```

Keep the real token outside source code. On the server it is configured with `APP_API_TOKEN` in `.env`.

## Parse Note Resources

```http
POST /api/app/note-resources
Content-Type: application/json
Authorization: Bearer <APP_API_TOKEN>
```

Request body:

```json
{
  "url": "https://www.xiaohongshu.com/explore/xxxx",
  "proxy": true
}
```

Fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | Xiaohongshu note URL, short link, or shared text containing the URL. |
| `proxy` | boolean | no | Defaults to `true`. When true, returned `url` fields point to this service's `/api/proxy/image` or `/api/proxy/video`, which is easier for mobile clients to fetch. `sourceUrl` always keeps the original CDN URL. |

Success response:

```json
{
  "success": true,
  "data": {
    "noteId": "67xxxxxxxxxxxxxxxxxxxxxx",
    "type": "image",
    "noteUrl": "https://www.xiaohongshu.com/explore/67xxxxxxxxxxxxxxxxxxxxxx",
    "creatorUrl": "https://www.xiaohongshu.com/user/profile/...",
    "title": "Post title",
    "description": "Post body text",
    "text": {
      "title": "Post title",
      "description": "Post body text",
      "plain": "Post title\n\nPost body text"
    },
    "author": {
      "nickname": "Author name",
      "avatar": "https://...",
      "userId": "..."
    },
    "stats": {
      "likes": 0,
      "collects": 0,
      "comments": 0,
      "shares": 0
    },
    "publishTime": 1710000000000,
    "ipLocation": "Shanghai",
    "tags": [],
    "parseMode": "anonymous",
    "hasWatermark": false,
    "links": {
      "proxy": true,
      "baseUrl": "https://xhs.pfz7z7.cn"
    },
    "images": [
      {
        "order": 0,
        "index": 0,
        "kind": "image",
        "url": "https://xhs.pfz7z7.cn/api/proxy/image?url=...",
        "sourceUrl": "https://sns-img-....xhscdn.com/..."
      }
    ],
    "videos": [
      {
        "order": 1,
        "index": 0,
        "kind": "video",
        "url": "https://xhs.pfz7z7.cn/api/proxy/video?url=...",
        "sourceUrl": "https://sns-video-....xhscdn.com/...",
        "fallbackUrls": ["https://xhs.pfz7z7.cn/api/proxy/video?url=..."],
        "fallbackSourceUrls": ["https://sns-video-....xhscdn.com/..."],
        "duration": 12
      }
    ],
    "assets": [
      {
        "order": 0,
        "index": 0,
        "kind": "image",
        "url": "https://xhs.pfz7z7.cn/api/proxy/image?url=...",
        "sourceUrl": "https://sns-img-....xhscdn.com/..."
      }
    ]
  }
}
```

Media arrays:

| Field | Description |
| --- | --- |
| `images` | Image resources in display order. Use this array for image plus text PDF snapshots. |
| `videos` | Video resources. Use `fallbackUrls` if the primary video URL fails. |
| `assets` | Mixed ordered list of image/video resources. Sort by `order` if needed. |
| `url` | Client-ready URL. Usually a proxied URL when `proxy=true`. |
| `sourceUrl` | Original Xiaohongshu/CDN URL for diagnostics or custom download logic. |
| `kind` | One of `image`, `video`, `live_photo_image`, `live_photo_video`. |

Error responses:

```json
{ "success": false, "message": "App API token is missing or invalid" }
```

Common status codes:

| Status | Meaning |
| --- | --- |
| `200` | Parsed successfully. |
| `400` | Missing or invalid `url`. |
| `401` | Missing or invalid Bearer token. |
| `503` | Server has not configured `APP_API_TOKEN`. |
| `500` | Parse failed or upstream service error. |

## cURL Example

```bash
curl -X POST "https://xhs.pfz7z7.cn/api/app/note-resources" \
  -H "Authorization: Bearer <APP_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.xiaohongshu.com/explore/xxxx","proxy":true}'
```

## Mobile Client Guidance

For an image plus text PDF snapshot:

1. Call `POST /api/app/note-resources` with `proxy=true`.
2. Render `data.text.title`, `data.text.description`, author metadata, and each `data.images[*].url` in order.
3. Download images from `url`; keep `sourceUrl` only for debugging.
4. Store `data.noteUrl`, `data.noteId`, and `data.publishTime` as archive metadata.
5. Do not require the server to generate the PDF.

For video-aware archive screens:

1. Display images from `data.images`.
2. Display video cards from `data.videos`.
3. If `videos[*].url` fails, retry `videos[*].fallbackUrls` in order.
