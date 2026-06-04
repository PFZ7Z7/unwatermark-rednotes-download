from typing import Any, Optional

import httpx
from fastapi import APIRouter, FastAPI, HTTPException
from pydantic import BaseModel, Field

from media_platform.xhs.playwright_sign import sign_with_xhshow


router = APIRouter()


class XhsCookieValidationRequest(BaseModel):
    cookie: str = Field(..., min_length=1, max_length=50000)


def _has_web_session(cookie: str) -> bool:
    for part in cookie.split(";"):
        name, sep, value = part.partition("=")
        if sep and name.strip() == "web_session" and value.strip():
            return True
    return False


PROFILE_CONTAINER_KEYS = {
    "account",
    "basicInfo",
    "basic_info",
    "info",
    "me",
    "profile",
    "self",
    "selfInfo",
    "self_info",
    "user",
    "userInfo",
    "user_info",
}
NICKNAME_KEYS = ("nickname", "nickName", "nick_name", "userName", "user_name", "displayName", "display_name")
AVATAR_KEYS = (
    "images",
    "avatar",
    "avatarUrl",
    "avatar_url",
    "image",
    "imageUrl",
    "image_url",
    "headImg",
    "head_img",
    "headUrl",
    "head_url",
)
USER_ID_KEYS = ("userId", "user_id", "userid", "redId", "red_id", "id")


def _string_value(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, dict):
        for key in ("url", "urlDefault", "url_default", "urlPre", "url_pre", "src", "image", "avatar"):
            found = _string_value(value.get(key))
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = _string_value(item)
            if found:
                return found
    return None


def _first_by_keys(mapping: dict[str, Any], keys: tuple[str, ...]) -> Optional[str]:
    for key in keys:
        found = _string_value(mapping.get(key))
        if found:
            return found
    return None


def _has_profile_hint(path: tuple[str, ...]) -> bool:
    return any(part in PROFILE_CONTAINER_KEYS for part in path)


def _account_candidate(mapping: dict[str, Any], path: tuple[str, ...]) -> Optional[tuple[int, dict[str, str]]]:
    nickname = _first_by_keys(mapping, NICKNAME_KEYS)
    avatar = _first_by_keys(mapping, AVATAR_KEYS)
    user_id = _first_by_keys(mapping, USER_ID_KEYS)
    profile_hint = _has_profile_hint(path)

    # Do not use generic "name" fields. They often contain UI labels such as "关注".
    if not nickname and not profile_hint:
        return None
    if not nickname and not avatar and not user_id:
        return None

    score = 0
    if nickname:
        score += 6
    if avatar:
        score += 3
    if user_id:
        score += 1
    if profile_hint:
        score += 2

    account = {
        key: value
        for key, value in {
            "nickname": nickname,
            "avatar": avatar,
            "userId": user_id,
        }.items()
        if value
    }
    return score, account


def _walk_account_candidates(obj: Any, path: tuple[str, ...] = (), depth: int = 0) -> list[tuple[int, dict[str, str]]]:
    if depth > 6:
        return []
    candidates: list[tuple[int, dict[str, str]]] = []
    if isinstance(obj, dict):
        candidate = _account_candidate(obj, path)
        if candidate:
            candidates.append(candidate)
        for key, value in obj.items():
            candidates.extend(_walk_account_candidates(value, (*path, key), depth + 1))
    elif isinstance(obj, list):
        for index, value in enumerate(obj[:20]):
            candidates.extend(_walk_account_candidates(value, (*path, f"[{index}]"), depth + 1))
    return candidates


def _extract_account(payload: dict[str, Any]) -> dict[str, str]:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    candidates = _walk_account_candidates(data, ("data",))
    if not candidates:
        return {}
    return max(candidates, key=lambda item: item[0])[1]


def _build_xhs_headers(cookie: str, uri: str) -> dict[str, str]:
    signs = sign_with_xhshow(uri=uri, data={}, cookie_str=cookie, method="GET")
    return {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Content-Type": "application/json;charset=UTF-8",
        "Cookie": cookie,
        "Origin": "https://www.xiaohongshu.com",
        "Referer": "https://www.xiaohongshu.com/",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "X-S": signs["x-s"],
        "X-T": signs["x-t"],
        "x-S-Common": signs["x-s-common"],
        "X-B3-Traceid": signs["x-b3-traceid"],
    }


async def _fetch_optional_account(client: httpx.AsyncClient, cookie: str) -> dict[str, str]:
    for uri in ("/api/sns/web/v2/user/me",):
        try:
            response = await client.get(
                "https://edith.xiaohongshu.com" + uri,
                headers=_build_xhs_headers(cookie, uri),
            )
            if response.status_code != 200:
                continue
            payload = response.json()
            if isinstance(payload, dict):
                account = _extract_account(payload)
                if account:
                    return account
        except Exception:
            continue
    return {}


@router.post("/api/xhs/validate-cookie")
async def validate_xhs_cookie(request: XhsCookieValidationRequest):
    cookie = request.cookie.strip()
    if not _has_web_session(cookie):
        raise HTTPException(status_code=400, detail="Cookie 缺少有效的 web_session")

    uri = "/api/sns/web/v1/user/selfinfo"
    try:
        headers = _build_xhs_headers(cookie, uri)
    except Exception:
        raise HTTPException(status_code=400, detail="Cookie 签名生成失败")

    try:
        client = httpx.AsyncClient(timeout=15.0, trust_env=False)
    except Exception:
        raise HTTPException(status_code=503, detail="Cookie 校验请求初始化失败")

    async with client:
        try:
            response = await client.get("https://edith.xiaohongshu.com" + uri, headers=headers)
        except httpx.HTTPError:
            raise HTTPException(status_code=503, detail="小红书账号校验请求失败")

        if response.status_code in (401, 403, 461, 471):
            raise HTTPException(status_code=400, detail="Cookie 已失效或触发风控校验")
        if response.status_code != 200:
            raise HTTPException(status_code=400, detail=f"Cookie 校验失败，状态码 {response.status_code}")

        try:
            payload = response.json()
        except ValueError:
            raise HTTPException(status_code=400, detail="Cookie 校验响应无法解析")
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Cookie 校验响应格式异常")

        result = payload.get("data", {}).get("result", {}) if isinstance(payload.get("data"), dict) else {}
        if not result.get("success"):
            message = result.get("message") or payload.get("msg") or "Cookie 已失效或无法访问当前账号"
            raise HTTPException(status_code=400, detail=message)

        account = _extract_account(payload)
        if not account.get("nickname") or not account.get("avatar"):
            fallback_account = await _fetch_optional_account(client, cookie)
            account = {**account, **fallback_account}

    return {
        "valid": True,
        "message": "Cookie 校验通过",
        "account": account,
    }


def install_xhs_cookie_validation(app: FastAPI) -> None:
    app.include_router(router)
