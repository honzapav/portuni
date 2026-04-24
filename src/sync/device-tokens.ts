import type { DeviceTokens, DeviceToken } from "./types.js";

export const TOKEN_ENV_PREFIX = "PORTUNI_REMOTE_";

function envKey(
  name: string,
  field: "REFRESH_TOKEN" | "ACCESS_TOKEN" | "EXPIRES_AT" | "SERVICE_ACCOUNT_JSON",
): string {
  return `${TOKEN_ENV_PREFIX}${name.toUpperCase().replace(/-/g, "_")}__${field}`;
}

export async function readDeviceTokens(remoteNames: string[]): Promise<DeviceTokens> {
  const out: DeviceTokens = {};
  for (const name of remoteNames) {
    const sa = process.env[envKey(name, "SERVICE_ACCOUNT_JSON")];
    if (sa) {
      out[name] = { mode: "service_account", service_account_json: sa };
      continue;
    }
    const refresh = process.env[envKey(name, "REFRESH_TOKEN")];
    if (!refresh) continue;
    const t: DeviceToken = { mode: "oauth", refresh_token: refresh };
    const access = process.env[envKey(name, "ACCESS_TOKEN")];
    if (access) t.access_token = access;
    const exp = process.env[envKey(name, "EXPIRES_AT")];
    if (exp) t.expires_at = Number(exp);
    out[name] = t;
  }
  return out;
}
