# Anti-Patterns — What Not To Do

Each item is a pattern observed in the legacy Smokeball / Actionstep / Clio integrations that caused bugs, on-call pages, or refactor pain. Do not repeat any of them.

## A1: Monolithic service class

**Seen in:**
- `backend-legal/app/services/smokeball.py` — 2,751 lines, 80+ methods.
- `backend-legal/app/services/actionstep.py` — 3,603 lines.
- `backend-legal/app/integrations/clio/api.py` — 2,654 lines (router + service mixed).

**Why it's bad:**
- Single PR touching one method blocks every other PR touching that file.
- Tests cannot be focused; mock setup is enormous.
- Cognitive load: nobody knows which 80 methods do what.

**Do instead:**
- One concern per file: `auth.py` for OAuth, `client.py` for HTTP, `service.py` for orchestration, `webhook.py` for webhook handling.
- File-size budget: hard 500 line cap. If you approach 400, split.

## A2: Lazy global service singleton

**Seen in** `backend-legal/app/api/smokeball.py:84-91`:

```python
_smokeball_service_instance = None

def get_smokeball_service_instance():
    global _smokeball_service_instance
    if _smokeball_service_instance is None:
        from app.services.smokeball import SmokeballService
        _smokeball_service_instance = SmokeballService(API_URL, API_KEY)
    return _smokeball_service_instance
```

**Why it's bad:**
- Mutable module state — race condition under concurrent first-call.
- Untestable — global cache survives test runs.
- Hides circular import problem instead of fixing it.

**Do instead:** Generator dependency `async def get_<partner>_service()` that yields a fresh service per request and cleans up in `finally`. OneLaw pattern.

## A3: Mixed auth secrets in one document

**Seen in** `backend-legal/app/tables.py SmokeBall`:

```python
class SmokeBall(Document):
    access_token = EncryptedStringField()
    refresh_token = EncryptedStringField()
    webhook_key = StringField(null=True)  # different lifecycle, different secret
```

**Why it's bad:**
- Three secrets with three lifecycles in one record. Saving one accidentally clobbers another.
- `webhook_key` nullable for backward compat → branch every read to handle both.
- Webhook re-registration logic ends up 170 lines spanning two methods.

**Do instead:** `integration_tokens` collection holds OAuth tokens. Webhook signing key lives on the same record but as an explicit, separately-updated field with its own setter. OneLaw pattern.

## A4: Cross-integration imports

**Seen in** `app/services/smokeball.py:168` and `app/smokeball_tasks.py:168`:

```python
from app.services.documents import DocumentsService
from app.integrations.utils.document_service import DocumentService
```

Plus in Smokeball deduping logic, references to Clio's pattern.

**Why it's bad:**
- Implicit contract creep: changes to `DocumentsService` break Smokeball, Actionstep, Clio simultaneously.
- Module isolation rule violated.

**Do instead:** Import `app.integrations.utils.document_service.DocumentService` (it's in the shared utils, that's allowed). Never import another integration's internals.

## A5: Fat webhook event processor

**Seen in** `app/services/smokeball.py:2292-2454` — single 162-line `async_process_smokeball_event` handling files, folders, deletions, updates.

**Why it's bad:**
- Cannot retry one event type without retrying the whole method.
- Adding a new event type requires editing the existing function.
- Failure modes are entangled.

**Do instead:** One handler per event type. `process_event` dispatches by type. OneLaw pattern (`_handle_document_event`, `_handle_document_status_change`, `_handle_document_moved`).

## A6: `asyncio.run()` inside Celery task

**Seen in** `app/smokeball_tasks.py:127-129`:

```python
@celery_app.task(bind=True)
def process_smokeball_import_job(self, job_id: str):
    asyncio.run(process_smokeball_import_with_progress(job_id, job))
```

**Why it's marginal:**
- Creates a new event loop per task. Fine for cold tasks; awful if task is invoked repeatedly in the same worker.
- If the worker is async-aware (gevent/eventlet pool), `asyncio.run` clashes.
- Hard to stream progress out to Redis from inside a fresh loop.

**Do instead:** OneLaw pattern — `tasks.py` entries are thin `@shared_task` wrappers that call into `_process_*_async` helpers. The async helper owns the loop and lifecycles. If running on asyncio worker, swap the wrapper to `async def` directly.

## A7: Hardcoded region in base URL

**Seen in** `app/services/actionstep.py:169`:

```python
BASE_URL = "https://ap-southeast-2.actionstep.com/api/rest"
```

The Actionstep OAuth response includes `api_endpoint` but it's never read.

**Why it's bad:**
- Customers in EU/US/etc. silently fail.
- Forces a code change to onboard a new region.

**Do instead:** Extract `api_endpoint` (or equivalent) from the OAuth response in `exchange_code_for_token`. Store in `integration_tokens.api_base_url`. Instantiate client with the stored URL.

