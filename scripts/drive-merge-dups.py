#!/usr/bin/env python3
"""Merge duplicate same-name sibling folders on a shared drive into the oldest one.

Usage:
  drive-merge-dups.py <root-folder-id> [--apply]

Without --apply only prints the tree and the plan. Uses the gws CLI for every
Drive call. Merge rule, applied recursively: within one parent, folders with
the same name form a group; the oldest (createdTime) is kept, every child of
the other copies is moved into it (folders recurse, files move), and the
emptied copies are trashed.
"""
import json
import subprocess
import sys
from collections import defaultdict

APPLY = "--apply" in sys.argv
ROOT = next((a for a in sys.argv[1:] if not a.startswith("--")), None)
if not ROOT:
    sys.exit(__doc__)

FOLDER = "application/vnd.google-apps.folder"


def gws(*args):
    out = subprocess.run(["gws", *args], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"gws failed: {' '.join(args)}\n{out.stderr}")
    return json.loads(out.stdout) if out.stdout.strip() else {}


def children(folder_id):
    files, token = [], None
    while True:
        params = {
            "q": f"'{folder_id}' in parents and trashed = false",
            "supportsAllDrives": True, "includeItemsFromAllDrives": True, "corpora": "allDrives",
            "fields": "nextPageToken,files(id,name,mimeType,createdTime)", "pageSize": 200,
        }
        if token:
            params["pageToken"] = token
        b = gws("drive", "files", "list", "--params", json.dumps(params))
        files += b.get("files", [])
        token = b.get("nextPageToken")
        if not token:
            return files


def move(file_id, new_parent, old_parent, label):
    print(f"  move   {label}")
    if APPLY:
        gws("drive", "files", "update", "--json", "{}", "--params", json.dumps({
            "fileId": file_id, "addParents": new_parent, "removeParents": old_parent,
            "supportsAllDrives": True, "fields": "id",
        }))


def trash(file_id, label):
    print(f"  trash  {label}")
    if APPLY:
        gws("drive", "files", "update", "--json", json.dumps({"trashed": True}), "--params", json.dumps({
            "fileId": file_id, "supportsAllDrives": True, "fields": "id",
        }))


stats = {"moves": 0, "trash": 0}


def merge_into(keep_id, dup_id, path):
    """Move everything from dup folder into keep folder (recursively), then trash dup."""
    keep_kids = children(keep_id)
    keep_folders = {f["name"]: f for f in keep_kids if f["mimeType"] == FOLDER}
    keep_files = {f["name"] for f in keep_kids if f["mimeType"] != FOLDER}
    left_behind = 0
    # Oldest first, and remember what landed in keep: a dup folder can itself
    # hold same-name siblings, which must merge into the first one moved.
    for c in sorted(children(dup_id), key=lambda f: f["createdTime"]):
        child_path = f"{path}/{c['name']}"
        if c["mimeType"] == FOLDER and c["name"] in keep_folders:
            merge_into(keep_folders[c["name"]]["id"], c["id"], child_path)
        elif c["mimeType"] != FOLDER and c["name"] in keep_files:
            left_behind += 1
            print(f"  CONFLICT file exists in both, left in place: {child_path} ({c['id']})")
        else:
            stats["moves"] += 1
            move(c["id"], keep_id, dup_id, f"{child_path} -> {path}/ ({c['id']})")
            if c["mimeType"] == FOLDER:
                keep_folders[c["name"]] = c
            else:
                keep_files.add(c["name"])
    if left_behind:
        print(f"  KEEP   {path} duplicate ({dup_id}) not trashed: {left_behind} conflicting file(s) inside")
        return
    stats["trash"] += 1
    trash(dup_id, f"{path} duplicate ({dup_id})")


def walk(folder_id, path):
    kids = children(folder_id)
    groups = defaultdict(list)
    for f in kids:
        if f["mimeType"] == FOLDER:
            groups[f["name"]].append(f)
    for name, group in sorted(groups.items()):
        group.sort(key=lambda f: f["createdTime"])
        keep = group[0]
        sub = f"{path}/{name}"
        if len(group) > 1:
            print(f"{sub}: {len(group)}x, keep {keep['id']} ({keep['createdTime']})")
            for dup in group[1:]:
                merge_into(keep["id"], dup["id"], sub)
        walk(keep["id"], sub)


root = gws("drive", "files", "get", "--params", json.dumps({"fileId": ROOT, "supportsAllDrives": True, "fields": "id,name"}))
print(f"{'APPLY' if APPLY else 'DRY-RUN'} under {root['name']} ({ROOT})")
walk(ROOT, root["name"])
print(f"plan: {stats['moves']} moves, {stats['trash']} folders to trash")
