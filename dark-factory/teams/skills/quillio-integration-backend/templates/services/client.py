"""Async httpx wrapper for the <partner> API.

Drop into: modules/integrations/<partner>/backend/services/<partner>_client.py
"""
import asyncio
import logging
import random
import uuid
from email.utils import parsedate_to_datetime
from datetime import datetime
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
    HARD_PAGE_CAP = 50_000
    MAX_RETRIES = 3
    RATE_LIMIT_MAX_RETRIES = 30
    RATE_LIMIT_MAX_SLEEP = 120.0

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
                        limits=httpx.Limits(
                            max_connections=20,
                            max_keepalive_connections=10,
                        ),
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

    # ----------------------- Core request -----------------------

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
                    logger.error(
                        "[<PARTNER>_CLIENT] %s %s exhausted retries: %s",
                        method,
                        url,
                        exc,
                    )
                    raise
                wait = self._backoff_seconds(retry_attempts)
                retry_attempts += 1
                logger.warning(
                    "[<PARTNER>_CLIENT] %s %s network error, retry in %.1fs",
                    method,
                    url,
                    wait,
                )
                await asyncio.sleep(wait)
                continue

            if response.status_code == 401:
                raise AuthFailedError(f"AUTH_FAILED: {method} {url}")

            if response.status_code == 404:
                if raise_on_404:
                    raise NotFoundError(f"NOT_FOUND: {method} {url}")
                return None

            if response.status_code == 429:
                if rate_limit_attempts >= self.RATE_LIMIT_MAX_RETRIES:
                    raise RateLimitError(f"RATE_LIMIT exhausted: {method} {url}")
                wait = self._parse_retry_after(response, rate_limit_attempts)
                rate_limit_attempts += 1
                logger.warning(
                    "[<PARTNER>_CLIENT] 429 sleep=%.1fs attempt=%d",
                    wait,
                    rate_limit_attempts,
                )
                await asyncio.sleep(wait)
                continue

            if 500 <= response.status_code < 600:
                if retry_attempts >= self.MAX_RETRIES:
                    logger.error(
                        "[<PARTNER>_CLIENT] %s %s status=%d body=%s",
                        method,
                        url,
                        response.status_code,
                        response.text[:500],
                    )
                    response.raise_for_status()
                wait = self._backoff_seconds(retry_attempts)
                retry_attempts += 1
                logger.warning(
                    "[<PARTNER>_CLIENT] %d retry in %.1fs",
                    response.status_code,
                    wait,
                )
                await asyncio.sleep(wait)
                continue

            if response.status_code >= 400:
                logger.error(
                    "[<PARTNER>_CLIENT] %s %s status=%d body=%s",
                    method,
                    url,
                    response.status_code,
                    response.text[:500],
                )
                response.raise_for_status()

            if response.status_code == 204 or not response.content:
                return {}
            try:
                return response.json()
            except ValueError:
                return response.content

    def _build_headers(
        self,
        extra: Optional[Dict[str, str]],
        is_presigned: bool,
        url: str,
    ) -> Dict[str, str]:
        headers = {"Accept": "application/json"}
        looks_presigned = (
            is_presigned
            or "X-Amz-Signature" in url
            or "X-Amz-Security-Token" in url
        )
        if not looks_presigned:
            headers["Authorization"] = f"Bearer {self._access_token}"
            headers["Content-Type"] = "application/json"
        if extra:
            headers.update(extra)
        return headers

    def _parse_retry_after(
        self, response: httpx.Response, attempt: int
    ) -> float:
        ra = response.headers.get("Retry-After")
        if ra:
            try:
                seconds = float(ra)
                return min(seconds, self.RATE_LIMIT_MAX_SLEEP)
            except ValueError:
                try:
                    dt = parsedate_to_datetime(ra)
                    delta = (dt - datetime.now(dt.tzinfo)).total_seconds()
                    return max(0, min(delta, self.RATE_LIMIT_MAX_SLEEP))
                except Exception:
                    pass
        backoff = min(2 ** attempt, self.RATE_LIMIT_MAX_SLEEP)
        return backoff + random.uniform(0, min(backoff * 0.2, 2.0))

    def _backoff_seconds(self, attempt: int) -> float:
        base = min(2 ** attempt, 30)
        return base + random.uniform(0, min(base * 0.2, 2.0))

    async def _paginate(
        self,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        page_size: int = DEFAULT_PAGE_SIZE,
        items_key: str = "items",
        total_key: Optional[str] = "total",
    ) -> List[Dict[str, Any]]:
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
                logger.warning(
                    "[<PARTNER>_CLIENT] %s pagination capped at %d",
                    path,
                    self.HARD_PAGE_CAP,
                )
                break
            if total_key and isinstance(page, dict):
                total = page.get(total_key)
                if total is not None and len(results) >= int(total):
                    break
            if len(items) < page_size:
                break
            offset += page_size
        return results

    # ----------------------- Public endpoints -----------------------
    # TODO(quillio:<partner>): replace these stubs with the partner's actual
    # endpoint paths and shapes per the API docs.

    async def list_clients(
        self,
        search: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
    ):
        params: Dict[str, Any] = {
            "offset": (page - 1) * page_size,
            "limit": page_size,
        }
        if search:
            params["q"] = search
        return await self._request("GET", "/clients", params=params)

    async def get_client(self, client_id: str):
        return await self._request(
            "GET", f"/clients/{client_id}", raise_on_404=False
        )

    async def list_matters(
        self,
        client_id: Optional[str] = None,
        search: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
    ):
        params: Dict[str, Any] = {
            "offset": (page - 1) * page_size,
            "limit": page_size,
        }
        if client_id:
            params["client_id"] = client_id
        if search:
            params["q"] = search
        return await self._request("GET", "/matters", params=params)

    async def get_matter(self, matter_id: str):
        return await self._request(
            "GET", f"/matters/{matter_id}", raise_on_404=False
        )

    async def list_matter_documents(self, matter_id: str, **kwargs):
        return await self._request(
            "GET", f"/matters/{matter_id}/documents", params=kwargs
        )

    async def get_document(self, matter_id: str, document_id: str):
        return await self._request(
            "GET",
            f"/matters/{matter_id}/documents/{document_id}",
            raise_on_404=False,
        )

    async def get_folder(self, folder_id: str):
        return await self._request(
            "GET", f"/folders/{folder_id}", raise_on_404=False
        )

    async def download_document(self, content_url: str) -> bytes:
        return await self._request(
            "GET", content_url, is_presigned_url=True
        )

    async def get_upload_ticket(self) -> Dict[str, Any]:
        return await self._request(
            "POST",
            "/uploads",
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )

    async def upload_file_content(
        self, upload_url: str, content: bytes, filename: str
    ):
        client = await self._get_client()
        files = {"file": (filename, content)}
        response = await client.put(upload_url, files=files)
        response.raise_for_status()
        return response.json() if response.content else {}

    async def create_document_record(
        self,
        matter_id: str,
        upload_id: str,
        metadata: Dict[str, Any],
    ):
        return await self._request(
            "POST",
            f"/matters/{matter_id}/documents",
            json_body={"upload_id": upload_id, **metadata},
        )
