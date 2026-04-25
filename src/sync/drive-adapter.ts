import type { FileAdapter, FileRef, RemoteConfig, DeviceTokens } from "./types.js";
import { parseDriveConfig, parseServiceAccountJson, type ServiceAccountKey, type DriveConfig } from "./drive-config.js";
import { getDriveAccessToken, __setTokenFetchForTests } from "./drive-sa-auth.js";
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

interface DriveFile { id: string; name: string; mimeType: string; parents?: string[]; size?: string; md5Checksum?: string; modifiedTime?: string; }

export function createDriveAdapter(remote: RemoteConfig, tokens: DeviceTokens): FileAdapter {
  const cfg: DriveConfig = parseDriveConfig(remote.config);
  const t = tokens[remote.name];
  if (!t?.service_account_json) {
    throw new Error(`Drive remote ${remote.name}: no service account credentials on this device. Run portuni_setup_remote with service_account_json.`);
  }
  const sa: ServiceAccountKey = parseServiceAccountJson(t.service_account_json);
  const driveRoot = cfg.root_folder_id ?? cfg.shared_drive_id;
  const pathCache = new Map<string, string>([["", driveRoot]]);

  function invalidatePrefix(prefix: string): void {
    if (prefix === "") { pathCache.clear(); pathCache.set("", driveRoot); return; }
    const prefixSlash = `${prefix}/`;
    for (const key of Array.from(pathCache.keys())) {
      if (key === prefix || key.startsWith(prefixSlash)) pathCache.delete(key);
    }
  }

  async function authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await getDriveAccessToken(sa)}` };
  }

  function withSAD(params: URLSearchParams): URLSearchParams {
    params.set("supportsAllDrives", "true");
    return params;
  }

  async function resolvePathToFileId(path: string): Promise<string | null> {
    if (pathCache.has(path)) return pathCache.get(path)!;
    const segments = path.split("/").filter(Boolean);
    let parentId = driveRoot;
    let walked = "";
    for (const seg of segments) {
      walked = walked ? `${walked}/${seg}` : seg;
      if (pathCache.has(walked)) { parentId = pathCache.get(walked)!; continue; }
      const q = `name = '${seg.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed = false`;
      const params = withSAD(new URLSearchParams({
        q, fields: "files(id,name,mimeType)",
        includeItemsFromAllDrives: "true",
        driveId: cfg.shared_drive_id, corpora: "drive",
      }));
      const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`, { headers: await authHeaders() });
      if (!res.ok) throw new Error(`Drive list: ${res.status} ${await res.text()}`);
      const b = (await res.json()) as { files?: DriveFile[] };
      const hit = b.files?.[0];
      if (!hit) return null;
      parentId = hit.id;
      pathCache.set(walked, parentId);
    }
    return parentId;
  }

  async function ensureFolderPath(path: string): Promise<string> {
    const segments = path.split("/").filter(Boolean);
    let parentId = driveRoot;
    let walked = "";
    for (const seg of segments) {
      walked = walked ? `${walked}/${seg}` : seg;
      if (pathCache.has(walked)) { parentId = pathCache.get(walked)!; continue; }
      const q = `name = '${seg.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const params = withSAD(new URLSearchParams({
        q, fields: "files(id,name)",
        includeItemsFromAllDrives: "true",
        driveId: cfg.shared_drive_id, corpora: "drive",
      }));
      const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`, { headers: await authHeaders() });
      if (!res.ok) throw new Error(`Drive folder search: ${res.status} ${await res.text()}`);
      const b = (await res.json()) as { files?: DriveFile[] };
      if (b.files?.[0]) {
        parentId = b.files[0].id;
      } else {
        const createParams = withSAD(new URLSearchParams());
        const metadata = { name: seg, mimeType: "application/vnd.google-apps.folder", parents: [parentId] };
        const createRes = await driveFetch(`${DRIVE_API}/files?${createParams.toString()}`, {
          method: "POST",
          headers: { ...await authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(metadata),
        });
        if (!createRes.ok) throw new Error(`Drive folder create: ${createRes.status} ${await createRes.text()}`);
        parentId = ((await createRes.json()) as DriveFile).id;
      }
      pathCache.set(walked, parentId);
    }
    return parentId;
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
      const params = withSAD(new URLSearchParams({ uploadType: "multipart" }));
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
      return (await adapter.stat(path))!;
    },

    async get(path) {
      const id = await resolvePathToFileId(path);
      if (!id) throw new Error(`Drive get: file not found at ${path}`);
      const params = withSAD(new URLSearchParams({ alt: "media" }));
      const res = await driveFetch(`${DRIVE_API}/files/${id}?${params.toString()}`, { headers: await authHeaders() });
      if (!res.ok) throw new Error(`Drive get: ${res.status} ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    },

    async stat(path) {
      const id = await resolvePathToFileId(path);
      if (!id) return null;
      const params = withSAD(new URLSearchParams({ fields: "id,name,mimeType,size,md5Checksum,modifiedTime,parents" }));
      const res = await driveFetch(`${DRIVE_API}/files/${id}?${params.toString()}`, { headers: await authHeaders() });
      if (!res.ok) {
        if (res.status === 404) { pathCache.delete(path); return null; }
        throw new Error(`Drive stat: ${res.status} ${await res.text()}`);
      }
      return fileRefFrom((await res.json()) as DriveFile, path);
    },

    async list(prefix) {
      const rootId = await resolvePathToFileId(prefix.replace(/\/$/, ""));
      if (!rootId) return [];
      const out: FileRef[] = [];
      async function walk(folderId: string, prefixPath: string): Promise<void> {
        let pageToken: string | undefined;
        do {
          const params = withSAD(new URLSearchParams({
            q: `'${folderId}' in parents and trashed = false`,
            fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)",
            includeItemsFromAllDrives: "true",
            driveId: cfg.shared_drive_id, corpora: "drive",
            pageSize: "200",
          }));
          if (pageToken) params.set("pageToken", pageToken);
          const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`, { headers: await authHeaders() });
          if (!res.ok) throw new Error(`Drive list: ${res.status} ${await res.text()}`);
          const b = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
          for (const f of b.files ?? []) {
            const childPath = prefixPath ? `${prefixPath}/${f.name}` : f.name;
            if (f.mimeType === "application/vnd.google-apps.folder") {
              pathCache.set(childPath, f.id);
              await walk(f.id, childPath);
            } else {
              out.push(fileRefFrom(f, childPath));
            }
          }
          pageToken = b.nextPageToken;
        } while (pageToken);
      }
      await walk(rootId, prefix.replace(/\/$/, ""));
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
      const fromParts = from.split("/"); fromParts.pop();
      const toParts = to.split("/"); const newName = toParts.pop()!;
      const newFolderPath = toParts.join("/");
      const newParentId = await ensureFolderPath(newFolderPath);
      const oldParentPath = fromParts.join("/");
      const oldParentId = await resolvePathToFileId(oldParentPath) ?? driveRoot;
      const params = withSAD(new URLSearchParams({
        addParents: newParentId, removeParents: oldParentId,
        fields: "id,name,parents",
      }));
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
