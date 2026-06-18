"""Celery tasks for <partner> imports and exports.

Drop into: modules/integrations/<partner>/backend/tasks.py
After copying, register Celery beat schedule for cleanup_stuck_<partner>_imports
in app/tasks.py.
"""
import asyncio
import gc
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from celery import shared_task

from app.integrations.core.jobs.cancellation import JobCancellationService
from app.integrations.core.jobs.engine import JobEngine
from app.integrations.core.jobs.models import JobError, JobStatus
from app.integrations.core.jobs.progress import JobProgressService
from app.mongodb import get_motor_db
from app.redis_async import get_async_redis

from modules.integrations.<partner>.backend.services.<partner>_service import (
    <Partner>Service,
)
from modules.integrations.<partner>.backend.services.sync_event_logger import (
    PipelineTracker,
    log_sync_event,
)

logger = logging.getLogger(__name__)

CONCURRENCY = 4
PROGRESS_BATCH_SIZE = 5
STUCK_JOB_TTL_HOURS = 2


# ---------- Task entries (thin wrappers) ----------

@shared_task(
    name="<partner>.import_documents",
    bind=True,
    max_retries=5,
    default_retry_delay=3,
    autoretry_for=(),
)
def process_<partner>_import_job(self, job_id: str):
    try:
        asyncio.run(_process_import_job_async(job_id))
    except Exception as exc:
        try:
            asyncio.run(
                JobEngine.fail_job(
                    job_id,
                    JobError(code="UNCAUGHT", message=str(exc)[:500]),
                )
            )
        finally:
            raise


@shared_task(name="<partner>.export_documents")
def process_<partner>_export_job(job_id: str):
    asyncio.run(_process_export_job_async(job_id))


@shared_task(name="<partner>.cleanup_stuck_imports")
def cleanup_stuck_<partner>_imports():
    asyncio.run(_cleanup_stuck_async())


# ---------- Async runners ----------

class _Cancelled(Exception):
    pass


async def _is_cancelled(job_id: str, redis) -> bool:
    return await JobCancellationService.is_cancelled(job_id, redis)


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
    documents_status: Dict[str, Dict[str, Any]] = {}
    try:
        client = await service.get_client(user_email)
        if not client:
            raise RuntimeError("User not connected to <partner>")

        items = await _collect_import_items(client, request)
        await _mark_rollback_candidates(db, user_email, items, job_id)

        documents_status = {
            i["document_id"]: {
                "documentId": i["document_id"],
                "name": i.get("document_name"),
                "status": "pending",
            }
            for i in items
        }

        semaphore = asyncio.Semaphore(CONCURRENCY)

        async def _worker(item: Dict[str, Any]):
            async with semaphore:
                if await _is_cancelled(job_id, redis):
                    raise _Cancelled()
                await _process_one_document(
                    item, service, client, db, user_email, job_id,
                    documents_status, source,
                )

        for i in range(0, len(items), PROGRESS_BATCH_SIZE):
            slice_ = items[i:i + PROGRESS_BATCH_SIZE]
            results = await asyncio.gather(
                *[_worker(it) for it in slice_],
                return_exceptions=True,
            )
            for r in results:
                if isinstance(r, _Cancelled):
                    raise r
                if isinstance(r, Exception):
                    logger.exception("[<PARTNER>_TASK] worker error: %s", r)
            await _publish_progress(redis, job_id, documents_status)
            gc.collect()

        await _clear_rollback_markers(db, user_email, job_id, success=True)
        await JobEngine.complete_job(
            job_id, metadata={"summary": _summarise(documents_status)}
        )
        await _publish_progress(
            redis, job_id, documents_status, status_override="completed"
        )
    except _Cancelled:
        await _clear_rollback_markers(db, user_email, job_id, success=False)
        await JobEngine.update_status(job_id, JobStatus.CANCELLED)
        await _publish_progress(
            redis, job_id, documents_status, status_override="cancelled"
        )
    except Exception as exc:
        logger.exception("[<PARTNER>_TASK] job %s failed", job_id)
        await _clear_rollback_markers(db, user_email, job_id, success=False)
        await JobEngine.fail_job(
            job_id, JobError(code="JOB_FAILED", message=str(exc)[:500])
        )
        await _publish_progress(
            redis, job_id, documents_status,
            status_override="failed", error=str(exc)[:200],
        )
    finally:
        await service.cleanup()


async def _process_export_job_async(job_id: str):
    # TODO(quillio:<partner>): mirror import job structure for exports.
    pass