## A8: Unbounded `while True` pagination

**Seen in** `app/services/smokeball.py:951-1007`:

```python
while True:
    response_data = await self.unified_api_call(...)
    if not response_data.get("value"):
        break
    all_matters.extend(response_data["value"])
    current_offset += 1
```

**Why it's bad:**
- Pathological partner response (always returning a value) loops forever.
- Loads everything into memory.

**Do instead:** Hard cap. Break after N rows (50,000 is a reasonable default for matters; 10,000 for folders). Log a warning when cap hit. OneLaw pattern.

## A9: Custom `import_jobs` MongoDB collection

**Seen in:** `app/clio_tasks.py`, `app/smokeball_tasks.py`, `app/actionstep_tasks.py` — each integration owns its own `import_jobs` collection schema.

**Why it's bad:**
- Three integrations, three job schemas. Job-list UI has to special-case each.
- Reinvented cancel/retry/progress for every integration.

**Do instead:** Use `app.integrations.core.jobs.engine.JobEngine` + `IntegrationJob` model. Single source of truth.

## A10: Webhook handled synchronously in the HTTP handler

**Seen in** parts of `app/api/smokeball.py` (event processing happens in the request thread before returning 200).

**Why it's bad:**
- Partner times out at 5–10s. Anything heavier (download, embedding) blows past that and the partner retries.
- The same event is processed multiple times.

**Do instead:** Verify signature → return 200 → dispatch to FastAPI `BackgroundTasks` or directly to a Celery task. OneLaw pattern. Webhook handler returns within milliseconds.

## A11: Pre-flight auth refresh under concurrency without a lock

**Seen as bug `INT-002` in `.techdebt/integrations.md`:**
> SharePoint: Token refresh race condition — Need mutex/lock.

**Why it's bad:**
- Two requests get 401 at the same time. Both try to refresh. One succeeds, one fails (refresh tokens are usually one-use). Now the user is disconnected.

**Do instead:** Distributed lock in Redis. Key = `<partner>:refresh_lock:{user_email}`. SET NX with 30s TTL. Loser waits for winner's result by polling Redis or checking the cached token. Actionstep does this in `app/services/actionstep.py:347-580`; OneLaw uses a simpler variant.

## A12: Building an integration without tests

**Coverage of all four legacy integrations:** essentially zero unit tests, zero integration tests.

**Why it's bad:**
- Every refactor is a guessing game.
- Production regressions ship undetected.
- New developer onboarding takes weeks because reading the code is the only documentation.

**Do instead:** Coverage > 70% per module. `quillio-integration-tests` skill enforces. No PR merges without tests.

## A13: Token leak via URL

**Seen in** older versions of document download endpoints — bearer tokens placed in query strings.

**Why it's bad:**
- URLs end up in CDN logs, browser history, server access logs, third-party analytics.
- Once leaked, replayable until refresh.

**Do instead:** Proxy-token pattern. Mint a 5-minute HS256 JWT bound to (user, document, purpose). Embed only that in the URL. Verify on the proxy endpoint. OneLaw `utils/proxy_token.py`.

## A14: Missing rollback on partial import

**Seen in** Smokeball (no cleanup task) and Clio (cleanup mentioned in TODO but unimplemented).

**Why it's bad:**
- Worker crashes mid-import. Documents marked `old_docs=True` are hidden from the user. They never come back.
- Dedup lock held forever. User cannot start a new import.

**Do instead:** `old_docs` + `rollback_marker` pattern (Actionstep does this well). Plus a Celery beat task `cleanup_stuck_<partner>_imports` that scans for jobs older than TTL and rolls back markers. JobEngine cancellation pattern handles the lock.

## A15: Webhook signing key rotation forgotten

**Seen in** Clio: when user re-authenticates, old webhooks are deleted but stored secrets are never rotated.

**Why it's bad:**
- Window where old leaked secret can still forge webhooks.

**Do instead:** Treat re-auth as "rotate everything." Delete old webhooks AND wipe stored signing key AND register fresh webhooks AND store the new key.

## Quick Self-Check Before PR

1. Open every file you wrote. Is it < 500 lines?
2. Search your diff for `global ` (with space). Should be zero matches.
3. Search for `from app.services.smokeball|actionstep` and `from app.integrations.clio`. Should be zero matches.
4. Search for hardcoded base URLs. Should be zero (read from settings or stored credentials).
5. Search for `while True:` and confirm each has a hard cap and a `break` on cap.
6. Search for `asyncio.run(` in Celery tasks — at most one per task entry, and only as the wrapper around an async helper.
7. Confirm webhook handler returns 200 BEFORE doing real work.
8. Confirm refresh path uses Redis lock.
9. Confirm tokens never appear in URLs.
10. Confirm test files exist for every service file.
