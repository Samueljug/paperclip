# Proxy Tokens (`utils/proxy_token.py`)

Reference: `modules/integrations/onelaw/backend/utils/proxy_token.py` (35 lines).

**SKIP THIS DOC if your integration doesn't need a download proxy.**

## When You Need This

Third-party services that fetch documents from your backend cannot inject custom Authorization headers. Examples:
- Syncfusion document editor (renders DOCX in browser; opens URL via `<iframe src>`)
- ConvertAPI (downloads source file from a URL you provide)
- Browser `<a href="...">` direct download

Without a proxy token, you'd embed the partner's bearer token in the URL, which leaks via:
- CDN access logs
- Browser history
- Server access logs
- Third-party analytics
- Referer headers

The proxy-token pattern fixes that: mint a short-lived JWT bound to (user, document, purpose), embed only that in the URL, verify on the proxy endpoint, then perform the actual download with the partner's bearer token server-side.

## OneLaw Pattern (chosen as best practice)

HS256 JWT, 5-minute TTL, claims `{sub, doc, exp, purpose}`. Verified against `settings.authjwt_secret_key`.

```python
import jwt
from datetime import datetime, timedelta
from typing import Optional

from app.settings import settings


PROXY_TOKEN_TTL_SECONDS = 300  # 5 minutes
PROXY_TOKEN_PURPOSE = "<partner>_proxy"


def create_proxy_token(user_email: str, document_id: str) -> str:
    payload = {
        "sub": user_email,
        "doc": document_id,
        "exp": datetime.utcnow() + timedelta(seconds=PROXY_TOKEN_TTL_SECONDS),
        "purpose": PROXY_TOKEN_PURPOSE,
    }
    return jwt.encode(payload, settings.authjwt_secret_key, algorithm="HS256")


def verify_proxy_token(token: str, user_email: str, document_id: str) -> bool:
    try:
        payload = jwt.decode(
            token,
            settings.authjwt_secret_key,
            algorithms=["HS256"],
            options={"require": ["exp", "sub", "doc", "purpose"]},
        )
    except jwt.ExpiredSignatureError:
        return False
    except jwt.InvalidTokenError:
        return False

    if payload.get("purpose") != PROXY_TOKEN_PURPOSE:
        return False
    if payload.get("sub") != user_email:
        return False
    if payload.get("doc") != document_id:
        return False
    return True
```

## Why HS256 (Not RS256)

- HS256 uses the existing `authjwt_secret_key` already in settings — no new key management.
- Tokens never leave AILA; both mint and verify happen on the same backend process.
- Verification is faster (symmetric).
- RS256 buys you nothing here because the only consumers are your own endpoints.

## Why Not Opaque Token + Redis (Clio Pattern)

Clio mints a 32-char URL-safe random token, stores `{access_token, document_id}` JSON in Redis, looks it up on the proxy request. That works but:

- Requires Redis lookup on every download (extra latency).
- If Redis is compromised, attacker can extract bearer tokens.
- Storing the partner bearer token in Redis is a much bigger blast radius than a signed claim.
- TTL enforcement requires a separate Redis SET — easy to forget.

JWT signed claim is stateless and simpler. Use it.

## URL Shape

```
GET {settings.base_url_backend}/integrations/<partner>/proxy/document/{user_email}/{document_id}?token=<jwt>
```

Why include `user_email` and `document_id` in the path AND in the JWT claims:
- Path is what the third-party service sees; lets them deal with the URL pattern.
- Claims are what we verify; ensures the URL hasn't been tampered with.
- Mismatch → 403.

## Proxy Endpoint Implementation

See `references/router-wiring.md` (`/proxy/document/{user_email}/{document_id}` endpoint) for the full handler. Key steps:

1. Verify token (path matches claims, signature valid, not expired).
2. Get authenticated `<Partner>Client` for `user_email` (uses stored credentials).
3. Fetch document metadata to get the partner's `content_url`.
4. Stream the bytes back with appropriate `Content-Disposition`.

Stream the response — do not load the full file into memory:

```python
@router.get("/proxy/document/{user_email}/{document_id}")
async def proxy_document(user_email, document_id, token, service):
    if not verify_proxy_token(token, user_email, document_id):
        raise HTTPException(403, "Invalid or expired proxy token")
    client = await service.get_client(user_email)
    if not client:
        raise HTTPException(401, "Not connected")
    metadata = await client.get_document(matter_id="-", document_id=document_id)
    if not metadata or not metadata.get("content_url"):
        raise HTTPException(404, "Not found")

    async def streamer():
        async with httpx.AsyncClient() as fresh:
            async with fresh.stream("GET", metadata["content_url"]) as resp:
                async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                    yield chunk

    return StreamingResponse(
        streamer(),
        media_type=metadata.get("mime_type", "application/octet-stream"),
        headers={"Content-Disposition": f'attachment; filename="{metadata.get("file_name", document_id)}"'},
    )
```

## Token Replay Risk

5-minute TTL means a stolen token is replayable for up to 5 minutes. Trade-off:
- Shorter TTL (e.g., 60s) is more secure but breaks slow-downloading clients.
- Longer TTL (e.g., 1h) is too generous.

5 minutes mirrors what Syncfusion and ConvertAPI need. Don't change without a reason.

## What Doesn't Go in URLs

Anything sensitive. Specifically:
- Partner bearer tokens
- Refresh tokens
- Webhook signing keys
- User session tokens
- Internal IDs that imply structure (use UUIDs in URLs, internal numeric IDs in DB)

## Auditing

Log every proxy access at INFO level:

```python
logger.info(
    "[<PARTNER>_PROXY] download user=%s doc=%s size=%s",
    user_email, document_id, metadata.get("size"),
)
```

Sentry breadcrumb on token verification failure (403).

## Testing

```python
def test_create_and_verify_proxy_token_round_trip():
    token = create_proxy_token("user@example.com", "doc-123")
    assert verify_proxy_token(token, "user@example.com", "doc-123") is True

def test_verify_rejects_wrong_user():
    token = create_proxy_token("user@example.com", "doc-123")
    assert verify_proxy_token(token, "other@example.com", "doc-123") is False

def test_verify_rejects_wrong_doc():
    token = create_proxy_token("user@example.com", "doc-123")
    assert verify_proxy_token(token, "user@example.com", "doc-456") is False

def test_verify_rejects_expired(monkeypatch):
    token = create_proxy_token("user@example.com", "doc-123")
    # Fast-forward time 6 minutes.
    monkeypatch.setattr("time.time", lambda: time.time() + 360)
    assert verify_proxy_token(token, "user@example.com", "doc-123") is False
```
