# Mappers & Models (`<partner>_mappers.py` + `<partner>_models.py`)

Reference: `modules/integrations/onelaw/backend/{models,mappers}/onelaw_*.py`.

## Responsibility

`<partner>_models.py` — Pydantic schemas for partner API responses, request bodies, and stored credentials. Single source of truth for the wire shape.

`<partner>_mappers.py` — Translate partner objects into AILA canonical objects. Handle naming, prefixing, normalisation. Pure functions — no I/O.

## Models Skeleton

```python
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# -------------------- Partner API response models --------------------

class <Partner>Party(BaseModel):
    """A client / contact in the partner system."""
    id: str
    name: str
    number: Optional[str] = None
    email_addresses: List[Dict[str, Any]] = Field(default_factory=list)
    phone_numbers: List[Dict[str, Any]] = Field(default_factory=list)
    created: Optional[datetime] = None
    modified: Optional[datetime] = None

    @property
    def primary_email(self) -> Optional[str]:
        for entry in self.email_addresses:
            if isinstance(entry, dict):
                for key in ("email", "address", "value"):
                    if entry.get(key):
                        return str(entry[key])
            elif isinstance(entry, str):
                return entry
        return None


class <Partner>Matter(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    status: Optional[str] = None
    number: Optional[str] = None
    account_number: Optional[str] = None
    client_id: Optional[str] = None
    opened_date: Optional[datetime] = None
    last_edited: Optional[datetime] = None


class <Partner>DocumentLink(BaseModel):
    content_url: Optional[str] = None
    download_url: Optional[str] = None


class <Partner>Document(BaseModel):
    id: str
    name: str
    file_name: Optional[str] = None
    number: Optional[str] = None
    extension: Optional[str] = None
    mime_type: Optional[str] = None
    size: Optional[int] = None
    matter_id: Optional[str] = None
    parent_folder_id: Optional[str] = None
    categories: List[Dict[str, Any]] = Field(default_factory=list)
    created: Optional[datetime] = None
    modified: Optional[datetime] = None
    updated: Optional[datetime] = None
    content_url: Optional[str] = None
    links: Optional[<Partner>DocumentLink] = None


class <Partner>Folder(BaseModel):
    id: str
    name: str
    parent_id: Optional[str] = None
    matter_id: Optional[str] = None
    document_count: Optional[int] = None


class <Partner>TreeItem(BaseModel):
    id: str
    name: str
    type: str  # "folder" | "document"
    parent_id: Optional[str] = None
    children: List["<Partner>TreeItem"] = Field(default_factory=list)
    content_url: Optional[str] = None
    categories: List[Dict[str, Any]] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)


# -------------------- Stored credentials --------------------

class <Partner>Credentials(BaseModel):
    owner_id: str
    provider: str = "<partner>"
    access_token: str
    refresh_token: Optional[str] = None
    token_expiry: Optional[datetime] = None
    api_base_url: str
    firm_cloud_id: Optional[str] = None
    webhook_signing_key: Optional[str] = None
    status: str = "connected"
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


# -------------------- Request models --------------------

class ImportItem(BaseModel):
    document_id: str
    document_name: Optional[str] = None


class MatterImportConfig(BaseModel):
    matter_id: str
    items: List[ImportItem] = Field(default_factory=list)
    import_all: bool = False


class <Partner>ImportRequest(BaseModel):
    client_id: Optional[str] = None
    client_files: List[ImportItem] = Field(default_factory=list)
    matters: List[MatterImportConfig] = Field(default_factory=list)
    import_all: bool = False
    source: str = "user_initiated"  # or "webhook" / "bulk_import"


class ExportItem(BaseModel):
    aila_doc_id: str
    document_id: Optional[str] = None  # None means create new


class <Partner>ExportRequest(BaseModel):
    matter_id: str
    items: List[ExportItem]


# -------------------- Response wrappers --------------------

class ClientListResponse(BaseModel):
    items: List["Contact"]
    total: int
    page: int
    total_pages: int


class MatterListResponse(BaseModel):
    items: List["Matter"]
    total: int
    page: int
    total_pages: int


# -------------------- Webhook payloads --------------------

class WebhookResourceRef(BaseModel):
    id: str
    number: Optional[str] = None


class WebhookDocumentData(BaseModel):
    document_id: Optional[str] = None
    matter_id: Optional[str] = None
    client_id: Optional[str] = None
    name: Optional[str] = None
    file_name: Optional[str] = None
    extension: Optional[str] = None
    mime_type: Optional[str] = None
    content_url: Optional[str] = None


class WebhookDocumentMovedData(BaseModel):
    document_id: str
    from_: WebhookResourceRef = Field(..., alias="from")
    to: WebhookResourceRef
```

