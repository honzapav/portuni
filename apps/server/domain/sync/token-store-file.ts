import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { TokenStore } from "./token-store.js";
import type { DeviceToken } from "./types.js";

function tokensPath(): string {
  const root = process.env.PORTUNI_WORKSPACE_ROOT;
  if (!root) throw new Error("PORTUNI_WORKSPACE_ROOT must be set for FileTokenStore");
  const expanded = root.replace(/^~(?=$|\/)/, homedir());
  return join(expanded, ".portuni", "tokens.json");
}

async function readMap(): Promise<Record<string, DeviceToken>> {
  const p = tokensPath();
  try {
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw) as Record<string, DeviceToken>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

async function writeMap(map: Record<string, DeviceToken>): Promise<void> {
  const p = tokensPath();
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    /* platforms without chmod semantics */
  }
  await rename(tmp, p);
  try {
    await chmod(p, 0o600);
  } catch {
    /* ok */
  }
}

export function createFileTokenStore(): TokenStore {
  return {
    async read(name) {
      const m = await readMap();
      return m[name] ?? null;
    },
    async write(name, token) {
      const m = await readMap();
      m[name] = token;
      await writeMap(m);
    },
    async delete(name) {
      const m = await readMap();
      delete m[name];
      await writeMap(m);
    },
  };
}
