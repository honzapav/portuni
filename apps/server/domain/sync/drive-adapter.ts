import type { FileAdapter, FileRef, RemoteConfig, DeviceTokens } from "./types.js";
import { parseDriveConfig, parseServiceAccountJson, assertSaDriveConfig, type ServiceAccountKey, type DriveConfig } from "./drive-config.js";
import { getDriveAccessToken, __setTokenFetchForTests } from "./drive-sa-auth.js";
import { getUserAccessToken } from "./drive-user-auth.js";
import { detectNativeFormat, EXPORT_MIME } from "./native-format.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

let driveFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export function __setDriveFetchForTests(f: typeof fetch): void {
  driveFetch = f;
  // Route SA token exchanges through the same fetch hook so tests can mock
  // both the Drive REST calls and the oauth token endpoint with a single
  // __setDriveFetchForTests call.
  __setTokenFetchForTests(async (url, jwt) => {
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });
    const res = await driveFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) throw new Error(`SA token exchange: ${res.status} ${await res.text()}`);
    const b = (await res.json()) as Record<string, unknown>;
    if (typeof b.access_token !== "string") throw new Error("SA token response missing access_token");
    return { access_token: b.access_token, expires_in: Number(b.expires_in ?? 3600) };
  });
}

interface DriveFile { id: string; name: string; mimeType: string; parents?: string[]; size?: string; md5Checksum?: string; modifiedTime?: string; createdTime?: string; trashed?: boolean; }