## AILA Canonical Models

These are the consumer-facing types. Define once per project (probably in `app/integrations/core/models/canonical.py`); reuse across integrations.

```python
class Contact(BaseModel):
    id: str           # AILA ID = stringified partner ID
    external_id: str  # original partner ID
    provider: str
    name: str         # "{number} - {name}" if number available
    number: Optional[str] = None
    email: Optional[str] = None


class Matter(BaseModel):
    id: str
    external_id: str
    provider: str
    name: str          # "{client_number}.{matter_number} - {description}"
    display_number: Optional[str] = None
    status: Optional[str] = None
    client_id: Optional[str] = None


class Document(BaseModel):
    id: str
    external_id: str
    provider: str
    name: str
    file_name: Optional[str] = None
    extension: Optional[str] = None
    mime_type: Optional[str] = None
    size: Optional[int] = None
    matter_id: Optional[str] = None
    folder_id: Optional[str] = None
    content_url: Optional[str] = None  # short-lived, do not store
    categories: List[str] = Field(default_factory=list)


class TreeItem(BaseModel):
    id: str
    name: str
    type: str
    parent_id: Optional[str] = None
    children: List["TreeItem"] = Field(default_factory=list)
    selectable: bool = True
    import_status: Optional[str] = None
    content_url: Optional[str] = None
    categories: List[str] = Field(default_factory=list)
```

## Mapper Skeleton

```python
import re
from typing import Any, Dict, List, Optional

from modules.integrations.<partner>.backend.models.<partner>_models import (
    <Partner>Party, <Partner>Matter, <Partner>Document, <Partner>TreeItem,
)

PROVIDER = "<partner>"


def map_party_to_contact(party: <Partner>Party) -> Dict[str, Any]:
    name = f"{party.number} - {party.name}" if party.number else party.name
    return {
        "id": party.id,
        "external_id": party.id,
        "provider": PROVIDER,
        "name": name,
        "number": party.number,
        "email": party.primary_email,
    }


def map_matter_to_canonical(matter: <Partner>Matter, *, client_number: Optional[str] = None) -> Dict[str, Any]:
    display_number = None
    if client_number and matter.number:
        display_number = f"{client_number}.{matter.number}"
    elif matter.number:
        display_number = matter.number

    base_name = matter.description or matter.name
    name = f"{display_number} - {base_name}" if display_number else base_name

    return {
        "id": matter.id,
        "external_id": matter.id,
        "provider": PROVIDER,
        "name": name,
        "display_number": display_number,
        "status": matter.status,
        "client_id": matter.client_id,
    }


def map_document_to_canonical(doc: <Partner>Document) -> Dict[str, Any]:
    name = f"{doc.number} - {doc.name}" if doc.number else doc.name
    return {
        "id": doc.id,
        "external_id": doc.id,
        "provider": PROVIDER,
        "name": name,
        "file_name": doc.file_name or doc.name,
        "extension": doc.extension,
        "mime_type": doc.mime_type,
        "size": doc.size,
        "matter_id": doc.matter_id,
        "folder_id": doc.parent_folder_id,
        "content_url": doc.links.content_url if doc.links else doc.content_url,
        "categories": [c.get("name") for c in doc.categories if c.get("name")],
    }


def map_tree_item(item: <Partner>TreeItem, *, imported_ids: Optional[set] = None) -> Dict[str, Any]:
    imported_ids = imported_ids or set()
    return {
        "id": item.id,
        "name": item.name,
        "type": item.type,
        "parent_id": item.parent_id,
        "selectable": item.id not in imported_ids,
        "import_status": "imported" if item.id in imported_ids else None,
        "content_url": item.content_url,
        "categories": [c.get("name") for c in item.categories if c.get("name")],
        "children": [map_tree_item(c, imported_ids=imported_ids) for c in item.children],
    }


# -------------------- Search-specific helpers --------------------

_MATTER_NUMBER_RE = re.compile(r"\((\d+)\)\s*$")


def extract_matter_number_from_text(text: str) -> Optional[str]:
    if not text:
        return None
    match = _MATTER_NUMBER_RE.search(text)
    return match.group(1) if match else None


def map_search_result_to_matter(item: Dict[str, Any], *, client_number_lookup: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    raw_text = item.get("name") or item.get("text") or ""
    matter_number = extract_matter_number_from_text(raw_text)
    cleaned = _MATTER_NUMBER_RE.sub("", raw_text).strip()

    client_id = item.get("client_id")
    client_number = (client_number_lookup or {}).get(client_id) if client_id else None
    display_number = f"{client_number}.{matter_number}" if (client_number and matter_number) else matter_number

    return {
        "id": item.get("id"),
        "external_id": item.get("id"),
        "provider": PROVIDER,
        "name": f"{display_number} - {cleaned}" if display_number else cleaned,
        "display_number": display_number,
        "status": item.get("status"),
        "client_id": client_id,
    }


def filter_client_results(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [i for i in items if i.get("_group_type") in ("client", "active_client", "inactive_client", "party")]


def filter_matter_results(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [i for i in items if i.get("_group_type") in ("matter", "open_matter", "closed_matter")]
```

