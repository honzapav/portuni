import type { FileAdapter, FileRef, RemoteConfig, DeviceTokens, SearchHit, RemoteChange, RemoteChanges } from "./types.js";
import { parseDriveConfig, parseServiceAccountJson, assertSaDriveConfig, type ServiceAccountKey, type DriveConfig } from "./drive-config.js";
import { getDriveAccessToken, __setTokenFetchForTests } from "./drive-sa-auth.js";
import { detectNativeFormat, EXPORT_MIME } from "./native-format.js";
import { SEARCH_SNIPPET_MAX_CHARS } from "./types.js";
import { createFolderPathCache, type FolderPathStore } from "./drive-folder-cache.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

// Bounded prefix fetched per search hit to extract a snippet from -- see
// search()'s snippetSource.
const SNIPPET_FETCH_MAX_CHARS = 65_536;

// #211 cleanup: snippet fetches used to run one-at-a-time inside the paging
// loop -- up to `limit` sequential round trips per search. A small
// concurrency cap parallelizes them without hammering the Drive API quota
// the way an unbounded Promise.all over the whole page would.
const SNIPPET_FETCH_CONCURRENCY = 5;

// Pages of the Changes API one changes() call walks before handing the
// unconsumed page token back as the cursor. A tick that finds 5 000 changes
// (a bulk upload, a first run after a long downtime) applies what it has and
// resumes from the same place on the next call instead of paging unbounded
// inside one tick.
const CHANGES_MAX_PAGES = 50;

// Bounded-concurrency map: workers pull from a shared index, results land in
// the same positions as the inputs. Mirrors engine.ts's mapWithConcurrency
// (statusScan) -- small enough, and specific enough to this module's fetch
// shape, that sharing one generic helper across the two isn't worth the
// coupling.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

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

// One entry of a Drive changes.list page. `file` is absent on a hard
// delete and on drive-level changes.
interface DriveChangeItem { fileId?: string; removed?: boolean; file?: DriveFile; }

interface DriveFile { id: string; name: string; mimeType: string; parents?: string[]; size?: string; md5Checksum?: string; modifiedTime?: string; createdTime?: string; trashed?: boolean; }

export interface DriveAdapterDeps {
  // Persistent tier of the ancestor cache (#419). Omitted -- a test, or any
  // caller with no graph db at hand -- leaves the adapter on its in-process
  // memo alone, exactly as it behaved before the table was wired up.
  folderCache?: FolderPathStore | null;
}

