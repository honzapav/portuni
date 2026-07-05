import type { Client } from "@libsql/client";
import type { DeviceToken, RemoteType } from "./types.js";
import {
  upsertRemote,
  getRemote,
  listRemotes,
  deleteRemote,
  addRule,
  listRules,
  replaceRules,
  type RoutingRule,
} from "./routing.js";
import { readDeviceTokens } from "./device-tokens.js";
import { getTokenStore } from "./token-store.js";
import { invalidateAdapter } from "./adapter-cache.js";
import { parseDriveConfig } from "./drive-config.js";
import { getUserAccessToken, DriveAuthError } from "./drive-user-auth.js";

export class DriveNotConnectedError extends Error {
  constructor(message: string) { super(message); this.name = "DriveNotConnectedError"; }
}

export interface SetupRemoteArgs {
  userId: string;
  name: string;
  type: "fs" | "gdrive" | "dropbox" | "s3" | "webdav" | "sftp";
  config: Record<string, unknown>;
  service_account_json?: string;
}

export async function setupRemoteService(db: Client, a: SetupRemoteArgs): Promise<void> {
  if (a.type === "fs") {
    if (typeof a.config.root !== "string") {
      throw new Error("fs remote requires config.root as a string");
    }
  }
  if (a.type === "gdrive") {
    const { parseDriveConfig, parseServiceAccountJson } = await import("./drive-config.js");
    parseDriveConfig(a.config);
    if (!a.service_account_json) {
      throw new Error("gdrive remote requires service_account_json");
    }
    parseServiceAccountJson(a.service_account_json);
    const { getTokenStore } = await import("./token-store.js");
    const store = await getTokenStore();
    await store.write(a.name, {
      mode: "service_account",
      service_account_json: a.service_account_json,
    });
  }
  await upsertRemote(db, {
    name: a.name,
    type: a.type,
    config: a.config,
    created_by: a.userId,
  });
  // Drop cached adapter so the next request rebuilds with fresh config/tokens.
  invalidateAdapter(a.name);
}

export async function setRoutingPolicyService(
  db: Client,
  rules: RoutingRule[],
): Promise<void> {
  await replaceRules(db, rules);
}

export interface RemoteListing {
  name: string;
  type: string;
  authenticated: boolean;
}

export async function listRemotesService(db: Client): Promise<RemoteListing[]> {
  const remotes = await listRemotes(db);
  const tokens = await readDeviceTokens(remotes.map((r) => r.name));
  return remotes.map((r) => ({
    name: r.name,
    type: r.type,
    authenticated: (() => {
      if (r.type === "fs") return true;
      const t = tokens[r.name];
      if (!t) return false;
      if (r.type === "gdrive") return Boolean(t.service_account_json);
      return Boolean(t.refresh_token);
    })(),
  }));
}

export const GDRIVE_REMOTE = "gdrive";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const MY_DRIVE_TARGET_NAME = "Můj disk – složka Portuni";

let restFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export function __setDriveRestFetchForTests(f: typeof fetch): void { restFetch = f; }

