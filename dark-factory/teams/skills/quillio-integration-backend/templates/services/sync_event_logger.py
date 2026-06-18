"""Audit-trail logger and PipelineTracker for <partner>.

Drop into: modules/integrations/<partner>/backend/services/sync_event_logger.py
"""
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

COLLECTION_NAME = "<partner>_sync_events"


class PipelineTracker:
    """Per-document step tracker. Serialised into the sync event metadata."""

    def __init__(self):
        self._steps: List[Dict[str, Any]] = []
        self._start = time.monotonic()

    def add_step(
        self,
        name: str,
        status: str = "success",
        detail: Optional[Dict[str, Any]] = None,
        duration_ms: Optional[float] = None,
    ) -> None:
        self._steps.append({
            "name": name,
            "status": status,
            "timestamp": datetime.utcnow().isoformat(),
            "detail": detail or {},
            "durationMs": duration_ms
            if duration_ms is not None
            else (time.monotonic() - self._start) * 1000,
        })

    def to_dict(self) -> Dict[str, Any]:
        return {
            "processingSteps": self._steps,
            "totalDurationMs": (time.monotonic() - self._start) * 1000,
        }


async def ensure_sync_event_indexes(db) -> None:
    """Idempotent. Call once at app startup."""
    await db[COLLECTION_NAME].create_index(
        [("folder_id", 1), ("owner_id", 1), ("created_at", -1)]
    )
    await db[COLLECTION_NAME].create_index(
        [("owner_id", 1), ("created_at", -1)]
    )
    await db[COLLECTION_NAME].create_index([("sp_doc_id", 1)])


async def log_sync_event(
    db,
    owner_id: str,
    *,
    folder_id=None,
    document_id=None,
    document_title: Optional[str] = None,
    sp_doc_id: Optional[str] = None,
    direction: str = "import",
    source: str = "bulk_import",
    action: str = "imported",
    smart_sync_reason: Optional[str] = None,
    error: Optional[str] = None,
    job_id: Optional[str] = None,
    file_size: Optional[int] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Never raise. Log and swallow."""
    try:
        await db[COLLECTION_NAME].insert_one({
            "owner_id": owner_id,
            "folder_id": folder_id,
            "document_id": document_id,
            "document_title": document_title,
            "sp_doc_id": sp_doc_id,
            "direction": direction,
            "source": source,
            "action": action,
            "smart_sync_reason": smart_sync_reason,
            "error": error,
            "job_id": job_id,
            "file_size": file_size,
            "metadata": metadata or {},
            "created_at": datetime.utcnow(),
        })
    except Exception:
        logger.exception("[<PARTNER>_SYNC_EVENT] failed to log event")
