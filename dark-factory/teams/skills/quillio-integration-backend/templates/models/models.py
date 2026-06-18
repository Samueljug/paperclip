"""Pydantic models for <partner> API + stored credentials + request bodies.

Drop into: modules/integrations/<partner>/backend/models/<partner>_models.py
"""
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


# -------------------- Partner API response models --------------------

class <Partner>Party(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

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
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

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
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

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
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: str
    name: str
    parent_id: Optional[str] = None
    matter_id: Optional[str] = None
    document_count: Optional[int] = None


class <Partner>TreeItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

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
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

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


# -------------------- Request body models --------------------

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
    source: str = "user_initiated"


class ExportItem(BaseModel):
    aila_doc_id: str
    document_id: Optional[str] = None


class <Partner>ExportRequest(BaseModel):
    matter_id: str
    items: List[ExportItem]


# -------------------- Webhook payload models --------------------

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
