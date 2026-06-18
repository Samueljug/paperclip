"""FastAPI router for the <partner> integration.

Drop into: modules/integrations/<partner>/backend/api/<partner>_router.py

After copying, search/replace `<partner>` (lowercase slug) and `<Partner>` (TitleCase).
Then fill every `# TODO(quillio:<partner>)` block.
"""
import asyncio
import json
import logging
import math
from typing import Any, Dict, Optional

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import RedirectResponse, StreamingResponse

from app.integrations.core.jobs.cancellation import JobCancellationService
from app.integrations.core.jobs.engine import JobEngine
from app.integrations.core.jobs.progress import JobProgressService
from app.mongodb import get_motor_db
from app.redis_async import get_async_redis
from app.services.auth import get_current_user, get_ws_current_user
from app.settings import settings
from app.tables import User
from app.utils.oauth_state import generate_oauth_state, validate_oauth_state

from modules.integrations.<partner>.backend.services.<partner>_service import (
    <Partner>Service,
)
from modules.integrations.<partner>.backend.services.<partner>_webhook import (
    <Partner>WebhookService,
)
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
        await service.authenticate(code, state)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception:
        logger.exception("[<PARTNER>_CALLBACK] failed")
        raise HTTPException(500, "Authentication failed")
    return RedirectResponse(
        f"{settings.base_url_user}?integration=<partner>&status=connected"
    )


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
    return await service.list_matters(
        user.email, client_id=client_id, search=search, page=page,
    )


@router.get("/matters/{matter_id}/tree")
async def get_matter_tree(
    matter_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(250, ge=1, le=1000),
    user: User = Depends(get_current_user),
    service: <Partner>Service = Depends(get_<partner>_service),
):
    return await service.get_document_tree(
        user.email, matter_id, page=page, page_size=page_size,
    )


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
async def sync_status(user: User = Depends(get_current_user)):
    db = await get_motor_db()
    cursor = db.documents.find(
        {
            "ownerId": user.email,
            "integration": "<partner>",
            "sync_status": {"$in": ["pending", "syncing"]},
        },
        {"_id": 1, "title": 1, "sync_status": 1, "sync_started_at": 1},
    )
    items = [
        {
            "id": str(d["_id"]),
            "title": d.get("title"),
            "status": d.get("sync_status"),
            "started_at": d.get("sync_started_at"),
        }
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
    db = await get_motor_db()
    query: Dict[str, Any] = {"owner_id": user.email}
    if folder_id:
        # TODO(quillio:<partner>): traverse descendant folder ids if needed
        query["folder_id"] = folder_id
    total = await db.<partner>_sync_events.count_documents(query)
    cursor = (
        db.<partner>_sync_events.find(query)
        .sort("created_at", -1)
        .skip((page - 1) * page_size)
        .limit(page_size)
    )
    items = [_serialize_sync_event(d) async for d in cursor]
    return {
        "items": items,
        "total": total,
        "page": page,
        "totalPages": math.ceil(total / page_size) if total else 0,
    }


@router.get("/sync-history/{event_id}")
async def get_sync_event(event_id: str, user: User = Depends(get_current_user)):
    from bson import ObjectId

    db = await get_motor_db()
    try:
        oid = ObjectId(event_id)
    except Exception:
        raise HTTPException(400, "Invalid event id")
    doc = await db.<partner>_sync_events.find_one({"_id": oid, "owner_id": user.email})
    if not doc:
        raise HTTPException(404, "Event not found")
    return _serialize_sync_event(doc)


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
async def get_job(job_id: str, user: User = Depends(get_current_user)):
    job = await JobEngine.get_job(job_id)
    if not job or job.get("user_email") != user.email:
        raise HTTPException(404, "Job not found")
    return job


@router.delete("/cancel-import/{job_id}")
async def cancel_import(job_id: str, user: User = Depends(get_current_user)):
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
            await websocket.send_json(
                {"type": "progress", "data": json.loads(message["data"])}
            )
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("[<PARTNER>_WS] error")
    finally:
        hb.cancel()
        await pubsub.unsubscribe(channel)
        await pubsub.close()


# ---------- Webhooks (skip section if partner has no webhooks) ----------

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
    return {
        "configured": bool(key),
        "preview": (key[:6] + "...") if key else None,
    }


@router.post("/webhook")
async def webhook(request: Request, background_tasks: BackgroundTasks):
    body = await request.body()
    headers = {k.lower(): v for k, v in request.headers.items()}
    webhook_service = <Partner>WebhookService()
    valid = await webhook_service.verify_signature(
        body, headers, firm_id=headers.get("x-firm-id"),
    )
    if not valid:
        return Response(status_code=200)  # acknowledge, do not leak validity
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
    # TODO(quillio:<partner>): adapt matter_id arg per partner API
    metadata = await client.get_document(matter_id="-", document_id=document_id)
    content_url = (metadata or {}).get("content_url") or (metadata or {}).get("contentUrl")
    if not metadata or not content_url:
        raise HTTPException(404, "Document not found")

    import httpx

    async def streamer():
        async with httpx.AsyncClient() as fresh:
            async with fresh.stream("GET", content_url) as resp:
                async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                    yield chunk

    return StreamingResponse(
        streamer(),
        media_type=metadata.get("mime_type") or metadata.get("mimeType") or "application/octet-stream",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{metadata.get("file_name") or metadata.get("fileName") or document_id}"'
            ),
        },
    )


# ---------- Helpers ----------

def _serialize_sync_event(d: Dict[str, Any]) -> Dict[str, Any]:
    """MongoDB snake_case → camelCase for FE."""
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
