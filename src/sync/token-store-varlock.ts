import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TokenStore } from "./token-store.js";
import type { DeviceToken } from "./types.js";
import { TOKEN_ENV_PREFIX } from "./device-tokens.js";

const execFileP = promisify(execFile);
type Field = "ACCESS_TOKEN" | "REFRESH_TOKEN" | "EXPIRES_AT" | "SERVICE_ACCOUNT_JSON";

function envKey(name: string, field: Field): string {
  return `${TOKEN_ENV_PREFIX}${name.toUpperCase().replace(/-/g, "_")}__${field}`;
}

function substituteArgv(template: string[], name: string, field: string, value: string): string[] {
  return template.map((a) =>
    a.replace(/\{name\}/g, name).replace(/\{field\}/g, field).replace(/\{value\}/g, value),
  );
}

export function createVarlockTokenStore(): TokenStore {
  return {
    async read(remoteName) {
      const sa = process.env[envKey(remoteName, "SERVICE_ACCOUNT_JSON")];
      if (sa) return { mode: "service_account", service_account_json: sa };
      const refresh = process.env[envKey(remoteName, "REFRESH_TOKEN")];
      if (!refresh) return null;
      const t: DeviceToken = { mode: "oauth", refresh_token: refresh };
      const access = process.env[envKey(remoteName, "ACCESS_TOKEN")];
      if (access) t.access_token = access;
      const exp = process.env[envKey(remoteName, "EXPIRES_AT")];
      if (exp) t.expires_at = Number(exp);
      return t;
    },
    async write(remoteName, tokens) {
      const program = process.env.PORTUNI_VARLOCK_WRITE_PROGRAM;
      const argsStr = process.env.PORTUNI_VARLOCK_WRITE_ARGS;
      if (!program) {
        throw new Error(
          "VarlockTokenStore.write: set PORTUNI_VARLOCK_WRITE_PROGRAM and PORTUNI_VARLOCK_WRITE_ARGS. Example for 1Password: program='op', args='item edit portuni/{name} {field}={value}'.",
        );
      }
      const argvTemplate = (argsStr ?? "").split(" ").filter(Boolean);
      const fields: Array<[Field, string]> = [];
      if (tokens.service_account_json)
        fields.push(["SERVICE_ACCOUNT_JSON", tokens.service_account_json]);
      if (tokens.refresh_token) fields.push(["REFRESH_TOKEN", tokens.refresh_token]);
      if (tokens.access_token) fields.push(["ACCESS_TOKEN", tokens.access_token]);
      if (tokens.expires_at !== undefined)
        fields.push(["EXPIRES_AT", String(tokens.expires_at)]);
      for (const [field, value] of fields) {
        const argv = substituteArgv(argvTemplate, remoteName, field, value);
        await execFileP(program, argv);
        process.env[envKey(remoteName, field)] = value;
      }
    },
    async delete(remoteName) {
      for (const f of [
        "ACCESS_TOKEN",
        "REFRESH_TOKEN",
        "EXPIRES_AT",
        "SERVICE_ACCOUNT_JSON",
      ] as Field[]) {
        delete process.env[envKey(remoteName, f)];
      }
      const program = process.env.PORTUNI_VARLOCK_DELETE_PROGRAM;
      const argsStr = process.env.PORTUNI_VARLOCK_DELETE_ARGS;
      if (program && argsStr) {
        const argv = argsStr
          .split(" ")
          .filter(Boolean)
          .map((a) => a.replace(/\{name\}/g, remoteName));
        await execFileP(program, argv).catch(() => undefined);
      }
    },
  };
}
