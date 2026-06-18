# Celery Jobs (`tasks.py`)

Reference: `modules/integrations/onelaw/backend/tasks.py` (2,779 lines — over the 500-line cap; the next integration must split helpers into `services/<partner>_import_runner.py`).

## Responsibility

- Define Celery `@shared_task` entries (thin wrappers).
- Implement async helper(s) that do the actual work.
- Use `JobEngine` (NOT custom `import_jobs` collection) for state.
- Use `JobProgressService` for real-time progress over Redis pub/sub.
- Use `JobCancellationService` for cancellation flag.
- Implement rollback markers (`old_docs` + `rollback_marker`) for partial failure cleanup.
- Cap concurrency per job with `asyncio.Semaphore`.
- Frequent cancellation checks.

## Skeleton

```python
import asyncio
import gc
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from celery import shared_task
from motor.motor_asyncio import AsyncIOMotorClient

from app.integrations.core.jobs.cancellation import JobCancellationService
from app.integrations.core.jobs.engine import JobEngine
from app.integrations.core.jobs.models import JobError, JobStatus
from app.integrations.core.jobs.progress import JobProgressService
from app.integrations.utils.document_service import DocumentService
from app.mongodb import get_motor_db
from app.redis_async import get_async_redis
from app.settings import settings

from modules.integrations.<partner>.backend.services.<partner>_service import (
    <Partner>Service,
)
from modules.integrations.<partner>.backend.services.sync_event_logger import (
    PipelineTracker, log_sync_event,
)

logger = logging.getLogger(__name__)

CONCURRENCY = 4  # asyncio.Semaphore — OneLaw default
PROGRESS_BATCH_SIZE = 5  # publish progress every N completed docs


# ---------- Task entries ----------

@shared_task(
    name="<partner>.import_documents",
    bind=True,
    max_retries=5,
    default_retry_delay=3,
    autoretry_for=(),  # do NOT autoretry — manual retry inside on transient errors
)
def process_<partner>_import_job(self, job_id: str):
    try:
        asyncio.run(_process_import_job_async(job_id))
    except Exception as exc:
        # Mark failed in JobEngine so FE sees terminal state.
        try:
            asyncio.run(JobEngine.fail_job(job_id, JobError(code="UNCAUGHT", message=str(exc)[:500])))
        finally:
            raise


@shared_task(name="<partner>.export_documents")
def process_<partner>_export_job(job_id: str):
    asyncio.run(_process_export_job_async(job_id))


# ---------- Async runners ----------

async def _process_import_job_async(job_id: str):
    redis = await get_async_redis()
    db = await get_motor_db()
    job = await JobEngine.get_job(job_id)
    if not job:
        logger.error("[<PARTNER>_TASK] job not found: %s", job_id)
        return

    user_email = job["user_email"]
    request = job.get("metadata", {}).get("request", {})
    source = request.get("source", "user_initiated")

    if await _is_cancelled(job_id, redis):
        await JobEngine.update_status(job_id, JobStatus.CANCELLED)
        return

    await JobEngine.update_status(job_id, JobStatus.PROCESSING)

    service = <Partner>Service(db=db)
    try:
        client = await service.get_client(user_email)
        if not client:
            raise RuntimeError("User not connected to <partner>")

        # 1. Build flat list of items to import (matters + client_files).
        items = await _collect_import_items(client, request, db, user_email)

        # 2. Mark existing docs with rollback marker so failures roll back.
        await _mark_rollback_candidates(db, user_email, items, job_id)

        # 3. Process with bounded concurrency.
        semaphore = asyncio.Semaphore(CONCURRENCY)
        documents_status: Dict[str, Dict[str, Any]] = {i["document_id"]: {"status": "pending", "name": i.get("document_name")} for i in items}

        async def _worker(item: Dict[str, Any]):
            async with semaphore:
                if await _is_cancelled(job_id, redis):
                    raise _Cancelled()
                await _process_one_document(item, service, client, db, user_email, job_id, documents_status, source)

        # Process in slices to publish progress periodically.
        for i in range(0, len(items), PROGRESS_BATCH_SIZE):
            slice_ = items[i:i + PROGRESS_BATCH_SIZE]
            results = await asyncio.gather(*[_worker(it) for it in slice_], return_exceptions=True)
            for r in results:
                if isinstance(r, _Cancelled):
                    raise r
                if isinstance(r, Exception):
                    logger.exception("[<PARTNER>_TASK] worker error: %s", r)
            await _publish_progress(redis, job_id, documents_status)
            gc.collect()

        # 4. Clear rollback markers; success.
        await _clear_rollback_markers(db, user_email, job_id, success=True)
        await JobEngine.complete_job(job_id, metadata={"summary": _summarise(documents_status)})
    except _Cancelled:
        await _clear_rollback_markers(db, user_email, job_id, success=False)
        await JobEngine.update_status(job_id, JobStatus.CANCELLED)
        await _publish_progress(redis, job_id, documents_status, status_override="cancelled")
    except Exception as exc:
        logger.exception("[<PARTNER>_TASK] job %s failed", job_id)
        await _clear_rollback_markers(db, user_email, job_id, success=False)
        await JobEngine.fail_job(job_id, JobError(code="JOB_FAILED", message=str(exc)[:500]))
        await _publish_progress(redis, job_id, documents_status, status_override="failed", error=str(exc)[:200])
    finally:
        await service.cleanup()


async def _process_one_document(
    item: Dict[str, Any],
    service: "<Partner>Service",
    client: "<Partner>Client",
    db,
    user_email: str,
    job_id: str,
    documents_status: Dict[str, Dict[str, Any]],
    source: str,
):
    doc_id = item["document_id"]
    documents_status[doc_id]["status"] = "downloading"
    tracker = PipelineTracker()
    tracker.add_step("started", detail={"item": item})

    try:
        # 1. Fetch metadata.
        metadata = await client.get_document(item.get("matter_id", "-"), doc_id)
        if not metadata:
            raise RuntimeError("Document not found in <partner>")
        tracker.add_step("metadata_resolved", detail={"size": metadata.get("size")})

        # 2. Smart-sync skip checks (see sync-state.md for full logic).
        existing = await db.documents.find_one(
            {"ownerId": user_email, "integration": "<partner>", "<partner>_doc_id": doc_id}
        )
        skip_reason = _decide_smart_sync(existing, metadata, source)
        if skip_reason:
            documents_status[doc_id]["status"] = "skipped"
            tracker.add_step("smart_sync_skip", detail={"reason": skip_reason})
            await log_sync_event(
                db, user_email, document_id=existing["_id"] if existing else None,
                sp_doc_id=doc_id, action="skipped", smart_sync_reason=skip_reason,
                source=source, job_id=job_id, metadata=tracker.to_dict(),
            )
            return

        # 3. Download via proxy URL.
        proxy_url = await service.get_proxy_document_url(user_email, doc_id)
        document_service = DocumentService()
        sfdt_url = await document_service.download_docx(
            proxy_url, user_email, item.get("folder_id"), metadata.get("extension"),
        )
        tracker.add_step("downloaded")

        # 4. Persist (upsert).
        update = {
            "$set": {
                "ownerId": user_email,
                "integration": "<partner>",
                "<partner>_doc_id": doc_id,
                "title": _build_title(metadata),
                "fileName": metadata.get("file_name"),
                "extension": metadata.get("extension"),
                "mimeType": metadata.get("mime_type"),
                "size": metadata.get("size"),
                "folderId": item.get("folder_id"),
                "matterId": item.get("matter_id"),
                "<partner>_modified_at": metadata.get("modified"),
                "sync_status": "complete",
                "url": sfdt_url,
                "updatedAt": datetime.utcnow(),
            },
            "$setOnInsert": {"createdAt": datetime.utcnow()},
            "$unset": {"old_docs": "", "rollback_marker": ""},
        }
        await db.documents.update_one(
            {"ownerId": user_email, "integration": "<partner>", "<partner>_doc_id": doc_id},
            update,
            upsert=True,
        )
        tracker.add_step("persisted")

        documents_status[doc_id]["status"] = "imported"
        await log_sync_event(
            db, user_email, sp_doc_id=doc_id, action="imported",
            source=source, job_id=job_id, metadata=tracker.to_dict(),
        )
    except Exception as exc:
        documents_status[doc_id]["status"] = "failed"
        documents_status[doc_id]["error"] = str(exc)[:200]
        tracker.add_step("error", status="failed", detail={"error": str(exc)[:200]})
        await log_sync_event(
            db, user_email, sp_doc_id=doc_id, action="failed",
            error=str(exc)[:500], source=source, job_id=job_id,
            metadata=tracker.to_dict(),
        )
        # Do NOT raise — one doc failure does not fail the job.


# ---------- Helpers ----------

class _Cancelled(Exception):
    pass


async def _is_cancelled(job_id: str, redis) -> bool:
    return await JobCancellationService.is_cancelled(job_id, redis)


async def _collect_import_items(
    client: "<Partner>Client",
    request: Dict[str, Any],
    db,
    user_email: str,
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    # Direct client files.
    for f in request.get("client_files", []):
        items.append({"document_id": f["document_id"], "document_name": f.get("document_name"), "client_id": request.get("client_id")})
    # Per-matter.
    for matter in request.get("matters", []):
        if matter.get("import_all"):
            payload = await client.list_matter_documents(matter["matter_id"])
            for d in payload.get("items", []):
                items.append({
                    "document_id": d["id"],
                    "document_name": d.get("name"),
                    "matter_id": matter["matter_id"],
                    "folder_id": d.get("parent_folder_id"),
                })
        else:
            for it in matter.get("items", []):
                items.append({
                    "document_id": it["document_id"],
                    "document_name": it.get("document_name"),
                    "matter_id": matter["matter_id"],
                })
    return items


async def _mark_rollback_candidates(db, user_email: str, items: List[Dict[str, Any]], job_id: str) -> None:
    """Mark existing docs as old_docs so we can roll back if cancelled/failed."""
    doc_ids = [i["document_id"] for i in items]
    if not doc_ids:
        return
    await db.documents.update_many(
        {
            "ownerId": user_email,
            "integration": "<partner>",
            "<partner>_doc_id": {"$in": doc_ids},
        },
        {"$set": {"old_docs": True, "rollback_marker": job_id}},
    )


async def _clear_rollback_markers(db, user_email: str, job_id: str, success: bool) -> None:
    if success:
        # Successful import: unset markers; old_docs already unset on each upsert.
        await db.documents.update_many(
            {"ownerId": user_email, "integration": "<partner>", "rollback_marker": job_id},
            {"$unset": {"old_docs": "", "rollback_marker": ""}},
        )
    else:
        # Rollback: leave existing docs visible by removing old_docs and rollback_marker.
        await db.documents.update_many(
            {"ownerId": user_email, "integration": "<partner>", "rollback_marker": job_id},
            {"$unset": {"old_docs": "", "rollback_marker": ""}},
        )


async def _publish_progress(redis, job_id: str, documents_status: Dict[str, Dict[str, Any]], *, status_override=None, error=None):
    summary = _summarise(documents_status)
    payload = {
        "job_id": job_id,
        "status": status_override or "processing",
        "summary": summary,
        "documents": list(documents_status.values()),
    }
    if error:
        payload["error"] = error
    await JobProgressService.publish_progress(job_id, payload, redis_client=redis)


def _summarise(documents_status: Dict[str, Dict[str, Any]]) -> Dict[str, int]:
    counts = {"total": len(documents_status), "completed": 0, "failed": 0, "skipped": 0, "pending": 0}
    for d in documents_status.values():
        s = d.get("status")
        if s == "imported":
            counts["completed"] += 1
        elif s == "failed":
            counts["failed"] += 1
        elif s == "skipped":
            counts["skipped"] += 1
        else:
            counts["pending"] += 1
    return counts


def _build_title(metadata: Dict[str, Any]) -> str:
    number = metadata.get("number")
    name = metadata.get("name") or metadata.get("file_name")
    return f"{number} - {name}" if number else name


def _decide_smart_sync(existing: Optional[Dict[str, Any]], metadata: Dict[str, Any], source: str) -> Optional[str]:
    """Return None to import, or a string reason to skip. See sync-state.md."""
    if not existing:
        return None
    partner_modified = metadata.get("modified")
    stored_modified = existing.get("<partner>_modified_at")
    if not partner_modified:
        if existing.get("ready_to_sync"):
            return None
        return "no_remote_timestamp_local_clean"
    if stored_modified and partner_modified <= stored_modified:
        return "remote_unchanged"
    return None
```