## Naming Conventions

| Object | Display name format |
|---|---|
| Contact | `"{number} - {name}"` (number prefix only if present) |
| Matter | `"{client_number}.{matter_number} - {description}"` (display_number prefix) |
| Document | `"{number} - {name}"` |
| Folder | `"{name}"` (rare for partners to number folders) |

## MongoDB Collection Schemas

These are NOT Pydantic models — they're documented shapes for the ad-hoc dicts written via Motor.

```python
# documents collection (shared across all integrations)
{
    "_id": ObjectId,
    "ownerId": "user@example.com",       # multi-tenant key
    "integration": "<partner>",
    "provider": "<partner>",             # duplicate for grep-friendliness
    "<partner>_doc_id": "external-id",   # external_id reference
    "sp_doc_id": "external-id",          # OneLaw-compatible alias for shared queries
    "title": "1234 - Contract.docx",
    "fileName": "Contract.docx",
    "extension": "docx",
    "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "size": 12345,
    "folderId": "ObjectId-or-string",
    "matterId": "external-id",
    "action_id": "external-id",          # sometimes called action_id legacy

    # Sync state
    "sync_status": "pending|syncing|complete|failed",
    "sync_started_at": datetime,
    "<partner>_modified_at": datetime,
    "last_synced_to_<partner>_at": datetime,
    "ready_to_sync": False,
    "isTrashed": False,
    "old_docs": False,
    "rollback_marker": "job_id-or-null",

    "createdAt": datetime,
    "updatedAt": datetime,
}

# folders collection (shared)
{
    "_id": ObjectId,
    "ownerId": "user@example.com",
    "integration": "<partner>",
    "type": "matter|client|sub",
    "action_id": "external-id",
    "parentFolderId": "ObjectId-or-null",
    "folderName": "Display Name",
    "title": "Display Name",
    "document_count": 0,                 # denormalised; see folder-mirroring.md
    "createdAt": datetime,
    "updatedAt": datetime,
}

# integration_tokens collection (shared)
# See auth.md for shape.

# <partner>_sync_events collection (per-partner)
# See sync-state.md for shape.
```

## Pydantic v2 Notes

- `Field(default_factory=list)` for mutable defaults
- `model_config = ConfigDict(populate_by_name=True)` to allow alias keys
- `Field(..., alias="from")` for reserved-keyword fields
- `model_dump(by_alias=True, exclude_none=True)` for serialisation

## File Size Budget

Models < 200 lines, mappers < 250 lines. If they grow:
- Split models by domain (`<partner>_party_models.py`, `<partner>_matter_models.py`, etc.)
- Split mappers same way
