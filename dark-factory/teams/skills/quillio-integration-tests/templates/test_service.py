"""Unit tests for <Partner>Service.

Drop into: backend-legal/tests/unit/integrations/<partner>/test_<partner>_service.py
"""
import pytest

from modules.integrations.<partner>.backend.services.<partner>_service import (
    <Partner>Service,
)


@pytest.mark.asyncio
async def test_get_client_returns_none_for_disconnected(
    mock_<partner>_settings, mock_db,
):
    service = <Partner>Service(db=mock_db)
    assert await service.get_client("ghost@example.com") is None
    await service.cleanup()


@pytest.mark.asyncio
async def test_get_client_adds_to_active_list(
    mock_<partner>_settings, mock_db, seed_credentials,
):
    service = <Partner>Service(db=mock_db)
    client = await service.get_client("user@example.com")
    assert client is not None
    assert client in service._active_clients
    await service.cleanup()
    assert service._active_clients == []


@pytest.mark.asyncio
async def test_list_matters_returns_canonical_shape(
    mock_<partner>_settings, mock_db, respx_mock, seed_credentials,
):
    respx_mock.get("https://api.partner.example.com/matters").respond(
        200, json={
            "items": [
                {
                    "id": "m1",
                    "name": "Smith vs Jones",
                    "description": "matter",
                    "number": "5",
                    "status": "open",
                    "client_id": "c1",
                },
            ],
            "total": 1,
        },
    )
    respx_mock.get("https://api.partner.example.com/clients/c1").respond(
        200, json={"id": "c1", "name": "Acme", "number": "100"}
    )

    service = <Partner>Service(db=mock_db)
    result = await service.list_matters("user@example.com")
    assert result["total"] == 1
    matter = result["items"][0]
    assert matter["external_id"] == "m1"
    assert matter["display_number"] == "100.5"
    await service.cleanup()


@pytest.mark.asyncio
async def test_unified_search_runs_in_parallel(
    mock_<partner>_settings, mock_db, respx_mock, seed_credentials,
):
    respx_mock.get("https://api.partner.example.com/clients").respond(
        200, json={"items": [], "total": 0}
    )
    respx_mock.get("https://api.partner.example.com/matters").respond(
        200, json={"items": [], "total": 0}
    )
    service = <Partner>Service(db=mock_db)
    result = await service.unified_search("user@example.com", "q")
    assert "clients" in result and "matters" in result
    await service.cleanup()


@pytest.mark.asyncio
async def test_import_documents_creates_job(
    mock_<partner>_settings, mock_db, mock_redis, monkeypatch, seed_credentials,
):
    captured = {}

    class FakeAsync:
        def delay(self, job_id):
            captured["job_id"] = job_id

    monkeypatch.setattr(
        "modules.integrations.<partner>.backend.tasks."
        "process_<partner>_import_job",
        FakeAsync(),
    )
    service = <Partner>Service(db=mock_db)
    response = await service.import_documents(
        "user@example.com", {"matters": []},
    )
    assert response["job_id"].startswith("<partner>_import_")
    assert captured["job_id"] == response["job_id"]
    await service.cleanup()


@pytest.mark.asyncio
async def test_get_proxy_document_url_signs_token(
    mock_<partner>_settings, mock_db, seed_credentials,
):
    service = <Partner>Service(db=mock_db)
    url = await service.get_proxy_document_url("user@example.com", "doc-1")
    assert "/integrations/<partner>/proxy/document/" in url
    assert "token=" in url
    await service.cleanup()
