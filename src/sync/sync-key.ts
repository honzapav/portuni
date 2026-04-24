import type { Client } from "@libsql/client";
import { ulid } from "ulid";

export function slugifyForSyncKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function isTaken(db: Client, key: string): Promise<boolean> {
  const r = await db.execute({ sql: "SELECT 1 FROM nodes WHERE sync_key = ? LIMIT 1", args: [key] });
  return r.rows.length > 0;
}

export async function generateSyncKey(db: Client, name: string): Promise<string> {
  const base = slugifyForSyncKey(name);
  if (base.length > 0 && !(await isTaken(db, base))) return base;
  const suffix = ulid().toLowerCase().slice(-8);
  const candidate = base.length > 0 ? `${base}-${suffix}` : suffix;
  if (await isTaken(db, candidate)) return `${candidate}-${ulid().toLowerCase().slice(-4)}`;
  return candidate;
}
