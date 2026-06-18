"""Integration test: import job end-to-end.

Drop into: backend-legal/tests/integration/integrations/<partner>/test_import_job_e2e.py
"""
import pytest
from httpx import AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_import_job_e2e(
    mock_<partner>_settings, mock_db, mock_redis, respx_mock,
    seed_credentials, celery_eager, auth_header, monkeypatch,
):
    # Mock partner endpoints.
    respx_mock.get(
        "https://api.partner.example.com/matters/m-1/documents/d-1"
    ).respond(
        200,
        json={
            "id": "d-1", "name": "Contract.pdf", "extension": "pdf",
            "size": 100, "modified": "2026-01-01T00:00:00Z",
            "links": {
                "content_url": "https://partner-cdn.example.com/d-1?signed",
            },
        },
    )

    async def fake_download(self, *a, **kw):
        return "https://aila-s3.example.com/d-1.sfdt"

    monkeypatch.setattr(
        "app.integrations.utils.document_service."
        "DocumentService.download_docx",
        fake_download,
    )

    async with AsyncClient(app=app, base_url="http://test") as client:
        response = await client.post(
            "/integrations/<partner>/import",
            json={
                "matters": [{
                    "matter_id": "m-1",
                    "items": [{"document_id": "d-1"}],
                }],
                "source": "user_initiated",
            },
            headers=auth_header,
        )
    assert response.status_code == 202
    job_id = response.json()["job_id"]

    # In eager mode the task ran synchronously inside the request;
    # confirm the document landed.
    doc = await mock_db.documents.find_one({
        "ownerId": "user@example.com",
        "<partner>_doc_id": "d-1",
    })
    assert doc is not None
    assert doc["sync_status"] == "complete"

    # Status endpoint reports completed.
    async with AsyncClient(app=app, base_url="http://test") as client:
        status_resp = await client.get(
            f"/integrations/<partner>/jobs/{job_id}",
            headers=auth_header,
        )
    assert status_resp.status_code == 200
    assert status_resp.json()["status"] == "completed"


@pytest.fixture
def auth_header() -> dict:
    # TODO(quillio:<partner>): wire to project JWT helper
    return {"Authorization": "Bearer test-jwt"}
