---
title: Files & Mirrors
description: Tools for file management and local workspace mirroring.
---

## portuni_mirror

Create a local folder for a node and register it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID |
| `targets` | string[] | yes | Mirror targets (only `"local"` supported) |
| `custom_path` | string | no | Override default path |

Default path: `{PORTUNI_WORKSPACE_ROOT}/{slugified-name}/`

Creates subdirectories: `outputs/`, `wip/`, `resources/`.

Returns: `{ node_id, local_path, subdirs }`

## portuni_store

Store a file in a node's local mirror folder. Copies the file and registers it in the database.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID |
| `local_path` | string | yes | Absolute path to source file |
| `description` | string | no | File description |
| `status` | enum | no | `wip` (default) or `output` |

The file is copied to `{mirror}/wip/{filename}` or `{mirror}/outputs/{filename}` based on status. MIME type is detected from file extension.

:::note
The node must have a local mirror. Run `portuni_mirror` first.
:::

Returns: `{ id, filename, local_path, status }`

## portuni_pull

List files attached to a node with their local paths.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID |

Returns: `{ node_id, mirror_path, files: [...] }`

## portuni_list_files

List files across all nodes with optional filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | no | Filter by node |
| `status` | enum | no | Filter by status (`wip` or `output`) |

Returns: Array of files with `node_name` included.
