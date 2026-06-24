# HTTP Client Layer (`<partner>_client.py`)

Reference: `modules/integrations/onelaw/backend/services/onelaw_client.py` (497 lines).

## Responsibility

Wrap the partner's HTTP API. One method per partner endpoint. Single chokepoint for retries, rate-limit, error mapping, pagination. No business logic — that lives in `service.py`.

## Skeleton

```python
import asyncio
import logging
import random
import uuid
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


class AuthFailedError(Exception):
    """Raised on 401. Caller decides whether to refresh."""


class NotFoundError(Exception):
    """Raised on 404 when raise_on_404=True."""


class RateLimitError(Exception):
    """Raised when retry budget exhausted on 429."""


class <Partner>Client:
    DEFAULT_PAGE_SIZE = 50
    HARD_PAGE_CAP = 50_000  # max rows fetched in one paginated call
    MAX_RETRIES = 3         # 5xx retries (429 retried separately up to 30)
    RATE_LIMIT_MAX_RETRIES = 30
    RATE_LIMIT_MAX_SLEEP = 120

    def __init__(
        self,
        base_url: str,
        access_token: str,
        timeout: float = 30.0,
    ):
        self._base_url = base_url.rstrip("/")
        self._access_token = access_token
        self._timeout = timeout
        self._client: Optional[httpx.AsyncClient] = None
        self._client_lock = asyncio.Lock()

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            async with self._client_lock:
                if self._client is None:
                    self._client = httpx.AsyncClient(
                        timeout=self._timeout,
                        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                    )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()

    # ----------------------- Core request method -----------------------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        raise_on_404: bool = True,
        is_presigned_url: bool = False,
    ) -> Optional[Any]:
        """Single chokepoint. Handles retries, rate-limit, error mapping."""
        client = await self._get_client()

        url = path if path.startswith("http") else f"{self._base_url}{path}"
        request_headers = self._build_headers(headers, is_presigned_url, url)

        rate_limit_attempts = 0
        retry_attempts = 0

        while True:
            try:
                response = await client.request(
                    method,
                    url,
                    params=params,
                    json=json_body if not is_presigned_url else None,
                    headers=request_headers,
                )
            except httpx.RequestError as exc:
                if retry_attempts >= self.MAX_RETRIES:
                    logger.error("[<PARTNER>_CLIENT] %s %s exhausted retries: %s", method, url, exc)
                    raise
                wait = self._backoff_seconds(retry_attempts)
                retry_attempts += 1
                logger.warning("[<PARTNER>_CLIENT] %s %s network error, retry in %.1fs", method, url, wait)
                await asyncio.sleep(wait)
                continue

            # 401 — auth failure; service decides whether to refresh.
            if response.status_code == 401:
                raise AuthFailedError(f"AUTH_FAILED: {method} {url}")

            # 404 — caller decides
            if response.status_code == 404:
                if raise_on_404:
                    raise NotFoundError(f"NOT_FOUND: {method} {url}")
                return None

            # 429 — rate limit
            if response.status_code == 429:
                if rate_limit_attempts >= self.RATE_LIMIT_MAX_RETRIES:
                    raise RateLimitError(f"RATE_LIMIT exhausted: {method} {url}")
                wait = self._parse_retry_after(response, rate_limit_attempts)
                rate_limit_attempts += 1
                logger.warning("[<PARTNER>_CLIENT] 429 sleep=%.1fs attempt=%d", wait, rate_limit_attempts)
                await asyncio.sleep(wait)
                continue

            # 5xx — retry with backoff
            if 500 <= response.status_code < 600:
                if retry_attempts >= self.MAX_RETRIES:
                    logger.error(
                        "[<PARTNER>_CLIENT] %s %s status=%d body=%s",
                        method, url, response.status_code, response.text[:500],
                    )
                    response.raise_for_status()
                wait = self._backoff_seconds(retry_attempts)
                retry_attempts += 1
                logger.warning("[<PARTNER>_CLIENT] %d retry in %.1fs", response.status_code, wait)
                await asyncio.sleep(wait)
                continue

            # 4xx other — surface error
            if response.status_code >= 400:
                logger.error(
                    "[<PARTNER>_CLIENT] %s %s status=%d body=%s",
                    method, url, response.status_code, response.text[:500],
                )
                response.raise_for_status()

            # Success
            if response.status_code == 204 or not response.content:
                return {}
            try:
                return response.json()
            except ValueError:
                return response.content  # binary download

    def _build_headers(self, extra: Optional[Dict[str, str]], is_presigned: bool, url: str) -> Dict[str, str]:
        headers = {"Accept": "application/json"}
        # Presigned URL detection: AWS S3 signs with X-Amz-* in query string. Auth header
        # would conflict with signature, so strip it.
        looks_presigned = is_presigned or "X-Amz-Signature" in url or "X-Amz-Security-Token" in url
        if not looks_presigned:
            headers["Authorization"] = f"Bearer {self._access_token}"
            headers["Content-Type"] = "application/json"
        if extra:
            headers.update(extra)
        return headers

    def _parse_retry_after(self, response: httpx.Response, attempt: int) -> float:
        ra = response.headers.get("Retry-After")
        if ra:
            try:
                seconds = float(ra)
                return min(seconds, self.RATE_LIMIT_MAX_SLEEP)
            except ValueError:
                # HTTP-date format
                try:
                    dt = parsedate_to_datetime(ra)
                    delta = (dt - datetime.now(dt.tzinfo)).total_seconds()
                    return max(0, min(delta, self.RATE_LIMIT_MAX_SLEEP))
                except Exception:
                    pass
        # No header; exponential backoff with jitter, capped.
        backoff = min(2 ** attempt, self.RATE_LIMIT_MAX_SLEEP)
        return backoff + random.uniform(0, min(backoff * 0.2, 2.0))

    def _backoff_seconds(self, attempt: int) -> float:
        base = min(2 ** attempt, 30)
        return base + random.uniform(0, min(base * 0.2, 2.0))

    # ----------------------- Pagination helper -----------------------

    async def _paginate(
        self,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        page_size: int = DEFAULT_PAGE_SIZE,
        items_key: str = "items",
        total_key: Optional[str] = "total",
    ) -> List[Dict[str, Any]]:
        """Offset/limit pagination with hard cap. Adapt for cursor/link patterns."""
        params = dict(params or {})
        results: List[Dict[str, Any]] = []
        offset = 0
        while True:
            params["offset"] = offset
            params["limit"] = page_size
            page = await self._request("GET", path, params=params)
            if not page:
                break
            items = page.get(items_key, []) if isinstance(page, dict) else page
            if not items:
                break
            results.extend(items)
            if len(results) >= self.HARD_PAGE_CAP:
                logger.warning("[<PARTNER>_CLIENT] %s pagination capped at %d", path, self.HARD_PAGE_CAP)
                break
            if total_key and isinstance(page, dict):
                total = page.get(total_key)
                if total is not None and len(results) >= int(total):
                    break
            if len(items) < page_size:
                break
            offset += page_size
        return results

    # ----------------------- Public endpoint methods -----------------------

    async def list_clients(self, search: Optional[str] = None, page: int = 1, page_size: int = 50):
        params: Dict[str, Any] = {"offset": (page - 1) * page_size, "limit": page_size}
        if search:
            params["q"] = search
        return await self._request("GET", "/clients", params=params)

    async def get_client(self, client_id: str):
        return await self._request("GET", f"/clients/{client_id}", raise_on_404=False)

    async def list_matters(self, client_id: Optional[str] = None, search=None, page=1, page_size=50):
        params: Dict[str, Any] = {"offset": (page - 1) * page_size, "limit": page_size}
        if client_id:
            params["client_id"] = client_id
        if search:
            params["q"] = search
        return await self._request("GET", "/matters", params=params)

    async def list_matter_documents(self, matter_id: str, **kwargs):
        return await self._request("GET", f"/matters/{matter_id}/documents", params=kwargs)

    async def get_document(self, matter_id: str, document_id: str):
        return await self._request("GET", f"/matters/{matter_id}/documents/{document_id}", raise_on_404=False)

    async def download_document(self, content_url: str) -> bytes:
        """Download document body. content_url is typically a presigned URL."""
        return await self._request("GET", content_url, is_presigned_url=True)

    async def get_upload_ticket(self) -> Dict[str, Any]:
        """POST with idempotency key for retry-safety."""
        return await self._request(
            "POST",
            "/uploads",
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )

    async def upload_file_content(self, upload_url: str, content: bytes, filename: str):
        """PUT to a presigned URL — multipart/form-data."""
        client = await self._get_client()
        files = {"file": (filename, content)}
        response = await client.put(upload_url, files=files)
        response.raise_for_status()
        return response.json() if response.content else {}

    async def create_document_record(self, matter_id: str, upload_id: str, metadata: Dict[str, Any]):
        return await self._request(
            "POST",
            f"/matters/{matter_id}/documents",
            json_body={"upload_id": upload_id, **metadata},
        )
```