export function createDriveAdapter(
  remote: RemoteConfig,
  tokens: DeviceTokens,
  deps: DriveAdapterDeps = {},
): FileAdapter {
  const cfg: DriveConfig = parseDriveConfig(remote.config);
  const t = tokens[remote.name];
  let getAccessToken: () => Promise<string>;
  if (t?.service_account_json) {
    assertSaDriveConfig(cfg);
    const sa: ServiceAccountKey = parseServiceAccountJson(t.service_account_json);
    getAccessToken = () => getDriveAccessToken(sa);
  } else {
    throw new Error(
      `Drive remote ${remote.name}: no credentials on this device. Run portuni_setup_remote with service_account_json.`,
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

  async function invalidatePrefix(prefix: string): Promise<void> {
    // The ancestor cache is keyed by folder id but its values ARE paths, so
    // a prefix does narrow it (#419): drop the folders at or under `prefix`
    // in both tiers instead of clearing the whole memo. Whatever is dropped
    // is rebuilt one DB read -- or one files.get -- per distinct ancestor.
    await folderPaths.invalidateSubtree(prefix);
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
  // same-name siblings in arbitrary order otherwise). Drive's `name =`
  // compares code points, and an object uploaded from a Mac before names
  // were normalized carries the NFD spelling of the NFC path Portuni
  // computes for it (or the other way round). A miss on a name that
  // decomposes is retried in the other form before it counts as absent.
  async function childrenNamed(parentId: string, name: string, foldersOnly: boolean): Promise<DriveFile[]> {
    const found = await childrenNamedExact(parentId, name, foldersOnly);
    if (found.length > 0) return found;
    const nfc = name.normalize("NFC");
    const nfd = name.normalize("NFD");
    if (nfc === nfd) return found;
    return childrenNamedExact(parentId, name === nfc ? nfd : nfc, foldersOnly);
  }

  async function childrenNamedExact(parentId: string, name: string, foldersOnly: boolean): Promise<DriveFile[]> {
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

  // Ancestor cache for the reverse direction of pathCache: folder id ->
  // path relative to driveRoot, so a flat Drive file object (a search hit,
  // a Changes API entry) can be turned back into a path without walking to
  // the root over the network every time. Two tiers -- a bounded in-process
  // memo over `remote_folder_cache` -- see drive-folder-cache.ts (#419). A
  // null entry marks an id whose ancestry is unreachable from here
  // (deleted, or not readable by this account) so it is not re-fetched on
  // every hit; those live in the memo only.
  //
  // Invalidated by path: this adapter's own writes go through
  // invalidatePrefix, and a folder reported by the change feed refreshes
  // (or drops) its own entry.
  const folderPaths = createFolderPathCache(deps.folderCache ?? null);

  function joinPath(parentPath: string, name: string): string {
    return parentPath === "" ? name : `${parentPath}/${name}`;
  }

  async function fetchFolderInfo(id: string): Promise<{ name: string; parent: string | null } | null> {
    const params = withSAD(new URLSearchParams({ fields: "id,name,parents" }));
    const res = await driveFetch(`${DRIVE_API}/files/${id}?${params.toString()}`, { headers: await authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Drive get: ${res.status} ${await res.text()}`);
    const f = (await res.json()) as DriveFile;
    return { name: f.name, parent: f.parents?.[0] ?? null };
  }

  // Path of the folder `id` relative to driveRoot ("" for driveRoot
  // itself), or null when its ancestry does not reach driveRoot. Bounded so
  // a cyclic/corrupt parent chain cannot spin forever.
  async function folderPathOf(id: string, depth = 0): Promise<string | null> {
    if (id === driveRoot) return "";
    if (depth >= 64) return null;
    const cached = await folderPaths.get(id);
    if (cached !== undefined) return cached;
    const info = await fetchFolderInfo(id);
    const parentPath =
      info === null || info.parent === null ? null : await folderPathOf(info.parent, depth + 1);
    const path = info === null || parentPath === null ? null : joinPath(parentPath, info.name);
    await folderPaths.set(id, path);
    return path;
  }

  // Path of `f` relative to driveRoot, or null when its ancestry does not
  // reach driveRoot (a loose file elsewhere on the drive, or one under a
  // folder this account cannot read).
  async function pathFor(f: DriveFile): Promise<string | null> {
    const parent = f.parents?.[0] ?? null;
    if (parent === null) return null;
    const parentPath = await folderPathOf(parent);
    return parentPath === null ? null : joinPath(parentPath, f.name);
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
      // Drive's own stable id, persisted as files.remote_file_id so a later
      // rename/move/hard delete can be correlated with the record even
      // though its path changed (#418).
      remote_file_id: f.id,
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
          if (res.status === 404) { await invalidatePrefix(path); return null; }
          throw new Error(`Drive stat: ${res.status} ${await res.text()}`);
        }
        const file = (await res.json()) as DriveFile;
        // Same spelling in either normalization form is the same name.
        const stale =
          file.trashed === true ||
          (expectedName !== null &&
            file.name !== undefined &&
            file.name.normalize("NFC") !== expectedName.normalize("NFC"));
        if (!stale) return fileRefFrom(file, path);
        // The object behind this path is not the one the path names. Drop
        // the cached mapping (and anything under it, if this is a folder)
        // and, if that mapping is what we just used, resolve again from
        // Drive -- a fresh search may find the real object at this path.
        await invalidatePrefix(path);
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
      await invalidatePrefix(path);
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
      await invalidatePrefix(from);
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

    // Content search via Drive's full-text index. Drive answers with flat
    // file objects (no paths), so each hit's path is rebuilt by walking its
    // `parents` chain up to the remote root; a hit whose ancestry never
    // reaches the root (a loose file elsewhere on the drive, or one under a
    // folder this account cannot read) is dropped. Folder lookups are memoised
    // per call: a hundred hits under one node folder cost one files.get per
    // distinct ancestor, not per hit.
    //
    // Drive's search API has no per-hit match snippet the way a local grep
    // does, so bounded-snippet discovery (spec: "Search is discovery, not
    // ingestion") produced no snippet at all here -- the agent had to read
    // every hit in full to judge relevance. snippetFor below fetches a
    // bounded prefix of each hit's content (export to text/plain for
    // Google-native docs/sheets/slides, a byte-range request otherwise) and
    // extracts the line around the query match, same shape as the fs/memory
    // adapter's own snippet. The match may sit outside that bounded prefix
    // (Drive's full-text index covers the whole file, this doesn't) --
    // snippet stays undefined then rather than fetching the whole file.
    async search(query, opts) {
      const limit = Math.max(1, opts?.limit ?? 20);
      const q = `fullText contains '${escapeQ(query)}' and trashed = false`;
      // Bounded prefix of a hit's content to search for the match in --
      // large enough to catch a match near the top of most notes/docs,
      // small enough that a hundred hits stays a cheap round trip each,
      // not a full download. Returns null on any fetch failure, a binary
      // file (NUL byte), or a format with no plain-text export.
      async function snippetSource(f: DriveFile): Promise<string | null> {
        try {
          const native = detectNativeFormat(f.mimeType);
          if (native.is_native_format) {
            const params = new URLSearchParams({ mimeType: "text/plain" });
            const res = await driveFetch(`${DRIVE_API}/files/${f.id}/export?${params.toString()}`, {
              headers: await authHeaders(),
            });
            if (!res.ok) return null;
            return (await res.text()).slice(0, SNIPPET_FETCH_MAX_CHARS);
          }
          const headers = { ...(await authHeaders()), Range: `bytes=0-${SNIPPET_FETCH_MAX_CHARS - 1}` };
          const res = await driveFetch(`${DRIVE_API}/files/${f.id}?alt=media`, { headers });
          if (!res.ok && res.status !== 206) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.includes(0)) return null;
          // Defensive cap: the Range header is a request, not a guarantee --
          // a server (or, in tests, a fake) that ignores it and returns the
          // whole file must not turn this into an unbounded read.
          return buf.subarray(0, SNIPPET_FETCH_MAX_CHARS).toString("utf8");
        } catch {
          return null;
        }
      }
      function extractSnippet(text: string): string | undefined {
        const at = text.toLowerCase().indexOf(query.toLowerCase());
        if (at < 0) return undefined;
        const lineStart = text.lastIndexOf("\n", at) + 1;
        const lineEndRaw = text.indexOf("\n", at);
        const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
        return text.slice(lineStart, Math.min(lineEnd, lineStart + SEARCH_SNIPPET_MAX_CHARS)).trim();
      }
      const out: SearchHit[] = [];
      const seen = new Set<string>();
      let pageToken: string | undefined;
      let examined = 0;
      do {
        const params = withCorpora(withSAD(new URLSearchParams({
          q,
          fields: "nextPageToken,files(id,name,mimeType,modifiedTime,parents)",
          includeItemsFromAllDrives: "true",
          pageSize: "100",
        })));
        if (pageToken) params.set("pageToken", pageToken);
        const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`, { headers: await authHeaders() });
        if (!res.ok) throw new Error(`Drive search: ${res.status} ${await res.text()}`);
        const b = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
        // Path resolution stays sequential (seen-dedup + the memoized
        // ancestor walk both depend on processing hits in order), but only
        // resolves as many as still fit under `limit` this page. Snippet
        // fetches for the resolved candidates then run with bounded
        // concurrency instead of one at a time (#211 cleanup).
        const candidates: Array<{ file: DriveFile; path: string }> = [];
        for (const f of b.files ?? []) {
          examined++;
          if (isFolder(f)) continue;
          const path = await pathFor(f);
          if (path === null || seen.has(path)) continue;
          seen.add(path);
          candidates.push({ file: f, path });
          if (out.length + candidates.length >= limit) break;
        }
        const snippets = await mapWithConcurrency(
          candidates,
          SNIPPET_FETCH_CONCURRENCY,
          async ({ file }) => {
            const source = await snippetSource(file);
            return source ? extractSnippet(source) : undefined;
          },
        );
        for (let i = 0; i < candidates.length; i++) {
          const { file, path } = candidates[i];
          out.push({
            path,
            name: file.name,
            mimeType: file.mimeType,
            modifiedTime: file.modifiedTime,
            snippet: snippets[i],
          });
        }
        if (out.length >= limit) return out;
        pageToken = b.nextPageToken;
        // Stop paging once enough raw hits were examined: a query that
        // matches thousands of files elsewhere on the drive must not turn
        // into an unbounded crawl looking for ones under our root.
      } while (pageToken && examined < 500);
      return out;
    },

    // Incremental change feed over Drive's Changes API. Reports what changed
    // anywhere on the drive since `cursor`; everything whose ancestry does
    // not reach driveRoot is dropped here, so a caller only ever sees paths
    // that join on files.remote_path. `cursor` null answers with a fresh
    // start page token and no changes -- the caller baselines with a full
    // sweep (spec: docs/superpowers/specs/2026-09-12-remote-watcher-design.md).
    async changes(cursor): Promise<RemoteChanges> {
      const changesParams = (extra: Record<string, string>): URLSearchParams => {
        const params = withSAD(new URLSearchParams(extra));
        // changes.list/getStartPageToken take driveId directly; `corpora`
        // (what withCorpora adds for files.list) is not a parameter here and
        // Drive rejects the request outright with it.
        if (cfg.shared_drive_id) params.set("driveId", cfg.shared_drive_id);
        return params;
      };

      const startPageToken = async (): Promise<string> => {
        const res = await driveFetch(
          `${DRIVE_API}/changes/startPageToken?${changesParams({}).toString()}`,
          { headers: await authHeaders() },
        );
        if (!res.ok) throw new Error(`Drive changes start token: ${res.status} ${await res.text()}`);
        const b = (await res.json()) as { startPageToken?: string };
        if (!b.startPageToken) throw new Error("Drive changes start token: response carried no startPageToken");
        return b.startPageToken;
      };

      if (cursor === null) return { cursor: await startPageToken(), changes: [], reset: false };

      // A folder in a change batch is the one thing that can make the
      // ancestor memo wrong: the change itself carries the folder's current
      // name and parent, so refresh the entry from it instead of dropping
      // the whole memo and re-walking every ancestor over the network.
      const rememberFolder = async (f: DriveFile): Promise<void> => {
        const previous = await folderPaths.get(f.id);
        const parent = f.parents?.[0] ?? null;
        const parentPath = parent === null ? null : await folderPathOf(parent);
        const path = parentPath === null ? null : joinPath(parentPath, f.name);
        // A rename or a move leaves every descendant's cached path stale;
        // drop the old subtree in both tiers and let the misses refill.
        if (typeof previous === "string" && previous !== path) {
          await folderPaths.invalidateSubtree(previous);
        }
        await folderPaths.set(f.id, path);
      };

      // A removed folder: drop its own entry and everything under it, same
      // path-keyed invalidation. A hard delete carries no metadata, so the
      // id is looked up first -- one that neither tier knows was never a
      // cached folder and there is nothing to drop.
      const forgetFolder = async (id: string): Promise<void> => {
        const known = await folderPaths.get(id);
        if (typeof known === "string") await folderPaths.invalidateSubtree(known);
        else folderPaths.forgetMemo(id);
      };

      const toRemoteChange = async (c: DriveChangeItem): Promise<RemoteChange | null> => {
        const fileId = c.fileId ?? c.file?.id;
        if (!fileId) return null; // a drive-level change, not a file
        const f = c.file;
        // A hard delete carries no file metadata at all; a trash carries it
        // with trashed = true. Both are a remove.
        if (c.removed === true || f === undefined || f.trashed === true) {
          if (f === undefined || isFolder(f)) await forgetFolder(fileId);
          const path = f !== undefined ? await pathFor(f) : null;
          return { kind: "remove", path, file_id: fileId };
        }
        const folder = isFolder(f);
        if (folder) await rememberFolder(f);
        const path = await pathFor(f);
        if (path === null) return null; // outside driveRoot: not ours
        return {
          kind: "upsert",
          path,
          hash: f.md5Checksum ?? null,
          modified_at: f.modifiedTime ? new Date(f.modifiedTime) : new Date(0),
          is_folder: folder,
          // Same id the record carries as remote_file_id (#418): a rename or
          // move arrives as an upsert at a NEW path under the SAME id, which
          // is the only thing that tells it apart from a brand-new file.
          file_id: fileId,
        };
      };

      const out: RemoteChange[] = [];
      let pageToken: string | null = cursor;
      let nextCursor: string | null = null;
      for (let page = 0; page < CHANGES_MAX_PAGES && pageToken !== null; page++) {
        const params = changesParams({
          pageToken,
          pageSize: "100",
          includeItemsFromAllDrives: "true",
          includeRemoved: "true",
          fields: "newStartPageToken,nextPageToken,changes(fileId,removed,file(id,name,mimeType,parents,md5Checksum,modifiedTime,trashed))",
        });
        const res = await driveFetch(`${DRIVE_API}/changes?${params.toString()}`, { headers: await authHeaders() });
        // Drive answers an expired or otherwise invalid page token with 410
        // (and 404 for one it has never seen). Nothing in this batch is a
        // complete account of what happened: hand back a fresh start token
        // and let the caller full-sweep.
        if (res.status === 410 || res.status === 404) {
          // Nothing cached about this remote's folder tree is provably
          // current any more, and the full sweep that follows a reset
          // refills it (#419).
          await folderPaths.clear();
          return { cursor: await startPageToken(), changes: [], reset: true };
        }
        if (!res.ok) throw new Error(`Drive changes: ${res.status} ${await res.text()}`);
        const b = (await res.json()) as {
          changes?: DriveChangeItem[];
          nextPageToken?: string;
          newStartPageToken?: string;
        };
        // Sequential on purpose: the ancestor memo turns a whole page under
        // one node folder into a single files.get, which only holds when the
        // entries are resolved one after another.
        for (const c of b.changes ?? []) {
          const change = await toRemoteChange(c);
          if (change) out.push(change);
        }
        if (b.nextPageToken) {
          pageToken = b.nextPageToken;
          nextCursor = b.nextPageToken; // resume here if the page cap hits
          continue;
        }
        nextCursor = b.newStartPageToken ?? pageToken;
        pageToken = null;
      }
      return { cursor: nextCursor ?? cursor, changes: out, reset: false };
    },
  };

  return adapter;
}