## Cleanup Beat Task

Register this in Celery beat to clean up stuck imports (worker crash leaves rollback markers + locks behind).

```python
@shared_task(name="<partner>.cleanup_stuck_imports")
def cleanup_stuck_<partner>_imports():
    asyncio.run(_cleanup_stuck_async())


async def _cleanup_stuck_async():
    from datetime import timedelta
    db = await get_motor_db()
    cutoff = datetime.utcnow() - timedelta(hours=2)
    cursor = db.integration_jobs.find({
        "provider": "<partner>",
        "status": JobStatus.PROCESSING.value,
        "updated_at": {"$lt": cutoff},
    })
    async for job in cursor:
        job_id = job["job_id"]
        logger.warning("[<PARTNER>_CLEANUP] rolling back stuck job=%s", job_id)
        await db.documents.update_many(
            {"rollback_marker": job_id},
            {"$unset": {"old_docs": "", "rollback_marker": ""}},
        )
        await JobEngine.fail_job(job_id, JobError(code="STUCK", message="Job exceeded 2h TTL; rolled back"))
```

Add to Celery beat schedule:
```python
"<partner>-cleanup-stuck-imports": {
    "task": "<partner>.cleanup_stuck_imports",
    "schedule": crontab(minute=0, hour="*"),  # hourly
},
```

