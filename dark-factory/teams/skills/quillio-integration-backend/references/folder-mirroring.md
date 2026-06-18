# Folder Mirroring

Reference: `modules/integrations/onelaw/backend/tasks.py` (folder-tree handling) + `app/integrations/clio/service.py:1126-1285` (parent-chain walking).

## When You Need This

If the partner's documents live in a folder hierarchy and you want users to see that hierarchy in AILA. Skip if:
- Partner has no folders (documents live in matter root) — mirror nothing.
- Partner has flat single-level folders per matter — mirror once at import time, no recursion.

## When You Need The Full Two-Pass Walker

If a user can pick a deep folder (or a single document inside a deep folder) for import without first importing the matter root, you need to walk UP the chain to fill in missing ancestors.

Otherwise: simple parent_id lookup at import time is enough.

## Hard Caps

- Max folder depth: **50** (Clio cap; matches reasonable legal file structures)
- Max folders per import: **50,000** (rejects pathological cases)
- Max breadth per level: **5,000** (warn + truncate)

## Two-Pass Parent Chain Walker

Pattern: walk up the chain collecting Clio IDs, then walk down creating AILA folders bottom-up.

```python
async def create_update_parent_folders(
    client: "<Partner>Client",
    db,
    user_email: str,
    leaf_folder_id: str,
    matter_id: Optional[str] = None,
    max_depth: int = 50,
) -> Optional[str]:
    """
    Ensure every ancestor folder of `leaf_folder_id` exists in AILA.
    Returns the AILA ObjectId (str) of the leaf folder.
    """
    chain: list[Dict[str, Any]] = []  # leaf-first
    visited: set[str] = set()
    cursor_id = leaf_folder_id
    matter_anchor_aila_id: Optional[str] = None
    captured_matter_id: Optional[str] = matter_id

    # ---------- Pass 1: walk UP ----------
    for depth in range(max_depth):
        if not cursor_id or cursor_id in visited:
            break
        visited.add(cursor_id)

        # Check if this folder already exists in AILA — if so, it's our anchor.
        existing = await db.folders.find_one({
            "ownerId": user_email,
            "integration": "<partner>",
            "action_id": cursor_id,
        })
        if existing:
            matter_anchor_aila_id = str(existing["_id"])
            break

        folder = await client.get_folder(cursor_id)  # adapt method name per partner
        if not folder:
            break
        chain.append(folder)

        # Capture the matter ID if folder carries it.
        if not captured_matter_id:
            captured_matter_id = folder.get("matter_id")

        cursor_id = folder.get("parent_id")

    # ---------- Pass 2: walk DOWN ----------
    chain.reverse()  # root-first
    parent_aila_id = matter_anchor_aila_id

    if not parent_aila_id and captured_matter_id:
        # Anchor at matter folder if we know the matter.
        matter_folder = await db.folders.find_one({
            "ownerId": user_email,
            "integration": "<partner>",
            "type": "matter",
            "action_id": captured_matter_id,
        })
        if matter_folder:
            parent_aila_id = str(matter_folder["_id"])

    leaf_aila_id: Optional[str] = None
    for folder in chain:
        leaf_aila_id = await create_update_existing_folder(
            db, user_email,
            external_id=folder["id"],
            name=folder["name"],
            parent_aila_id=parent_aila_id,
            matter_id=captured_matter_id,
        )
        parent_aila_id = leaf_aila_id

    return leaf_aila_id
```

## Single Folder Upsert

