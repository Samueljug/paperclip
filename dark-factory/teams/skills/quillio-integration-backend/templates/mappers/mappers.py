"""Translate <partner> API objects into AILA canonical objects.

Drop into: modules/integrations/<partner>/backend/mappers/<partner>_mappers.py
"""
import re
from typing import Any, Dict, List, Optional

from modules.integrations.<partner>.backend.models.<partner>_models import (
    <Partner>Document,
    <Partner>Matter,
    <Partner>Party,
    <Partner>TreeItem,
)

PROVIDER = "<partner>"
_MATTER_NUMBER_RE = re.compile(r"\((\d+)\)\s*$")


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


def map_matter_to_canonical(
    matter: <Partner>Matter,
    *,
    client_number: Optional[str] = None,
) -> Dict[str, Any]:
    display_number: Optional[str] = None
    if client_number and matter.number:
        display_number = f"{client_number}.{matter.number}"
    elif matter.number:
        display_number = matter.number

    base_name = matter.description or matter.name
    name = (
        f"{display_number} - {base_name}" if display_number else base_name
    )
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
    content_url = (
        doc.links.content_url if doc.links and doc.links.content_url
        else doc.content_url
    )
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
        "content_url": content_url,
        "categories": [
            c.get("name") for c in doc.categories if c.get("name")
        ],
    }


def map_tree_item(
    item: <Partner>TreeItem,
    *,
    imported_ids: Optional[set] = None,
) -> Dict[str, Any]:
    imported_ids = imported_ids or set()
    return {
        "id": item.id,
        "name": item.name,
        "type": item.type,
        "parent_id": item.parent_id,
        "selectable": item.id not in imported_ids,
        "import_status": (
            "imported" if item.id in imported_ids else None
        ),
        "content_url": item.content_url,
        "categories": [
            c.get("name") for c in item.categories if c.get("name")
        ],
        "children": [
            map_tree_item(c, imported_ids=imported_ids)
            for c in item.children
        ],
    }


# ----------------------- Search helpers -----------------------

def extract_matter_number_from_text(text: str) -> Optional[str]:
    if not text:
        return None
    match = _MATTER_NUMBER_RE.search(text)
    return match.group(1) if match else None


def map_search_result_to_matter(
    item: Dict[str, Any],
    *,
    client_number_lookup: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    raw_text = item.get("name") or item.get("text") or ""
    matter_number = extract_matter_number_from_text(raw_text)
    cleaned = _MATTER_NUMBER_RE.sub("", raw_text).strip()

    client_id = item.get("client_id")
    client_number = (
        (client_number_lookup or {}).get(client_id) if client_id else None
    )
    display_number = (
        f"{client_number}.{matter_number}"
        if (client_number and matter_number)
        else matter_number
    )
    return {
        "id": item.get("id"),
        "external_id": item.get("id"),
        "provider": PROVIDER,
        "name": (
            f"{display_number} - {cleaned}" if display_number else cleaned
        ),
        "display_number": display_number,
        "status": item.get("status"),
        "client_id": client_id,
    }


def filter_client_results(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        i for i in items
        if i.get("_group_type") in (
            "client", "active_client", "inactive_client", "party",
        )
    ]


def filter_matter_results(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        i for i in items
        if i.get("_group_type") in (
            "matter", "open_matter", "closed_matter",
        )
    ]