async function driveGet(path: string, token: string): Promise<Response> {
  return restFetch(`${DRIVE_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function drivePost(path: string, token: string, body: unknown): Promise<Response> {
  return restFetch(`${DRIVE_API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readGdriveToken(): Promise<DeviceToken | null> {
  const t = await (await getTokenStore()).read(GDRIVE_REMOTE);
  return t?.mode === "refresh_token" ? t : null;
}

interface DriveInfo { id: string; name: string }

async function listSharedDrivesWith(token: DeviceToken): Promise<DriveInfo[]> {
  const accessToken = await getUserAccessToken(token);
  const params = new URLSearchParams({ pageSize: "100", fields: "drives(id,name)" });
  const res = await driveGet(`/drives?${params.toString()}`, accessToken);
  if (!res.ok) throw new Error(`Drive drives.list: ${res.status} ${await res.text()}`);
  const b = (await res.json()) as { drives?: DriveInfo[] };
  return b.drives ?? [];
}

async function ensureMyDrivePortuniFolder(accessToken: string): Promise<string> {
  const q = "name='Portuni' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false";
  const params = new URLSearchParams({ q, fields: "files(id,name)" });
  const res = await driveGet(`/files?${params.toString()}`, accessToken);
  if (!res.ok) throw new Error(`Drive folder search: ${res.status} ${await res.text()}`);
  const b = (await res.json()) as { files?: DriveInfo[] };
  if (b.files?.[0]) return b.files[0].id;
  const created = await drivePost("/files", accessToken, {
    name: "Portuni",
    mimeType: "application/vnd.google-apps.folder",
  });
  if (!created.ok) throw new Error(`Drive folder create: ${created.status} ${await created.text()}`);
  return ((await created.json()) as { id: string }).id;
}

export interface ConnectDriveArgs {
  userId: string;
  refresh_token: string;
  client_id: string;
  client_secret: string;
  account_email: string;
}

export interface SetDriveTargetArgs {
  userId: string;
  shared_drive_id?: string;
  my_drive?: boolean;
}

export interface DriveTargetInfo {
  kind: "my_drive" | "shared_drive";
  name: string;
}

export interface DriveStatus {
  configured: boolean;
  connected: boolean;
  account_email: string | null;
  target: DriveTargetInfo | null;
}

export type TestDriveResult =
  | { ok: true }
  | { ok: false; code: "TOKEN_INVALID" | "TARGET_NOT_FOUND" | "DRIVE_UNREACHABLE"; detail: string };

export async function connectDrive(
  _db: Client,
  a: ConnectDriveArgs,
): Promise<{ account_email: string; shared_drives: DriveInfo[] }> {
  const token: DeviceToken = {
    mode: "refresh_token",
    refresh_token: a.refresh_token,
    client_id: a.client_id,
    client_secret: a.client_secret,
    account_email: a.account_email,
  };
  await (await getTokenStore()).write(GDRIVE_REMOTE, token);
  invalidateAdapter(GDRIVE_REMOTE);
  // A drives.list failure here does not roll back the token write above --
  // the user simply resumes at target selection on retry.
  const shared_drives = await listSharedDrivesWith(token);
  return { account_email: a.account_email, shared_drives };
}

export async function listDriveTargets(): Promise<DriveInfo[] | null> {
  const token = await readGdriveToken();
  if (!token) return null;
  return listSharedDrivesWith(token);
}

export async function setDriveTarget(
  db: Client,
  a: SetDriveTargetArgs,
): Promise<{ target: DriveTargetInfo }> {
  const token = await readGdriveToken();
  if (!token) throw new DriveNotConnectedError("Google Drive not connected");

  let config: Record<string, unknown>;
  let target: DriveTargetInfo;
  if (a.my_drive) {
    const accessToken = await getUserAccessToken(token);
    const root_folder_id = await ensureMyDrivePortuniFolder(accessToken);
    config = { root_folder_id, target_name: MY_DRIVE_TARGET_NAME };
    target = { kind: "my_drive", name: MY_DRIVE_TARGET_NAME };
  } else if (a.shared_drive_id) {
    const drives = await listSharedDrivesWith(token);
    const name = drives.find((d) => d.id === a.shared_drive_id)?.name ?? a.shared_drive_id;
    config = { shared_drive_id: a.shared_drive_id, target_name: name };
    target = { kind: "shared_drive", name };
  } else {
    throw new Error("setDriveTarget requires shared_drive_id or my_drive");
  }

  await upsertRemote(db, { name: GDRIVE_REMOTE, type: "gdrive" as RemoteType, config, created_by: a.userId });
  if ((await listRules(db)).length === 0) {
    await addRule(db, { priority: 1, node_type: null, org_slug: null, remote_name: GDRIVE_REMOTE });
  }
  invalidateAdapter(GDRIVE_REMOTE);
  return { target };
}

function targetFromConfig(config: Record<string, unknown>): DriveTargetInfo | null {
  if (typeof config.root_folder_id === "string") {
    return { kind: "my_drive", name: typeof config.target_name === "string" ? config.target_name : MY_DRIVE_TARGET_NAME };
  }
  if (typeof config.shared_drive_id === "string") {
    return { kind: "shared_drive", name: typeof config.target_name === "string" ? config.target_name : "" };
  }
  return null;
}

export async function driveStatus(db: Client): Promise<DriveStatus> {
  const remote = await getRemote(db, GDRIVE_REMOTE);
  const token = await readGdriveToken();
  return {
    configured: Boolean(remote) && Boolean(token),
    connected: Boolean(token),
    account_email: token?.account_email ?? null,
    target: remote ? targetFromConfig(remote.config) : null,
  };
}

export async function testDrive(db: Client): Promise<TestDriveResult> {
  const remote = await getRemote(db, GDRIVE_REMOTE);
  if (!remote) return { ok: false, code: "TARGET_NOT_FOUND", detail: "gdrive not configured" };
  const token = await readGdriveToken();
  if (!token) return { ok: false, code: "TOKEN_INVALID", detail: "gdrive not connected" };

  const cfg = parseDriveConfig(remote.config);
  let accessToken: string;
  try {
    accessToken = await getUserAccessToken(token);
  } catch (e) {
    if (e instanceof DriveAuthError) return { ok: false, code: "TOKEN_INVALID", detail: e.message };
    return { ok: false, code: "DRIVE_UNREACHABLE", detail: (e as Error).message };
  }

  const root = cfg.root_folder_id ?? cfg.shared_drive_id!;
  const params = new URLSearchParams({ q: `'${root}' in parents and trashed=false`, pageSize: "1" });
  if (cfg.shared_drive_id) {
    params.set("driveId", cfg.shared_drive_id);
    params.set("corpora", "drive");
    params.set("supportsAllDrives", "true");
    params.set("includeItemsFromAllDrives", "true");
  }

  try {
    const res = await driveGet(`/files?${params.toString()}`, accessToken);
    if (res.status === 404) return { ok: false, code: "TARGET_NOT_FOUND", detail: await res.text() };
    if (!res.ok) return { ok: false, code: "DRIVE_UNREACHABLE", detail: `${res.status} ${await res.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: "DRIVE_UNREACHABLE", detail: (e as Error).message };
  }
}

export async function disconnectDrive(db: Client): Promise<void> {
  const rules = await listRules(db);
  await replaceRules(db, rules.filter((r) => r.remote_name !== GDRIVE_REMOTE));
  await deleteRemote(db, GDRIVE_REMOTE);
  await (await getTokenStore()).delete(GDRIVE_REMOTE);
  invalidateAdapter(GDRIVE_REMOTE);
}