export function createDriveAdapter(remote: RemoteConfig, tokens: DeviceTokens): FileAdapter {
  const cfg: DriveConfig = parseDriveConfig(remote.config);
  const t = tokens[remote.name];
  let getAccessToken: () => Promise<string>;
  if (t?.mode === "refresh_token" && t.refresh_token) {
    getAccessToken = () => getUserAccessToken(t);
  } else if (t?.service_account_json) {
    assertSaDriveConfig(cfg);
    const sa: ServiceAccountKey = parseServiceAccountJson(t.service_account_json);
    getAccessToken = () => getDriveAccessToken(sa);
  } else {
    throw new Error(
      `Drive remote ${remote.name}: no credentials on this device. Connect Google Drive in Nastavení → Synchronizace, or run portuni_setup_remote with service_account_json.`,
    );
  }
  const driveRoot = cfg.root_folder_id ?? cfg.shared_drive_id!;
  // path -> Drive ID. For folders this is the PINNED id: when Drive holds
  // several same-name siblings (it allows that), the oldest one wins so every
  // caller and every process resolves the same folder. `alternates` keeps the
  // other siblings so content that already lives in one of them still
  // resolves; `inflight` single-flights folder creation so concurrent puts
  // into one new folder (the sync run's worker pool) cannot each create it.
  const pathCache = new Map<string, string>([["", driveRoot]]);
  const alternates = new Map<string, string[]>();
  const inflight = new Map<string, Promise<string>>();
  const warnedDuplicates = new Set<string>();

  function invalidatePrefix(prefix: string): void {
    if (prefix === "") {
      pathCache.clear();
      pathCache.set("", driveRoot);
      alternates.clear();
      return;
    }
    const prefixSlash = `${prefix}/`;
    for (const key of Array.from(pathCache.keys())) {
      if (key === prefix || key.startsWith(prefixSlash)) pathCache.delete(key);
    }
    for (const key of Array.from(alternates.keys())) {
      if (key === prefix || key.startsWith(prefixSlash)) alternates.delete(key);
    }
  }

  async function authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await getAccessToken()}` };
  }

  function withSAD(params: URLSearchParams): URLSearchParams {
    params.set("supportsAllDrives", "true");
    return params;
  }

  function withCorpora(params: URLSearchParams): URLSearchParams {
    if (cfg.shared_drive_id) {
      params.set("driveId", cfg.shared_drive_id);
      params.set("corpora", "drive");
    } else {
      params.set("corpora", "user");
    }
    return params;
  }

  function escapeQ(s: string): string {
    return s.replace(/'/g, "\\'");
  }

  // Children of `parentId` named `name`, oldest first (Drive returns
  // same-name siblings in arbitrary order otherwise).
  async function childrenNamed(parentId: string, name: string, foldersOnly: boolean): Promise<DriveFile[]> {
    const mime = foldersOnly ? " and mimeType = 'application/vnd.google-apps.folder'" : "";
    const q = `name = '${escapeQ(name)}' and '${parentId}' in parents${mime} and trashed = false`;
    const params = withCorpora(withSAD(new URLSearchParams({
      q, fields: "files(id,name,mimeType,createdTime)",
      orderBy: "createdTime",
      includeItemsFromAllDrives: "true",
    })));
    const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`, { headers: await authHeaders() });
    if (!res.ok) throw new Error(`Drive list: ${res.status} ${await res.text()}`);
    const b = (await res.json()) as { files?: DriveFile[] };
    return b.files ?? [];
  }

  function isFolder(f: DriveFile): boolean {
    return f.mimeType === "application/vnd.google-apps.folder";
  }

  // Pin the oldest of `folders` (already oldest-first) for `walked`, remember
  // the rest as alternates, and warn once per path so the duplicates get
  // merged by hand instead of silently splitting content.
  function pinFolder(walked: string, folders: DriveFile[]): string {
    const pinned = folders[0].id;
    pathCache.set(walked, pinned);
    if (folders.length > 1) {
      alternates.set(walked, folders.slice(1).map((f) => f.id));
      if (!warnedDuplicates.has(walked)) {
        warnedDuplicates.add(walked);
        console.warn(
          `[portuni:drive] ${remote.name}: duplicate folders for "${walked}" (${folders.map((f) => f.id).join(", ")}); using oldest ${pinned}. Merge the others into it manually.`,
        );
      }
    } else {
      alternates.delete(walked);
    }
    return pinned;
  }

  // All Drive ids a folder path may refer to: the pinned one first, then the
  // duplicate siblings seen when it was resolved.
  function folderIdsFor(walked: string): string[] {
    const pinned = pathCache.get(walked);
    if (pinned === undefined) return [];
    return [pinned, ...(alternates.get(walked) ?? [])];
  }

  async function resolvePathToFileId(path: string): Promise<string | null> {
    if (pathCache.has(path)) return pathCache.get(path)!;
    const segments = path.split("/").filter(Boolean);
    let walked = "";
    for (const seg of segments) {
      const parentWalked = walked;
      walked = walked ? `${walked}/${seg}` : seg;
      if (pathCache.has(walked)) continue;
      let found: DriveFile[] = [];
      // Search the pinned parent first, then its duplicate siblings: a file
      // pushed while the folder was still split may live in any of them.
      for (const parentId of folderIdsFor(parentWalked)) {
        found = await childrenNamed(parentId, seg, false);
        if (found.length > 0) break;
      }
      if (found.length === 0) return null;
      const folders = found.filter(isFolder);
      if (folders.length > 0) {
        pinFolder(walked, folders);
      } else {
        pathCache.set(walked, found[0].id);
      }
    }
    return pathCache.get(path)!;
  }

  async function createFolder(name: string, parentId: string): Promise<DriveFile> {
    const createParams = withSAD(new URLSearchParams({ fields: "id,name,mimeType,createdTime" }));
    const metadata = { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] };
    const createRes = await driveFetch(`${DRIVE_API}/files?${createParams.toString()}`, {
      method: "POST",
      headers: { ...await authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    });
    if (!createRes.ok) throw new Error(`Drive folder create: ${createRes.status} ${await createRes.text()}`);
    return (await createRes.json()) as DriveFile;
  }

  async function trashId(id: string): Promise<void> {
    const params = withSAD(new URLSearchParams());
    const res = await driveFetch(`${DRIVE_API}/files/${id}?${params.toString()}`, {
      method: "PATCH",
      headers: { ...await authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    if (!res.ok) throw new Error(`Drive trash: ${res.status} ${await res.text()}`);
  }

  // Resolve-or-create one folder segment. Single-flighted per path so N
  // concurrent callers share one search+create. After a create, re-list the
  // siblings: if an older same-name folder shows up (another process created
  // it, or Drive's search index lagged behind its own create), trash ours
  // and pin the older one -- Drive has no create-if-absent, so this
  // compensation is the only way to keep one folder per path.
  function ensureSegment(parentId: string, walked: string, seg: string): Promise<string> {
    const cached = pathCache.get(walked);
    if (cached !== undefined) return Promise.resolve(cached);
    const running = inflight.get(walked);
    if (running) return running;
    const task = (async () => {
      const existing = await childrenNamed(parentId, seg, true);
      if (existing.length > 0) return pinFolder(walked, existing);
      const created = await createFolder(seg, parentId);
      const after = await childrenNamed(parentId, seg, true);
      const others = after.filter((f) => f.id !== created.id);
      if (others.length > 0) {
        const older = others.filter((f) => (f.createdTime ?? "") < (created.createdTime ?? ""));
        if (older.length > 0) {
          await trashId(created.id);
          return pinFolder(walked, after.filter((f) => f.id !== created.id));
        }
        return pinFolder(walked, after);
      }
      pathCache.set(walked, created.id);
      return created.id;
    })();
    inflight.set(walked, task);
    return task.finally(() => {
      if (inflight.get(walked) === task) inflight.delete(walked);
    });
  }

  async function ensureFolderPath(path: string): Promise<string> {
    const segments = path.split("/").filter(Boolean);
    let parentId = driveRoot;
    let walked = "";
    for (const seg of segments) {
      walked = walked ? `${walked}/${seg}` : seg;
      parentId = await ensureSegment(parentId, walked, seg);
    }
    return parentId;
  }

  async function parentsOf(id: string): Promise<string[]> {
    const params = withSAD(new URLSearchParams({ fields: "id,parents" }));
    const res = await driveFetch(`${DRIVE_API}/files/${id}?${params.toString()}`, { headers: await authHeaders() });
    if (!res.ok) throw new Error(`Drive get: ${res.status} ${await res.text()}`);
    return ((await res.json()) as DriveFile).parents ?? [];
  }

  function fileRefFrom(f: DriveFile, path: string): FileRef {
    const native = detectNativeFormat(f.mimeType);
    return {
      path,
      hash: native.is_native_format ? null : (f.md5Checksum ?? null),
      size: f.size ? Number(f.size) : 0,
      modified_at: f.modifiedTime ? new Date(f.modifiedTime) : new Date(0),
      is_native_format: native.is_native_format,
      native_format: native.native_format,
    };
  }

  const adapter: FileAdapter = {
    async put(path, content, opts) {
      const parts = path.split("/");
      const filename = parts.pop()!;
      const folderPath = parts.join("/");
      const parentId = await ensureFolderPath(folderPath);
      const existingId = await resolvePathToFileId(path);
      // fields= makes the upload response carry everything fileRefFrom needs,
      // so no trailing adapter.stat round-trip is required per upload.
      const params = withSAD(
        new URLSearchParams({
          uploadType: "multipart",
          fields: "id,name,mimeType,size,md5Checksum,modifiedTime",
        }),
      );
      const boundary = "boundary" + Math.random().toString(36).slice(2);
      const metadata = existingId ? { name: filename } : { name: filename, parents: [parentId] };
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: ${opts?.mimeType ?? "application/octet-stream"}\r\n\r\n`),
        content,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const url = existingId ? `${DRIVE_UPLOAD}/files/${existingId}?${params.toString()}` : `${DRIVE_UPLOAD}/files?${params.toString()}`;
      const method = existingId ? "PATCH" : "POST";
      const res = await driveFetch(url, {
        method,
        headers: { ...await authHeaders(), "Content-Type": `multipart/related; boundary=${boundary}` },
        body: body as unknown as BodyInit,
      });
      if (!res.ok) throw new Error(`Drive upload: ${res.status} ${await res.text()}`);
      const file = (await res.json()) as DriveFile;
      pathCache.set(path, file.id);
      return fileRefFrom(file, path);
    },

    async get(path) {
      const id = await resolvePathToFileId(path);
      if (!id) throw new Error(`Drive get: file not found at ${path}`);
      const params = withSAD(new URLSearchParams({ alt: "media" }));
      const res = await driveFetch(`${DRIVE_API}/files/${id}?${params.toString()}`, { headers: await authHeaders() });
      if (!res.ok) throw new Error(`Drive get: ${res.status} ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    },

    // The remote sweep deletes a record when stat() answers null, so stat is
    // the one call that has to be right about presence. Two ways a naive
    // implementation lies "still there":
    //   - Drive's trash. list() filters trashed=false, but GET files/{id}
    //     happily answers 200 for a trashed file, so a file this process
    //     pushed (hence cached) and the user then trashed in the Drive UI
    //     would never be reconciled -- and a trashed NODE FOLDER would keep
    //     the sweep's reachability guard passing while every record under it
    //     looks gone.
    //   - a stale pathCache entry. The adapter instance lives for the whole
    //     process (adapter-cache.ts, no TTL) and the cache is only
    //     invalidated by this process's own rename/delete, so a rename done
    //     elsewhere -- or one of ours whose response was lost -- leaves the
    //     old path pointing at an id that has moved on. runMove then sees
    //     both source and destination and throws "both ... exist" forever.
    // Both are caught by asking for `trashed` and checking the returned
    // `name` against the last path segment: on a miss the cached entry is
    // dropped and the path is resolved from Drive once more, which also
    // finds a DIFFERENT object that has since taken the path.
    async stat(path) {
      const expectedName = path.split("/").filter(Boolean).pop() ?? null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const fromCache = pathCache.has(path);
        const id = await resolvePathToFileId(path);
        if (!id) return null;
        const params = withSAD(new URLSearchParams({ fields: "id,name,mimeType,size,md5Checksum,modifiedTime,parents,trashed" }));
        const res = await driveFetch(`${DRIVE_API}/files/${id}?${params.toString()}`, { headers: await authHeaders() });
        if (!res.ok) {
          if (res.status === 404) { invalidatePrefix(path); return null; }
          throw new Error(`Drive stat: ${res.status} ${await res.text()}`);
        }
        const file = (await res.json()) as DriveFile;
        const stale =
          file.trashed === true ||
          (expectedName !== null && file.name !== undefined && file.name !== expectedName);
        if (!stale) return fileRefFrom(file, path);
        // The object behind this path is not the one the path names. Drop
        // the cached mapping (and anything under it, if this is a folder)
        // and, if that mapping is what we just used, resolve again from
        // Drive -- a fresh search may find the real object at this path.
        invalidatePrefix(path);
        if (!fromCache) return null;
      }
      return null;
    },

    async list(prefix) {
      const root = prefix.replace(/\/$/, "");
      const rootId = await resolvePathToFileId(root);
      if (!rootId) return [];
      const out: FileRef[] = [];
      const seen = new Set<string>();
      async function children(folderId: string): Promise<DriveFile[]> {
        const all: DriveFile[] = [];
        let pageToken: string | undefined;
        do {
          const params = withCorpora(withSAD(new URLSearchParams({
            q: `'${folderId}' in parents and trashed = false`,
            fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,createdTime)",
            includeItemsFromAllDrives: "true",
            pageSize: "200",
          })));
          if (pageToken) params.set("pageToken", pageToken);
          const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`, { headers: await authHeaders() });
          if (!res.ok) throw new Error(`Drive list: ${res.status} ${await res.text()}`);
          const b = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
          all.push(...(b.files ?? []));
          pageToken = b.nextPageToken;
        } while (pageToken);
        return all;
      }
      // One path may map to several Drive folders (duplicates). Walk all of
      // them so content split across duplicates is still visible; the first
      // (oldest) copy of a file path wins.
      async function walk(folderIds: string[], prefixPath: string): Promise<void> {
        const entries: DriveFile[] = [];
        for (const fid of folderIds) entries.push(...(await children(fid)));
        entries.sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));
        const folderGroups = new Map<string, DriveFile[]>();
        for (const f of entries) {
          const childPath = prefixPath ? `${prefixPath}/${f.name}` : f.name;
          if (isFolder(f)) {
            const g = folderGroups.get(childPath) ?? [];
            g.push(f);
            folderGroups.set(childPath, g);
          } else if (!seen.has(childPath)) {
            seen.add(childPath);
            out.push(fileRefFrom(f, childPath));
          }
        }
        for (const [childPath, group] of folderGroups) {
          pinFolder(childPath, group);
          await walk(group.map((f) => f.id), childPath);
        }
      }
      await walk(folderIdsFor(root).length > 0 ? folderIdsFor(root) : [rootId], root);
      return out;
    },

    async delete(path) {
      const id = await resolvePathToFileId(path);
      if (!id) return;
      const params = withSAD(new URLSearchParams());
      const res = await driveFetch(`${DRIVE_API}/files/${id}?${params.toString()}`, {
        method: "PATCH",
        headers: { ...await authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      });
      if (!res.ok) throw new Error(`Drive trash: ${res.status} ${await res.text()}`);
      invalidatePrefix(path);
    },

    async rename(from, to) {
      const id = await resolvePathToFileId(from);
      if (!id) throw new Error(`Drive rename: source ${from} not found`);
      const toParts = to.split("/"); const newName = toParts.pop()!;
      const newParentId = await ensureFolderPath(toParts.join("/"));
      // removeParents must name the file's ACTUAL parent. Deriving it from the
      // old path picks the pinned folder, which is a different Drive id
      // whenever the file sits in a duplicate sibling -- Drive then ignores
      // the removal, adds the new parent and rejects the second parent with
      // 403 teamDrivesParentLimit on a shared drive.
      const currentParents = await parentsOf(id);
      const params = withSAD(new URLSearchParams({ fields: "id,name,parents" }));
      if (!currentParents.includes(newParentId)) {
        params.set("addParents", newParentId);
        if (currentParents.length > 0) params.set("removeParents", currentParents.join(","));
      }
      const res = await driveFetch(`${DRIVE_API}/files/${id}?${params.toString()}`, {
        method: "PATCH",
        headers: { ...await authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) throw new Error(`Drive rename: ${res.status} ${await res.text()}`);
      invalidatePrefix(from);
      pathCache.set(to, id);
    },

    async url(path) {
      const id = await resolvePathToFileId(path);
      if (!id) throw new Error(`Drive url: ${path} not found`);
      return `https://drive.google.com/file/d/${id}/view`;
    },

    async folderUrl(path) {
      // Lookup-only: do NOT create the folder if it doesn't exist yet
      // (the UI just wants to link to it if it's there).
      const id = await resolvePathToFileId(path);
      if (!id) return null;
      return `https://drive.google.com/drive/folders/${id}`;
    },

    async export(pathOrId, format) {
      const looksLikeId = /^[A-Za-z0-9_-]{20,}$/.test(pathOrId);
      const id = looksLikeId ? pathOrId : await resolvePathToFileId(pathOrId);
      if (!id) throw new Error(`Drive export: ${pathOrId} not found`);
      const params = new URLSearchParams({ mimeType: EXPORT_MIME[format] });
      const res = await driveFetch(`${DRIVE_API}/files/${id}/export?${params.toString()}`, { headers: await authHeaders() });
      if (!res.ok) throw new Error(`Drive export: ${res.status} ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    },

    async ensureFolder(path) {
      // Idempotent: ensureFolderPath either resolves an existing folder or
      // creates the missing segments. The pathCache makes repeat calls cheap.
      await ensureFolderPath(path);
    },
  };

  return adapter;
}