async def _process_one_document(
    item: Dict[str, Any],
    service: "<Partner>Service",
    client,
    db,
    user_email: str,
    job_id: str,
    documents_status: Dict[str, Dict[str, Any]],
    source: str,
) -> None:
    doc_id = item["document_id"]
    documents_status[doc_id]["status"] = "downloading"
    tracker = PipelineTracker()
    tracker.add_step("started", detail={"item": item})

    try:
        metadata = await client.get_document(
            item.get("matter_id", "-"), doc_id
        )
        if not metadata:
            raise RuntimeError("Document not found in <partner>")
        tracker.add_step(
            "metadata_resolved", detail={"size": metadata.get("size")}
        )

        existing = await db.documents.find_one({
            "ownerId": user_email,
            "integration": "<partner>",
            "<partner>_doc_id": doc_id,
        })
        skip_reason = _decide_smart_sync(existing, metadata, source)
        if skip_reason:
            documents_status[doc_id]["status"] = "skipped"
            tracker.add_step(
                "smart_sync_skip", detail={"reason": skip_reason}
            )
            await log_sync_event(
                db, user_email,
                document_id=existing["_id"] if existing else None,
                sp_doc_id=doc_id,
                action="skipped",
                smart_sync_reason=skip_reason,
                source=source,
                job_id=job_id,
                metadata=tracker.to_dict(),
            )
            return

        proxy_url = await service.get_proxy_document_url(user_email, doc_id)
        from app.integrations.utils.document_service import DocumentService
        document_service = DocumentService()
        sfdt_url = await document_service.download_docx(
            proxy_url,
            user_email,
            item.get("folder_id"),
            metadata.get("extension"),
        )
        tracker.add_step("downloaded")

        update = {
            "$set": {
                "ownerId": user_email,
                "integration": "<partner>",
                "<partner>_doc_id": doc_id,
                "sp_doc_id": doc_id,
                "title": _build_title(metadata),
                "fileName": (
                    metadata.get("file_name") or metadata.get("fileName")
                ),
                "extension": metadata.get("extension"),
                "mimeType": (
                    metadata.get("mime_type") or metadata.get("mimeType")
                ),
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
            {
                "ownerId": user_email,
                "integration": "<partner>",
                "<partner>_doc_id": doc_id,
            },
            update,
            upsert=True,
        )
        tracker.add_step("persisted")

        documents_status[doc_id]["status"] = "imported"
        await log_sync_event(
            db, user_email,
            sp_doc_id=doc_id,
            action="imported",
            source=source,
            job_id=job_id,
            metadata=tracker.to_dict(),
        )
    except Exception as exc:
        documents_status[doc_id]["status"] = "failed"
        documents_status[doc_id]["error"] = str(exc)[:200]
        tracker.add_step(
            "error", status="failed", detail={"error": str(exc)[:200]}
        )
        await log_sync_event(
            db, user_email,
            sp_doc_id=doc_id,
            action="failed",
            error=str(exc)[:500],
            source=source,
            job_id=job_id,
            metadata=tracker.to_dict(),
        )


# ---------- Helpers ----------

async def _collect_import_items(
    client,
    request: Dict[str, Any],
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for f in request.get("client_files", []):
        items.append({
            "document_id": f["document_id"],
            "document_name": f.get("document_name"),
            "client_id": request.get("client_id"),
        })
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


async def _mark_rollback_candidates(
    db,
    user_email: str,
    items: List[Dict[str, Any]],
    job_id: str,
) -> None:
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


async def _clear_rollback_markers(
    db,
    user_email: str,
    job_id: str,
    success: bool,
) -> None:
    await db.documents.update_many(
        {
            "ownerId": user_email,
            "integration": "<partner>",
            "rollback_marker": job_id,
        },
        {"$unset": {"old_docs": "", "rollback_marker": ""}},
    )


async def _publish_progress(
    redis,
    job_id: str,
    documents_status: Dict[str, Dict[str, Any]],
    *,
    status_override: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    summary = _summarise(documents_status)
    payload = {
        "jobId": job_id,
        "status": status_override or "processing",
        "summary": summary,
        "documents": list(documents_status.values()),
    }
    if error:
        payload["error"] = error
    await JobProgressService.publish_progress(
        job_id, payload, redis_client=redis
    )


def _summarise(documents_status: Dict[str, Dict[str, Any]]) -> Dict[str, int]:
    counts = {
        "total": len(documents_status),
        "completed": 0,
        "failed": 0,
        "skipped": 0,
        "pending": 0,
    }
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
    name = (
        metadata.get("name")
        or metadata.get("file_name")
        or metadata.get("fileName")
    )
    return f"{number} - {name}" if number else name


def _decide_smart_sync(
    existing: Optional[Dict[str, Any]],
    metadata: Dict[str, Any],
    source: str,
) -> Optional[str]:
    """Return None to import, or a string reason to skip."""
    if not existing:
        return None
    partner_modified = metadata.get("modified")
    stored_modified = existing.get("<partner>_modified_at")
    aila_updated = existing.get("updatedAt")

    if not partner_modified:
        if existing.get("ready_to_sync"):
            return None
        return "no_remote_timestamp_local_clean"

    if stored_modified and partner_modified <= stored_modified:
        return "remote_unchanged"

    last_pushed = existing.get("last_synced_to_<partner>_at")
    if last_pushed and partner_modified:
        try:
            delta = (partner_modified - last_pushed).total_seconds()
            if 0 <= delta <= 60:
                return "echo_of_reverse_sync"
        except (TypeError, AttributeError):
            pass

    if (
        aila_updated
        and partner_modified
        and aila_updated > partner_modified
        and source != "user_initiated"
    ):
        return "aila_newer_reverse_sync_queued"

    return None


# ---------- Cleanup beat task ----------

async def _cleanup_stuck_async():
    db = await get_motor_db()
    cutoff = datetime.utcnow() - timedelta(hours=STUCK_JOB_TTL_HOURS)
    cursor = db.integration_jobs.find({
        "provider": "<partner>",
        "status": JobStatus.PROCESSING.value,
        "updated_at": {"$lt": cutoff},
    })
    async for job in cursor:
        job_id = job["job_id"]
        logger.warning(
            "[<PARTNER>_CLEANUP] rolling back stuck job=%s", job_id
        )
        await db.documents.update_many(
            {"rollback_marker": job_id},
            {"$unset": {"old_docs": "", "rollback_marker": ""}},
        )
        await JobEngine.fail_job(
            job_id,
            JobError(
                code="STUCK",
                message=(
                    f"Job exceeded {STUCK_JOB_TTL_HOURS}h TTL; rolled back"
                ),
            ),
        )
