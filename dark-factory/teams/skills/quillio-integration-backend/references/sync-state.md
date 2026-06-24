# Sync State, Smart-Sync, Audit Trail

Reference: `modules/integrations/onelaw/backend/services/sync_event_logger.py` + tasks.py smart-sync logic.

## External ID Convention

Every imported document carries:

```python
{
    "ownerId": "user@example.com",         # tenant key
    "integration": "<partner>",
    "<partner>_doc_id": "external-id",     # primary external ID
    "sp_doc_id": "external-id",            # OneLaw-compatible alias for shared queries
}
```

The `sp_doc_id` alias is there because shared utilities (e.g., the legacy webhook handler in OneLaw) query against it. Keep both fields in sync; populate from the same source.

Folders carry:
```python
{
    "ownerId": "user@example.com",
    "integration": "<partner>",
    "type": "matter|client|sub",
    "action_id": "external-id",  # matter id, client id, or folder id depending on `type`
}
```

## Smart-Sync Decision Logic

When importing or processing a webhook update, decide whether to:
- **import** (download + persist),
- **skip** (no change), or
- **reverse-sync** (AILA newer, push back to partner).

```python
def decide_smart_sync(existing, partner_metadata, source) -> Optional[str]:
    """
    Return None to proceed with import.
    Return a string reason to skip.
    Set existing.ready_to_sync=True to trigger reverse sync (handled separately).
    """
    if not existing:
        return None  # New document — import.

    partner_modified = partner_metadata.get("modified")
    stored_modified = existing.get("<partner>_modified_at")
    aila_updated = existing.get("updatedAt")

    # Case 1: Partner provides no timestamp.
    if not partner_modified:
        if existing.get("ready_to_sync"):
            return None  # User wants to re-pull intentionally.
        return "no_remote_timestamp_local_clean"  # Protect local edits.

    # Case 2: Partner unchanged since last import.
    if stored_modified and partner_modified <= stored_modified:
        return "remote_unchanged"

    # Case 3: Echo of our own reverse sync (within 60s).
    last_pushed = existing.get("last_synced_to_<partner>_at")
    if last_pushed:
        delta = (partner_modified - last_pushed).total_seconds()
        if 0 <= delta <= 60:
            return "echo_of_reverse_sync"

    # Case 4: AILA newer than partner — reverse sync rather than import.
    if aila_updated and partner_modified and aila_updated > partner_modified and source != "user_initiated":
        # Mark for reverse sync; a separate task picks it up.
        # Actual update + return done by caller.
        existing["_should_reverse_sync"] = True
        return "aila_newer_reverse_sync_queued"

    # Otherwise import.
    return None
```

## Sync Status Field States

Document `sync_status` field transitions:

| State | Meaning |
|---|---|
| `pending` | Queued for sync but not started |
| `syncing` | Worker actively downloading/uploading |
| `complete` | Last sync succeeded |
| `failed` | Last sync raised an error |

Transitions handled in `tasks.py`. FE polls via `/sync-status` for `pending`/`syncing`.

## `ready_to_sync` Flag

Boolean on document. Set by the FE when user explicitly requests a re-pull or a push. Smart-sync respects it:
- If `ready_to_sync=True`, skip the "protect local edits" guard.
- After successful sync, unset the flag.

## Reverse Sync (only if bidirectional)

Path: AILA edit → user clicks "Sync to <Partner>" → `ready_to_sync=True` → Celery beat task `<partner>.push_pending_changes` picks up flagged docs → uploads → sets `last_synced_to_<partner>_at = now` and unsets `ready_to_sync`.

```python
@shared_task(name="<partner>.push_pending_changes")
def push_pending_changes_<partner>():
    asyncio.run(_push_pending_async())


async def _push_pending_async():
    db = await get_motor_db()
    cursor = db.documents.find({
        "integration": "<partner>",
        "ready_to_sync": True,
        "isTrashed": {"$ne": True},
    })
    async for doc in cursor:
        await _push_one_document(doc)
```

Beat schedule: every 5 min. Use a per-document lock to prevent double-push.

## Audit Trail (`<partner>_sync_events`)

Every meaningful sync action produces an event. UI uses this for the sync-history page.