```python
async def create_update_existing_folder(
    db,
    user_email: str,
    *,
    external_id: str,
    name: str,
    parent_aila_id: Optional[str],
    matter_id: Optional[str] = None,
    folder_type: str = "sub",
) -> str:
    """Upsert one folder. Returns AILA ObjectId as str."""
    now = datetime.utcnow()
    update = {
        "$set": {
            "ownerId": user_email,
            "integration": "<partner>",
            "action_id": external_id,
            "type": folder_type,
            "folderName": name,
            "title": name,
            "parentFolderId": parent_aila_id,
            "matterId": matter_id,
            "updatedAt": now,
        },
        "$setOnInsert": {
            "createdAt": now,
            "document_count": 0,
        },
    }
    result = await db.folders.update_one(
        {"ownerId": user_email, "integration": "<partner>", "action_id": external_id},
        update,
        upsert=True,
    )
    if result.upserted_id:
        return str(result.upserted_id)
    existing = await db.folders.find_one(
        {"ownerId": user_email, "integration": "<partner>", "action_id": external_id},
        {"_id": 1},
    )
    return str(existing["_id"])
```

## `document_count` Denormalisation

Folder shows a count of documents inside (and inside children, depending on UX). MongoDB doesn't do hierarchical aggregation cheaply, so denormalise.

### Direct count only (cheap)

Increment/decrement on every document insert/update/move:

```python
# Document moved from folder A to folder B
await db.folders.update_one({"_id": ObjectId(folder_a_aila_id)}, {"$inc": {"document_count": -1}})
await db.folders.update_one({"_id": ObjectId(folder_b_aila_id)}, {"$inc": {"document_count": 1}})
```

### Subtree count (expensive but accurate)

Recompute periodically (e.g., end of import job) using post-order traversal:

```python
async def recount_folder_documents(db, user_email: str, integration: str = "<partner>") -> None:
    folders = await db.folders.find(
        {"ownerId": user_email, "integration": integration},
        {"_id": 1, "parentFolderId": 1},
    ).to_list(None)

    folder_ids = [f["_id"] for f in folders]
    parent_map: Dict[str, list] = {}
    for f in folders:
        parent_map.setdefault(f.get("parentFolderId"), []).append(str(f["_id"]))

    # Direct doc counts.
    pipeline = [
        {"$match": {"ownerId": user_email, "integration": integration, "isTrashed": {"$ne": True}}},
        {"$group": {"_id": "$folderId", "count": {"$sum": 1}}},
    ]
    direct = {str(d["_id"]): d["count"] async for d in db.documents.aggregate(pipeline) if d["_id"]}

    # Iterative post-order.
    counts: Dict[str, int] = {}
    stack: list[str] = [str(fid) for fid in folder_ids if not any(str(fid) in v for v in parent_map.values())]
    visited: set[str] = set()
    order: list[str] = []
    while stack:
        node = stack.pop()
        if node in visited:
            continue
        visited.add(node)
        order.append(node)
        stack.extend(parent_map.get(node, []))
    for node in reversed(order):
        counts[node] = direct.get(node, 0) + sum(counts.get(child, 0) for child in parent_map.get(node, []))

    # Bulk update only changed counts.
    bulk = []
    for fid in folder_ids:
        new_count = counts.get(str(fid), 0)
        bulk.append(UpdateOne(
            {"_id": fid, "document_count": {"$ne": new_count}},
            {"$set": {"document_count": new_count}},
        ))
    if bulk:
        await db.folders.bulk_write(bulk, ordered=False)
```

Run after every import job completes; once per webhook batch is overkill (Smokeball did this and tanked write throughput).

## Folder Move Webhook Handling

When the partner fires a `document.moved` event:

1. Find AILA documents with the partner doc_id.
2. For each owner, look up source and destination folder AILA IDs.
3. If they differ:
   - Update `documents.folderId = destination_aila_id`
   - Decrement source folder `document_count`
   - Increment destination folder `document_count`
   - If destination folder doesn't exist in AILA, walk parent chain to create it (use the two-pass walker above).
4. Idempotency: skip if source == destination.

## Cycle Detection

Partners CAN return cyclic folder graphs (rare but real). The `visited` set in the walker catches this. Log a warning when hit; do not raise.

## Soft-Deleted Folders

Most partners support folder soft-delete (`isTrashed=true`, `deleted_at`). Do not import soft-deleted folders. Filter in `client.list_folders` or `client.get_folder`. If a soft-deleted folder is referenced by a doc you're importing (data inconsistency on the partner side), log warning and place doc in matter root as a fallback.
