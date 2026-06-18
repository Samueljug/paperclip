"""Unit tests for <partner> mappers.

Drop into: backend-legal/tests/unit/integrations/<partner>/test_<partner>_mappers.py
"""
from modules.integrations.<partner>.backend.mappers import (
    <partner>_mappers as mappers,
)
from modules.integrations.<partner>.backend.models.<partner>_models import (
    <Partner>Document,
    <Partner>Matter,
    <Partner>Party,
    <Partner>TreeItem,
)


def test_map_party_to_contact_with_number_prefix():
    party = <Partner>Party(
        id="c1", name="Acme", number="100",
        email_addresses=[{"email": "x@y.com"}],
    )
    contact = mappers.map_party_to_contact(party)
    assert contact["id"] == "c1"
    assert contact["external_id"] == "c1"
    assert contact["provider"] == "<partner>"
    assert contact["name"] == "100 - Acme"
    assert contact["email"] == "x@y.com"


def test_map_party_to_contact_without_number():
    party = <Partner>Party(id="c1", name="Acme")
    contact = mappers.map_party_to_contact(party)
    assert contact["name"] == "Acme"


def test_map_matter_to_canonical_builds_display_number():
    matter = <Partner>Matter(
        id="m1", name="case", description="Smith vs Jones",
        number="5", status="open", client_id="c1",
    )
    out = mappers.map_matter_to_canonical(matter, client_number="100")
    assert out["display_number"] == "100.5"
    assert out["name"].startswith("100.5 - ")


def test_map_matter_to_canonical_no_client_number():
    matter = <Partner>Matter(id="m1", name="case", number="5")
    out = mappers.map_matter_to_canonical(matter)
    assert out["display_number"] == "5"


def test_map_document_to_canonical_with_number_prefix():
    doc = <Partner>Document(
        id="d1", name="Contract", number="101",
        extension="docx", mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size=12345, matter_id="m1", parent_folder_id="f1",
        categories=[{"name": "Legal"}, {"name": "Contracts"}],
    )
    out = mappers.map_document_to_canonical(doc)
    assert out["name"] == "101 - Contract"
    assert out["categories"] == ["Legal", "Contracts"]
    assert out["folder_id"] == "f1"


def test_extract_matter_number_from_text():
    assert mappers.extract_matter_number_from_text("Matter 1 (5)") == "5"
    assert mappers.extract_matter_number_from_text("Matter 1") is None
    assert mappers.extract_matter_number_from_text("") is None
    assert mappers.extract_matter_number_from_text(None) is None


def test_map_tree_item_marks_imported():
    item = <Partner>TreeItem(
        id="d1", name="Doc", type="document",
        children=[<Partner>TreeItem(id="d2", name="Child", type="document")],
    )
    out = mappers.map_tree_item(item, imported_ids={"d1"})
    assert out["selectable"] is False
    assert out["import_status"] == "imported"
    assert out["children"][0]["selectable"] is True


def test_filter_helpers():
    items = [
        {"_group_type": "active_client"},
        {"_group_type": "open_matter"},
        {"_group_type": "other"},
    ]
    assert len(mappers.filter_client_results(items)) == 1
    assert len(mappers.filter_matter_results(items)) == 1
