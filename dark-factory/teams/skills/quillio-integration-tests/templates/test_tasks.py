"""Unit tests for <partner> Celery tasks.

Drop into: backend-legal/tests/unit/integrations/<partner>/test_<partner>_tasks.py
"""
import asyncio
from datetime import datetime, timedelta

import pytest


@pytest.mark.asyncio
async def test_smart_sync_skips_remote_unchanged(
    mock_<partner>_settings, mock_db, mock_redis, respx_mock,
    seed_credentials, monkeypatch,
):
    from modules.integrations.<partner>.backend.tasks import (
        _process_import_job_async,
    )
    from app.integrations.core.jobs.engine import JobEngine
    from app.integrations.core.jobs.models import (
        IntegrationJob, JobStatus, JobType,
    )

    stored_modified = datetime(2026, 1, 1)
    await mock_db.documents.insert_one({
        "ownerId": "user@example.com", "integration": "<partner>",
        "<partner>_doc_id": "d-1",
        "<partner>_modified_at": stored_modified,
    })
    respx_mock.get(
        "https://api.partner.example.com/matters/m-1/documents/d-1"
    ).respond(
        200,
        json={"id": "d-1", "name": "Doc", "modified": stored_modified.isoformat()},
    )

    download_calls = []

    async def fake_download(self, *a, **kw):
        download_calls.append(a)
        return ""

    monkeypatch.setattr(
        "app.integrations.utils.document_service."
        "DocumentService.download_docx",
        fake_download,
    )

    job_id = "<partner>_import_skip"
    await JobEngine.create_job(IntegrationJob(
        job_id=job_id,
        user_email="user@example.com",
        provider="<partner>",
        job_type=JobType.IMPORT,
        status=JobStatus.QUEUED,
        metadata={"request": {
            "matters": [
                {
                    "matter_id": "m-1",
                    "items": [{"document_id": "d-1"}],
                }
            ],
            "source": "user_initiated",
        }},
    ))

    await _process_import_job_async(job_id)

    assert download_calls == []
    event = await mock_db.<partner>_sync_events.find_one(
        {"sp_doc_id": "d-1"}
    )
    assert event["action"] == "skipped"
    assert event["smart_sync_reason"] == "remote_unchanged"


@pytest.mark.asyncio
async def test_cancellation_stops_job(
    mock_<partner>_settings, mock_db, mock_redis, seed_credentials,
):
    from modules.integrations.<partner>.backend.tasks import (
        _process_import_job_async,
    )
    from app.integrations.core.jobs.engine import JobEngine
    from app.integrations.core.jobs.cancellation import JobCancellationService
    from app.integrations.core.jobs.models import (
        IntegrationJob, JobStatus, JobType,
    )

    job_id = "<partner>_import_cancel"
    await JobEngine.create_job(IntegrationJob(
        job_id=job_id,
        user_email="user@example.com",
        provider="<partner>",
        job_type=JobType.IMPORT,
        status=JobStatus.QUEUED,
        metadata={"request": {}},
    ))
    await JobCancellationService.cancel_job(job_id)
    await _process_import_job_async(job_id)
    final = await JobEngine.get_job(job_id)
    assert final["status"] == JobStatus.CANCELLED.value


@pytest.mark.asyncio
async def test_one_doc_failure_does_not_fail_job(
    mock_<partner>_settings, mock_db, mock_redis, respx_mock,
    seed_credentials, monkeypatch,
):
    from modules.integrations.<partner>.backend.tasks import (
        _process_import_job_async,
    )
    from app.integrations.core.jobs.engine import JobEngine
    from app.integrations.core.jobs.models import (
        IntegrationJob, JobStatus, JobType,
    )

    respx_mock.get(
        "https://api.partner.example.com/matters/m-1/documents/d-good"
    ).respond(
        200,
        json={"id": "d-good", "name": "Good.pdf", "modified": "2026-01-01T00:00:00Z"},
    )
    respx_mock.get(
        "https://api.partner.example.com/matters/m-1/documents/d-bad"
    ).respond(500, text="oops")

    async def fake_download(self, *a, **kw):
        return "https://aila-s3/x"

    monkeypatch.setattr(
        "app.integrations.utils.document_service."
        "DocumentService.download_docx",
        fake_download,
    )

    job_id = "<partner>_import_partial"
    await JobEngine.create_job(IntegrationJob(
        job_id=job_id,
        user_email="user@example.com",
        provider="<partner>",
        job_type=JobType.IMPORT,
        status=JobStatus.QUEUED,
        metadata={"request": {
            "matters": [{
                "matter_id": "m-1",
                "items": [
                    {"document_id": "d-good"},
                    {"document_id": "d-bad"},
                ],
            }],
            "source": "user_initiated",
        }},
    ))

    await _process_import_job_async(job_id)
    final = await JobEngine.get_job(job_id)
    assert final["status"] == JobStatus.COMPLETED.value
    good = await mock_db.documents.find_one({"<partner>_doc_id": "d-good"})
    bad_event = await mock_db.<partner>_sync_events.find_one({
        "sp_doc_id": "d-bad", "action": "failed",
    })
    assert good is not None
    assert bad_event is not None


@pytest.mark.asyncio
async def test_cleanup_stuck_imports_rolls_back(mock_db, mock_redis):
    from bson import ObjectId
    from modules.integrations.<partner>.backend.tasks import (
        _cleanup_stuck_async,
    )
    from app.integrations.core.jobs.engine import JobEngine

    await mock_db.integration_jobs.insert_one({
        "job_id": "stuck-1", "provider": "<partner>",
        "status": "processing", "user_email": "user@example.com",
        "updated_at": datetime.utcnow() - timedelta(hours=3),
    })
    await mock_db.documents.insert_one({
        "_id": ObjectId(), "rollback_marker": "stuck-1",
    })

    await _cleanup_stuck_async()

    job = await JobEngine.get_job("stuck-1")
    assert job["status"] == "failed"
    docs = await mock_db.documents.find(
        {"rollback_marker": "stuck-1"}
    ).to_list(10)
    assert docs == []
