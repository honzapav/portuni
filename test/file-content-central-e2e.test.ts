// Phase B central file-content END-TO-END against a REAL Google Drive remote.
//
// This is the test that proves a central-mode teammate can create/read/edit/
// delete file BYTES through the server without a local mirror. It drives the
// exact REST seam a JWT central client hits (routeApiRequest with a
// google-via identity -- JWT verification happens upstream in the HTTP server
// and is out of scope here) against the real Drive adapter.
//
// GATED: it auto-SKIPS unless the Drive Service Account secret + a test config
// are present in the environment, so it never reds CI. It auto-RUNS once the
// VPS secret from the "provision Drive SA on VPS" task is provisioned (or when
// a developer exports the same vars locally). Required env:
//
//   PORTUNI_E2E_DRIVE_REMOTE_NAME        e.g. "drive-prod"
//   PORTUNI_E2E_DRIVE_SHARED_DRIVE_ID    the Shared Drive id
//   PORTUNI_E2E_DRIVE_ROOT_FOLDER_ID     (optional) subfolder id to scope under
//   PORTUNI_REMOTE_<NAME>__SERVICE_ACCOUNT_JSON   the Drive SA key JSON
//        (<NAME> = remote name upper-cased, "-" -> "_")
//
// The test reads/writes a unique file under wip/ and deletes it on the way out,
// so repeated runs stay clean.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { createClient, type Client } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { upsertRemote, replaceRules } from "../apps/server/domain/sync/routing.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { resetTokenStoreForTests } from "../apps/server/domain/sync/token-store.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

const REMOTE_NAME = process.env.PORTUNI_E2E_DRIVE_REMOTE_NAME;
const SHARED_DRIVE_ID = process.env.PORTUNI_E2E_DRIVE_SHARED_DRIVE_ID;
const ROOT_FOLDER_ID = process.env.PORTUNI_E2E_DRIVE_ROOT_FOLDER_ID;

function saEnvKey(name: string): string {
  return `PORTUNI_REMOTE_${name.toUpperCase().replace(/-/g, "_")}__SERVICE_ACCOUNT_JSON`;
}

// Returns a skip reason string when the e2e prerequisites are absent, or
// false when everything needed is present (so the test should run).
function e2eSkip(): string | false {
  if (!REMOTE_NAME) return "set PORTUNI_E2E_DRIVE_REMOTE_NAME to run the central Drive e2e";
  if (!SHARED_DRIVE_ID) return "set PORTUNI_E2E_DRIVE_SHARED_DRIVE_ID to run the central Drive e2e";
  if (!process.env[saEnvKey(REMOTE_NAME)]) {
    return `set ${saEnvKey(REMOTE_NAME)} (Drive Service Account JSON) to run the central Drive e2e`;
  }
  return false;
}

interface Captured {
  statusCode: number;
  body: string;
}

function central(): RequestIdentity {
  // Post-JWT-verification central identity. routeApiRequest takes the already
  // -verified identity; "via: google" marks the brokered transport.
  return {
    userId: "U1",
    email: "teammate@workflow.ooo",
    name: "Teammate",
    globalScope: "admin",
    groups: [],
    via: "google",
  };
}

async function call(
  db: Client,
  method: string,
  pathWithQuery: string,
  bodyJson?: unknown,
): Promise<Captured> {
  void db;
  const captured: Captured = { statusCode: 0, body: "" };
  const bodyStr = bodyJson !== undefined ? JSON.stringify(bodyJson) : "";
  const req = new Readable({
    read() {
      if (bodyStr) this.push(Buffer.from(bodyStr));
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = method;
  req.url = pathWithQuery;
  req.headers = bodyJson !== undefined ? { "content-type": "application/json" } : {};
  const res = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      captured.body += chunk.toString();
      cb();
    },
  }) as unknown as ServerResponse;
  (res as unknown as { writeHead: (c: number) => void }).writeHead = (c) => {
    captured.statusCode = c;
  };
  (res as unknown as { end: (d?: string) => void }).end = (d) => {
    if (d) captured.body += d;
  };
  await routeApiRequest(req, res, new URL(`http://localhost${pathWithQuery}`), central());
  return captured;
}

