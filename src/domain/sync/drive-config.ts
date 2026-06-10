import type { RemoteConfig } from "./types.js";

export interface DriveConfig {
  shared_drive_id: string;
  root_folder_id?: string;
}

export function parseDriveConfig(raw: Record<string, unknown>): DriveConfig {
  const sd = raw.shared_drive_id;
  if (typeof sd !== "string" || sd.length === 0) {
    throw new Error("Drive config requires shared_drive_id. Personal My Drive is not supported.");
  }
  const out: DriveConfig = { shared_drive_id: sd };
  if (typeof raw.root_folder_id === "string" && raw.root_folder_id.length > 0) {
    out.root_folder_id = raw.root_folder_id;
  }
  return out;
}

export function isDriveRemote(r: RemoteConfig): boolean { return r.type === "gdrive"; }

export interface ServiceAccountKey {
  type: "service_account";
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
  private_key_id?: string;
  client_id?: string;
}

const SA_REQUIRED: Array<keyof ServiceAccountKey> = ["client_email", "private_key", "token_uri"];

// token_uri receives a JWT *signed with the service-account private key*.
// Sending that assertion anywhere but Google's OAuth endpoint hands an
// attacker a replayable token grant, so the host is allowlisted (classic
// SSRF defense -- the value comes from a user-supplied JSON blob).
const ALLOWED_TOKEN_URI_HOSTS = new Set(["oauth2.googleapis.com", "accounts.google.com"]);

export function assertSafeTokenUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Service account JSON: token_uri is not a valid URL (${uri})`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Service account JSON: token_uri must be https");
  }
  if (!ALLOWED_TOKEN_URI_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Service account JSON: token_uri host '${parsed.hostname}' is not a Google OAuth endpoint`,
    );
  }
}

export function parseServiceAccountJson(raw: string): ServiceAccountKey {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(raw) as Record<string, unknown>; }
  catch (e) { throw new Error(`Invalid service account JSON: ${(e as Error).message}`); }
  if (obj.type !== "service_account") throw new Error("Service account JSON: type must be 'service_account'");
  for (const f of SA_REQUIRED) {
    if (typeof obj[f] !== "string" || (obj[f] as string).length === 0) {
      throw new Error(`Service account JSON: missing required field '${f}'`);
    }
  }
  assertSafeTokenUri(obj.token_uri as string);
  return {
    type: "service_account",
    client_email: obj.client_email as string,
    private_key: obj.private_key as string,
    token_uri: obj.token_uri as string,
    project_id: obj.project_id as string | undefined,
    private_key_id: obj.private_key_id as string | undefined,
    client_id: obj.client_id as string | undefined,
  };
}

