// Clear pending_file_ops rows that can never complete.
//
// A half-finished move records its intent in pending_file_ops so the next sync
// run can retry it idempotently. That works while the retry still has
// something to act on. It does not when the original files row is gone AND no
// record sits at the source path any more: the move already happened at the
// record level (a new row was created at the destination), so the retry has
// nothing to move and refuses to guess between the old id and the new one.
// The row then retries forever and shows up as "nedokončeno N" on every run.
//
// Deletes ONLY rows where both are true:
//   - the op's own file_id no longer exists in `files`, and
//   - no record occupies the op's source remote_path.
// Anything else is left alone and printed, because something is still live.
//
// Dry run by default. Pass --apply to delete. Requires TURSO_URL +
// TURSO_AUTH_TOKEN in the environment (the production values live in
// /opt/portuni/portuni.env on the VPS).
//
//   node --import tsx scripts/clear-dead-pending-ops.ts            # dry run
//   node --import tsx scripts/clear-dead-pending-ops.ts --apply

import { getDb } from "../apps/server/infra/db.js";

interface MovePayload {
  filename?: string;
  from_remote_path?: string;
  to_remote_path?: string;
}

async function main(): Promise<void> {
  if (!process.env.TURSO_URL?.trim()) {
    throw new Error(
      "TURSO_URL is not set -- refusing to touch the local fallback database. " +
        "Point TURSO_URL/TURSO_AUTH_TOKEN at the database you mean to repair.",
    );
  }
  const apply = process.argv.includes("--apply");
  const db = getDb();

  const ops = await db.execute(
    "SELECT id, node_id, file_id, payload, attempts, last_error FROM pending_file_ops",
  );
  if (ops.rows.length === 0) {
    console.log("No pending file ops.");
    return;
  }

  const dead: string[] = [];
  for (const o of ops.rows) {
    const p = JSON.parse(String(o.payload)) as MovePayload;
    const name = p.filename ?? "(unnamed)";
    const [record, atSource] = await Promise.all([
      db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [o.file_id as string] }),
      db.execute({
        sql: "SELECT id FROM files WHERE node_id = ? AND remote_path = ?",
        args: [o.node_id as string, p.from_remote_path ?? ""],
      }),
    ]);
    const atDest = await db.execute({
      sql: "SELECT id FROM files WHERE node_id = ? AND remote_path = ?",
      args: [o.node_id as string, p.to_remote_path ?? ""],
    });

    if (record.rows.length === 0 && atSource.rows.length === 0) {
      dead.push(o.id as string);
      const where = atDest.rows.length > 0 ? "destination already registered" : "nothing anywhere";
      console.log(`dead  ${name.padEnd(30)} ${String(o.attempts).padStart(2)}x  ${where}`);
    } else {
      console.log(`KEEP  ${name.padEnd(30)} ${String(o.attempts).padStart(2)}x  something is still live`);
    }
  }

  if (dead.length === 0) {
    console.log("\nNothing to clear.");
    return;
  }
  if (!apply) {
    console.log(`\nDry run: ${dead.length} row(s) would be deleted. Re-run with --apply.`);
    return;
  }
  for (const id of dead) {
    await db.execute({ sql: "DELETE FROM pending_file_ops WHERE id = ?", args: [id] });
  }
  console.log(`\nDeleted ${dead.length} dead pending op(s).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