let db: Client;
let nodeId: string;
let originalTokenStore: string | undefined;

beforeEach(async () => {
  originalTokenStore = process.env.PORTUNI_TOKEN_STORE;
  // Read the SA straight from the env (varlock store), matching the VPS.
  process.env.PORTUNI_TOKEN_STORE = "varlock";
  resetTokenStoreForTests();
  resetLocalDbForTests();
  resetAdapterCacheForTests();

  db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  await db.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)",
    args: ["U1", "teammate@workflow.ooo", "Teammate"],
  });
  const orgId = ulid();
  nodeId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
    args: [orgId, "organization", "E2E Org", `e2e-org-${orgId.toLowerCase()}`, "U1"],
  });
  await db.execute({
    sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
    args: [nodeId, "project", "E2E Project", `e2e-proj-${nodeId.toLowerCase()}`, "U1"],
  });
  await db.execute({
    sql: "INSERT INTO edges (id,source_id,target_id,relation,created_by) VALUES (?,?,?,?,?)",
    args: [ulid(), nodeId, orgId, "belongs_to", "U1"],
  });
  if (REMOTE_NAME && SHARED_DRIVE_ID) {
    const config: Record<string, unknown> = { shared_drive_id: SHARED_DRIVE_ID };
    if (ROOT_FOLDER_ID) config.root_folder_id = ROOT_FOLDER_ID;
    await upsertRemote(db, { name: REMOTE_NAME, type: "gdrive", config, created_by: "U1" });
    await replaceRules(db, [
      { priority: 1, node_type: null, org_slug: null, remote_name: REMOTE_NAME },
    ]);
  }
  setDbForTesting(db);
});

afterEach(() => {
  setDbForTesting(null);
  resetAdapterCacheForTests();
  resetTokenStoreForTests();
  resetLocalDbForTests();
  if (originalTokenStore === undefined) delete process.env.PORTUNI_TOKEN_STORE;
  else process.env.PORTUNI_TOKEN_STORE = originalTokenStore;
});

describe("central-mode file content over the server, real Drive (e2e)", () => {
  it(
    "creates, reads, edits, and deletes a real Drive file with no local mirror",
    { skip: e2eSkip() },
    async () => {
      const filename = `e2e-${ulid()}.md`;
      const rel = `wip/${filename}`;
      let fileId: string | undefined;
      try {
        // 1. create (adapter-direct, registers in Turso)
        const created = await call(db, "POST", `/nodes/${nodeId}/files`, {
          filename,
          content: "e2e v1\n",
        });
        assert.equal(created.statusCode, 201, created.body);
        fileId = (JSON.parse(created.body) as { id: string }).id;

        // 2. read back the bytes through the server
        const read1 = await call(db, "GET", `/nodes/${nodeId}/file?path=${rel}`);
        assert.equal(read1.statusCode, 200, read1.body);
        const r1 = JSON.parse(read1.body) as { content: string; version: string };
        assert.equal(r1.content, "e2e v1\n");

        // 3. edit with optimistic concurrency (baseVersion from the read)
        const put = await call(db, "PUT", `/nodes/${nodeId}/file?path=${rel}`, {
          content: "e2e v2\n",
          baseVersion: r1.version,
        });
        assert.equal(put.statusCode, 200, put.body);

        // 4. read the new bytes
        const read2 = await call(db, "GET", `/nodes/${nodeId}/file?path=${rel}`);
        assert.equal(read2.statusCode, 200, read2.body);
        assert.equal((JSON.parse(read2.body) as { content: string }).content, "e2e v2\n");
      } finally {
        // 5. cleanup: delete the remote object + record
        if (fileId) {
          await call(db, "DELETE", `/nodes/${nodeId}/files/${fileId}?confirmed=true`);
        }
      }
    },
  );
});
