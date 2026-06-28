import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, statusScan } from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";

// Czech filenames arrive in two byte forms: NFC ("ř" as one codepoint) from
// most apps, NFD ("r" + combining hacek) from Finder drag-drop, some pickers
// and HFS+-era tooling. APFS lookups are normalization-insensitive but
// readdir preserves stored bytes, so byte-wise comparisons split one logical
// file into two identities -- duplicate uploads, or worse: copyFile onto
// "another" path that is physically the same file truncates it to zero.

const NFC_NAME = "P\u0159\u00EDloha.md"; // P-r(hacek)-i(acute)-loha, composed
const NFD_NAME = NFC_NAME.normalize("NFD"); // decomposed byte form

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-nfc-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("unicode normalization on sync paths", () => {
  it("storeFile normalizes filename and remote_path to NFC", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, NFD_NAME);
    await writeFile(src, "obsah");

    const r = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    assert.ok(
      r.remote_path.endsWith(`/${NFC_NAME}`),
      `remote_path must be NFC, got ${JSON.stringify(r.remote_path)}`,
    );
    const row = await db.execute({
      sql: "SELECT filename FROM files WHERE id = ?",
      args: [r.file_id],
    });
    assert.equal(row.rows[0].filename, NFC_NAME);
  });

  it("storeFile does not truncate an NFD-named file already inside the mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const src = join(mirrorRoot, "wip", NFD_NAME);
    await writeFile(src, "nesmazat");

    const r = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    // The store must succeed and the content must survive -- on APFS the
    // NFC mirror target IS the NFD source file, and a blind copyFile would
    // truncate it before reading.
    assert.equal(await readFile(src, "utf-8"), "nesmazat");
    assert.equal(await readFile(r.local_path, "utf-8"), "nesmazat");
  });

  it("statusScan does not rediscover a tracked NFD-named file as new_local", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const src = join(mirrorRoot, "wip", NFD_NAME);
    await writeFile(src, "obsah");
    await storeFile(db, { userId: "U1", nodeId, localPath: src });

    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    const dupes = scan.new_local.filter(
      (e) => e.filename.normalize("NFC") === NFC_NAME,
    );
    assert.equal(
      dupes.length,
      0,
      `tracked file must not reappear as new_local: ${JSON.stringify(dupes)}`,
    );
  });
});