## Pagination Variants

### Cursor-based

```python
async def _paginate_cursor(self, path, *, params=None, page_size=50, items_key="items", cursor_key="next_cursor"):
    params = dict(params or {})
    params["limit"] = page_size
    results = []
    cursor = None
    while True:
        if cursor:
            params["cursor"] = cursor
        page = await self._request("GET", path, params=params)
        items = page.get(items_key, [])
        results.extend(items)
        if len(results) >= self.HARD_PAGE_CAP:
            logger.warning("[<PARTNER>_CLIENT] %s cursor pagination capped", path)
            break
        cursor = page.get(cursor_key)
        if not cursor:
            break
    return results
```

### Link header (RFC 5988)

```python
async def _paginate_link(self, path, *, params=None, page_size=50):
    client = await self._get_client()
    url = f"{self._base_url}{path}"
    params = dict(params or {})
    params["per_page"] = page_size
    results = []
    while url:
        response = await client.get(url, params=params, headers=self._build_headers(None, False, url))
        if response.status_code == 401:
            raise AuthFailedError(f"AUTH_FAILED: GET {url}")
        response.raise_for_status()
        results.extend(response.json())
        if len(results) >= self.HARD_PAGE_CAP:
            break
        next_link = response.links.get("next", {}).get("url")
        url = next_link
        params = None  # next URL already has params encoded
    return results
```