```python
{
    "_id": ObjectId,
    "owner_id": "user@example.com",
    "folder_id": ObjectId | None,
    "document_id": ObjectId | None,
    "document_title": "Doc title",
    "sp_doc_id": "external-id",
    "direction": "import" | "export",
    "source": "bulk_import" | "webhook" | "user_initiated",
    "action": "imported" | "skipped" | "reverse_synced" | "failed",
    "smart_sync_reason": "remote_unchanged" | None,
    "error": "...string..." | None,
    "job_id": "job_id" | None,
    "file_size": 12345 | None,
    "metadata": {
        "processingSteps": [
            {"name": "metadata_resolved", "status": "success", "timestamp": "...", "durationMs": 150, "detail": {...}},
            ...
        ],
        "totalDurationMs": 5000,
    },
    "created_at": datetime,
}
```

Indexes:
```python
db.<partner>_sync_events.create_index([("folder_id", 1), ("owner_id", 1), ("created_at", -1)])
db.<partner>_sync_events.create_index([("owner_id", 1), ("created_at", -1)])
db.<partner>_sync_events.create_index([("sp_doc_id", 1)])
```

## `PipelineTracker`

In-memory step tracker, serialised into the audit event's `metadata.processingSteps`.

```python
import time
from typing import Any, Dict, List, Optional


class PipelineTracker:
    def __init__(self):
        self._steps: List[Dict[str, Any]] = []
        self._start = time.monotonic()

    def add_step(self, name: str, status: str = "success", detail: Optional[Dict[str, Any]] = None, duration_ms: Optional[float] = None):
        self._steps.append({
            "name": name,
            "status": status,
            "timestamp": datetime.utcnow().isoformat(),
            "detail": detail or {},
            "durationMs": duration_ms or (time.monotonic() - self._start) * 1000,
        })

    def to_dict(self) -> Dict[str, Any]:
        return {
            "processingSteps": self._steps,
            "totalDurationMs": (time.monotonic() - self._start) * 1000,
        }
```

## `log_sync_event` helper

```python
async def log_sync_event(
    db,
    owner_id: str,
    *,
    folder_id=None,
    document_id=None,
    document_title=None,
    sp_doc_id=None,
    direction="import",
    source="bulk_import",
    action="imported",
    smart_sync_reason=None,
    error=None,
    job_id=None,
    file_size=None,
    metadata=None,
) -> None:
    """Never raise — log and swallow."""
    try:
        await db.<partner>_sync_events.insert_one({
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
```

## Index Bootstrapping

Add an idempotent function that runs on app startup (or migration):

```python
async def ensure_<partner>_indexes(db) -> None:
    await db.<partner>_sync_events.create_index([("folder_id", 1), ("owner_id", 1), ("created_at", -1)])
    await db.<partner>_sync_events.create_index([("owner_id", 1), ("created_at", -1)])
    await db.<partner>_sync_events.create_index([("sp_doc_id", 1)])
    await db.documents.create_index([("ownerId", 1), ("integration", 1), ("<partner>_doc_id", 1)])
    await db.folders.create_index([("ownerId", 1), ("integration", 1), ("action_id", 1)])
    await db.integration_tokens.create_index([("owner_id", 1), ("provider", 1)], unique=True)
    await db.integration_tokens.create_index([("provider", 1), ("firm_cloud_id", 1)])
```

Call from `app/main.py` startup event or via Alembic migration.

## Multi-Tenant Isolation

EVERY query filters by `ownerId = user_email`. No exceptions.

```python
# CORRECT
db.documents.find({"ownerId": user_email, "integration": "<partner>"})

# WRONG — leaks across tenants
db.documents.find({"<partner>_doc_id": doc_id})
```

Code review must reject any query missing `ownerId`. The shared `documents` and `folders` collections hold every user's data; one missing filter = data leak.

## Sync Status Endpoint Wiring

Router exposes:
- `GET /sync-status` — current `pending` + `syncing` docs for user
- `GET /sync-history` — paginated audit events
- `GET /sync-history/{event_id}` — full event with `processingSteps`
- WebSocket `/ws/sync-status` — real-time updates via Redis pub/sub channel `<partner>_sync_status:{user_email}`

The WebSocket channel is published-to whenever sync status changes for a user (in `tasks.py`):

```python
await redis.publish(
    f"<partner>_sync_status:{user_email}",
    json.dumps({"document_id": str(doc_id), "status": "syncing"}),
)
```
