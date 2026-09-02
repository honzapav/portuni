// #211: the disk projector and the Seatbelt kernel grant must agree on
// which directory an ad-hoc node's projection lands in, for EVERY CLI, not
// just Claude (the only one that can relay the spawn-minted session id back
// via X-Portuni-Spawn-Id -- domain/write-scope.ts's buildClaudeMcpJson).
// createMcpServer resolves SessionScope.projectionSessionId synchronously
// (mcp/server.ts), before any tool call could race a persisted session id,
// from (in order): the resumed session's own id, the relayed spawn id, or
// the fixed shared bucket domain/sandbox-profile.ts's Seatbelt profile also
// grants unconditionally for exactly this case.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { ulid } from "ulid";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { createMcpServer, buildDefaultEnvIdentity } from "../apps/server/mcp/server.js";
import { createSession } from "../apps/server/domain/sessions.js";
import { UNNARROWED_PROJECTION_ID } from "../apps/server/domain/session-projection.js";

let workspace: string;
let db: DbClient;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-projection-session-id-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);
});

after(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("SessionScope.projectionSessionId (#211)", () => {
  it("Claude path unchanged: a relayed X-Portuni-Spawn-Id narrows to that id", () => {
    const spawnId = ulid();
    // homeNodeId null -- irrelevant to projectionSessionId resolution, and
    // keeps bindSessionPersistence's fire-and-forget createSession from
    // hitting the sessions.node_id FK against a node that doesn't exist.
    const { scope } = createMcpServer(buildDefaultEnvIdentity(), null, null, null, spawnId);
    assert.equal(scope.projectionSessionId, spawnId);
  });

  it("Codex/Vibe path: no spawn id relayed falls back to the shared bucket", () => {
    const { scope } = createMcpServer(buildDefaultEnvIdentity(), null, null, null, null);
    assert.equal(scope.projectionSessionId, UNNARROWED_PROJECTION_ID);
  });

  it("resume: reuses the already-validated resumeSessionId regardless of CLI", async () => {
    const homeNodeId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
            VALUES (?, 'project', 'Proj', 'active', 'team', ?, ?)`,
      args: [homeNodeId, homeNodeId, "01SOLO0000000000000000000"],
    });
    const session = await createSession(db, "01SOLO0000000000000000000", {
      node_id: homeNodeId,
      session_type: "interactive_task",
    });
    // Resume never relays a spawn id (Claude or otherwise) -- the resumed
    // id is already the authoritative, previously-agreed-on one.
    const { scope } = createMcpServer(
      buildDefaultEnvIdentity(),
      homeNodeId,
      null,
      session.id,
      null,
    );
    assert.equal(scope.projectionSessionId, session.id);
  });
});