## Error Mapping Cheat Sheet

| Partner status | Action |
|---|---|
| 200/201 with body | Return parsed JSON |
| 204 / empty body | Return `{}` |
| 401 | Raise `AuthFailedError` (service catches, calls auth refresh) |
| 403 | Raise as-is via `raise_for_status` (do not retry) |
| 404 | Raise `NotFoundError` if `raise_on_404=True`, else return `None` |
| 409 | Raise as-is (typically dedup conflict; service decides) |
| 422 | Raise as-is (validation error; service surfaces to user) |
| 429 | Sleep per `Retry-After` or backoff, retry up to 30 |
| 5xx | Backoff + retry up to 3 |
| Network error | Backoff + retry up to 3 |

## Idempotency

Always set `Idempotency-Key: uuid4()` on POSTs that create resources (uploads, document records, webhooks). Even if the partner doesn't honor it today, they might tomorrow, and it makes retries safe.

## Connection Pooling

One `httpx.AsyncClient` per `<Partner>Client` instance, with `max_connections=20`. The service layer creates a fresh client per user per request (via `get_client(user_email)`) and tracks them in `_active_clients` for cleanup. Routers must call `service.cleanup()` in their `finally` block — the dependency generator pattern enforces this.

## Logging

- `[<PARTNER>_CLIENT]` prefix
- Log retry attempts at WARNING with attempt count and reason
- Log final failures at ERROR with status + body (truncated to 500 chars)
- Log presigned-URL detections at DEBUG
- Never log full request bodies (might contain document content)

## Pitfalls Observed In Legacy Integrations

- Smokeball loops `while True` with no cap → use `HARD_PAGE_CAP`.
- Actionstep retries 30x with no max sleep → cap at `RATE_LIMIT_MAX_SLEEP`.
- Clio raises `Exception("RATE_LIMIT...")` without typed exception → use `RateLimitError`.
- Multiple integrations parse `Retry-After` only as int, not HTTP-date → handle both.
