# Router & Wiring (`<partner>_router.py` + main.py + tasks.py)

Reference: `modules/integrations/onelaw/backend/api/onelaw_router.py` (854 lines — on the edge of the 500-line cap, acceptable because it's mostly thin endpoint declarations).

## Responsibility

Expose HTTP endpoints. Inject the service. Translate exceptions to `HTTPException`. Stream WebSocket progress. Receive webhooks. Nothing else.

## Router Skeleton

```python
import asyncio
import logging
import math
from typing import Any, Dict, List, Optional

from fastapi import (
    APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect, status,
)
from fastapi.responses import RedirectResponse

from app.services.auth import get_current_user, get_ws_current_user
from app.integrations.core.jobs.engine import JobEngine
from app.integrations.core.jobs.progress import JobProgressService
from app.integrations.core.jobs.cancellation import JobCancellationService
from app.utils.oauth_state import generate_oauth_state, validate_oauth_state
from app.redis_async import get_async_redis
from app.settings import settings
from app.tables import User

from modules.integrations.<partner>.backend.services.<partner>_service import <Partner>Service
from modules.integrations.<partner>.backend.services.<partner>_webhook import <Partner>WebhookService
from modules.integrations.<partner>.backend.utils.proxy_token import verify_proxy_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/integrations/<partner>", tags=["<partner>"])


async def get_<partner>_service():
    service = <Partner>Service()
    try:
        yield service
    finally:
        await service.cleanup()


# ---------- Auth ----------

@router.get("/auth/login")
async def login(
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    redis = await get_async_redis()
    state = await generate_oauth_state(redis, user.email)
    url = await service.get_auth_url(state)
    return {"url": url}


@router.get("/auth/callback")
async def callback(
    code: str = Query(...),
    state: str = Query(...),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    try:
        result = await service.authenticate(code, state)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return RedirectResponse(f"{settings.base_url_user}?integration=<partner>&status=connected")


@router.post("/auth/logout")
async def logout(
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    await service.logout(user.email)
    return {"status": "disconnected"}


# ---------- Browse ----------

@router.get("/clients")
async def list_clients(
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    return await service.list_clients(user.email, search=search, page=page)


@router.get("/matters")
async def list_matters(
    client_id: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    return await service.list_matters(user.email, client_id=client_id, search=search, page=page)


@router.get("/matters/{matter_id}/tree")
async def get_matter_tree(
    matter_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(250, ge=1, le=1000),
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    return await service.get_document_tree(user.email, matter_id, page=page, page_size=page_size)


@router.get("/search")
async def unified_search(
    q: str = Query(..., min_length=1),
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    return await service.unified_search(user.email, q)


# ---------- Recent / MRU ----------

@router.get("/recent/clients")
async def recent_clients(
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    return await service.get_recent_clients(user.email)


@router.get("/recent/matters")
async def recent_matters(
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    return await service.get_recent_matters(user.email)


# ---------- Sync history ----------

@router.get("/sync-status")
async def sync_status(
    user: User = Depends(get_current_user),
):
    from app.mongodb import get_motor_db
    db = await get_motor_db()
    cursor = db.documents.find(
        {"ownerId": user.email, "integration": "<partner>", "sync_status": {"$in": ["pending", "syncing"]}},
        {"_id": 1, "title": 1, "sync_status": 1, "sync_started_at": 1},
    )
    items = [
        {"id": str(d["_id"]), "title": d.get("title"), "status": d.get("sync_status"), "started_at": d.get("sync_started_at")}
        async for d in cursor
    ]
    return {"items": items}


@router.get("/sync-history")
async def sync_history(
    folder_id: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
):
    from app.mongodb import get_motor_db
    db = await get_motor_db()
    query: Dict[str, Any] = {"owner_id": user.email}
    if folder_id:
        # TODO(quillio:<partner>): traverse descendant folder ids if needed
        query["folder_id"] = folder_id
    total = await db.<partner>_sync_events.count_documents(query)
    cursor = db.<partner>_sync_events.find(query).sort("created_at", -1).skip((page - 1) * page_size).limit(page_size)
    items = [_serialize_sync_event(d) async for d in cursor]
    return {"items": items, "total": total, "page": page, "total_pages": math.ceil(total / page_size)}


# ---------- Jobs ----------

@router.post("/import", status_code=status.HTTP_202_ACCEPTED)
async def import_documents(
    payload: Dict[str, Any],
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    return await service.import_documents(user.email, payload)


@router.post("/export", status_code=status.HTTP_202_ACCEPTED)
async def export_documents(
    payload: Dict[str, Any],
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    return await service.export_documents(user.email, payload)


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    user: User = Depends(get_current_user),
):
    job = await JobEngine.get_job(job_id)
    if not job or job.get("user_email") != user.email:
        raise HTTPException(404, "Job not found")
    return job


@router.delete("/cancel-import/{job_id}")
async def cancel_import(
    job_id: str,
    user: User = Depends(get_current_user),
):
    job = await JobEngine.get_job(job_id)
    if not job or job.get("user_email") != user.email:
        raise HTTPException(404, "Job not found")
    if job.get("status") in ("completed", "failed", "cancelled"):
        raise HTTPException(409, "Job is already in a terminal state.")
    await JobCancellationService.cancel_job(job_id)
    return {"job_id": job_id, "status": "cancelling"}


# ---------- WebSocket ----------

@router.websocket("/ws/import-status/{job_id}")
async def ws_import_status(websocket: WebSocket, job_id: str, token: str = Query(...)):
    user = await get_ws_current_user(token)
    if not user:
        await websocket.close(code=4001)
        return
    job = await JobEngine.get_job(job_id)
    if not job or job.get("user_email") != user.email:
        await websocket.close(code=4004)
        return

    await websocket.accept()
    redis = await get_async_redis()
    pubsub = redis.pubsub()
    channel = JobProgressService.get_channel_name(job_id)
    await pubsub.subscribe(channel)

    # Send current snapshot first.
    await websocket.send_json({"type": "snapshot", "job": job})

    async def heartbeat():
        while True:
            try:
                await asyncio.sleep(25)
                await websocket.send_json({"type": "ping"})
            except Exception:
                return

    hb = asyncio.create_task(heartbeat())
    try:
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            await websocket.send_json({"type": "progress", "data": json.loads(message["data"])})
    except WebSocketDisconnect:
        pass
    finally:
        hb.cancel()
        await pubsub.unsubscribe(channel)
        await pubsub.close()


# ---------- Webhooks (skip whole section if partner has no webhooks) ----------

@router.put("/webhook-key")
async def save_webhook_key(
    body: Dict[str, str],
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    key = body.get("key")
    if not key:
        raise HTTPException(400, "key required")
    await service._auth.save_webhook_signing_key(user.email, key)
    return {"status": "saved"}


@router.get("/webhook-key")
async def get_webhook_key(
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    key = await service._auth.get_webhook_signing_key(user.email)
    return {"configured": bool(key), "preview": (key[:6] + "...") if key else None}


@router.post("/webhook")
async def webhook(
    request: Request,
    background_tasks: BackgroundTasks,
):
    body = await request.body()
    headers = dict(request.headers)
    webhook_service = <Partner>WebhookService()
    valid = await webhook_service.verify_signature(body, headers, firm_id=headers.get("x-firm-id"))
    if not valid:
        return Response(status_code=200)  # acknowledge but ignore (do not leak validity)
    try:
        event = json.loads(body)
    except json.JSONDecodeError:
        return Response(status_code=200)
    background_tasks.add_task(webhook_service.process_event, event)
    return Response(status_code=200)


# ---------- Proxy download (skip if no download proxy needed) ----------

@router.get("/proxy/document/{user_email}/{document_id}")
async def proxy_document(
    user_email: str,
    document_id: str,
    token: str = Query(...),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    if not verify_proxy_token(token, user_email, document_id):
        raise HTTPException(403, "Invalid or expired proxy token")
    client = await service.get_client(user_email)
    if not client:
        raise HTTPException(401, "<Partner> not connected")
    metadata = await client.get_document(matter_id="-", document_id=document_id)  # adapt per partner
    content_url = metadata.get("contentUrl") if metadata else None
    if not content_url:
        raise HTTPException(404, "Document not found")
    content = await client.download_document(content_url)
    return Response(
        content=content,
        media_type=metadata.get("mimeType", "application/octet-stream"),
        headers={"Content-Disposition": f'attachment; filename="{metadata.get("fileName", document_id)}"'},
    )


# ---------- Helpers ----------

def _serialize_sync_event(d: Dict[str, Any]) -> Dict[str, Any]:
    """Convert MongoDB snake_case to camelCase for FE."""
    return {
        "id": str(d["_id"]),
        "ownerId": d.get("owner_id"),
        "documentId": str(d["document_id"]) if d.get("document_id") else None,
        "documentTitle": d.get("document_title"),
        "spDocId": d.get("sp_doc_id"),
        "direction": d.get("direction"),
        "source": d.get("source"),
        "action": d.get("action"),
        "smartSyncReason": d.get("smart_sync_reason"),
        "error": d.get("error"),
        "jobId": d.get("job_id"),
        "metadata": d.get("metadata", {}),
        "createdAt": d.get("created_at"),
    }
```

## Wiring

`backend-legal/app/main.py`:

```python
from modules.integrations.<partner>.backend.api.<partner>_router import (
    router as <partner>_router,
)

app.include_router(<partner>_router)
```

`backend-legal/app/tasks.py`:

```python
# Celery picks up tasks via this import — do not remove `# noqa: F401`.
from modules.integrations.<partner>.backend.tasks import (  # noqa: F401
    process_<partner>_import_job,
    process_<partner>_export_job,
)
```

That's the entire wiring. No plugin registry, no service container. Imports are wiring.

## WebSocket Auth Quirk

FastAPI does NOT call `Depends(get_current_user)` on WebSocket connections — the dependency expects an HTTP request. Use the query-param token pattern:

- Client opens `wss://.../ws/import-status/{job_id}?token=<jwt>`
- Server reads `token: str = Query(...)`
- Manually call `get_ws_current_user(token)` (helper in `app.services.auth`)
- On invalid/missing token, `websocket.close(code=4001)` and return

Close codes 4xxx are application-defined; reserve 4001 for missing/invalid token, 4004 for unauthorized job access.

## Webhook Endpoint Discipline

- Verify signature first. If invalid, return 200 (don't reveal validity).
- Parse body. If malformed, return 200 (partner shouldn't retry).
- Dispatch to `BackgroundTasks` or Celery — never process inline.
- Return 200 within milliseconds.

## Dependency Injection Pattern

`get_<partner>_service` is an async generator. FastAPI calls `next` then `cleanup` on exit. The `try/finally` guarantees `service.cleanup()` runs even if the route raises. Do NOT replace this with a module-level singleton — that's the Smokeball anti-pattern (A2).

## Error Response Shape

| Status | Use |
|---|---|
| 202 | Async job accepted (`/import`, `/export`) |
| 400 | Invalid request (missing param, bad payload, invalid OAuth state) |
| 401 | User's integration disconnected (refresh failed) |
| 403 | Permission denied (wrong user accessing job, invalid proxy token) |
| 404 | Resource not found (job, document, matter) |
| 409 | Conflict (job already terminal, import already in progress) |
| 500 | Unhandled exception (logged with stack trace) |

Never leak partner internals or stack traces to the client. Generic message + Sentry breadcrumb.