## Concurrency Notes

- `asyncio.Semaphore(CONCURRENCY=4)` — OneLaw default. Increase only if partner can handle it; respect rate limits.
- Per-document failures are caught; the job continues. Only `_Cancelled` exits early.
- `gc.collect()` after each batch frees document content from memory (large PDFs leak otherwise).

## Cancellation Pattern

- Cancellation signal: Redis key set by `JobCancellationService.cancel_job(job_id)`.
- Worker checks via `_is_cancelled(job_id, redis)` at the top of every batch + every `_worker` invocation.
- On detection: raise `_Cancelled`, the outer `except` block runs rollback + status update + final progress publish.
- Lock release happens in the `finally` of the worker — never in the cancel HTTP handler. This prevents a new import from starting while the old worker is still rolling back.

## File Size Discipline

OneLaw's `tasks.py` is 2,779 lines because the import logic, smart-sync, folder mirroring, category sync, and proxy logic are all inline. NEW integrations must split:

```
tasks.py                             # < 200 lines: task entries + thin async wrappers
services/<partner>_import_runner.py  # _process_import_job_async + helpers
services/<partner>_export_runner.py  # _process_export_job_async + helpers
services/<partner>_sync_runner.py    # smart-sync decisions, reverse sync (if applicable)
```

## Settings

`autoretry_for=()` is intentional — Celery autoretry recreates the task with fresh state, breaking progress + dedup. Manual retry inside the runner where appropriate.
