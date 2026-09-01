// Tests for the Seatbelt sandbox profile generator (universal disk-scope
// layer). The kernel grants read+write in the home mirror and read-only on
// each depth-1 neighbour's REAL mirror; a per-node projection parent is also
// granted read-only for ad-hoc (deeper) nodes hardlinked in mid-session
// (domain/session-projection.ts, mcp/disk-projection.ts). See
// docs/architecture/scope-disk-projection.md.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import {
  buildSeatbeltProfile,
  resolveProjectionRootForNode,
  resolveSandboxScopeForCwd,
  resolveSandboxScopeForNode,
  ResumeSessionUnauthorizedError,
} from "../apps/server/domain/sandbox-profile.js";
import {
  createSession,
  transitionSessionState,
  upsertSessionScopeRead,
} from "../apps/server/domain/sessions.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { SOLO_USER } from "../apps/server/infra/schema.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("buildSeatbeltProfile (real-path model)", () => {
  it("grants rw on the home mirror and denies the rest of the root", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/org/proj",
      readMirrors: [],
    });
    assert.match(p, /\(deny file-read\* file-write\* \(subpath "\/root"\)\)/);
    assert.match(p, /\(allow file-read-metadata \(subpath "\/root"\)\)/);
    assert.match(p, /\(allow file-read\* file-write\* \(subpath "\/root\/org\/proj"\)\)/);
  });

  it("emits exactly one read-allow (home rw) when readMirrors is empty", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/org/proj",
      readMirrors: [],
    });
    const reads = p.split("\n").filter((l) => l.startsWith("(allow file-read*"));
    assert.equal(reads.length, 1); // just the home rw line
  });

  it("re-allows read on each granted mirror AFTER the deny line", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/a",
      readMirrors: ["/root/b", "/root/c"],
    });
    const denyIdx = p.indexOf("(deny file-read*");
    const bIdx = p.indexOf('(allow file-read* (subpath "/root/b"))');
    const cIdx = p.indexOf('(allow file-read* (subpath "/root/c"))');
    assert.ok(denyIdx >= 0, "deny line present");
    assert.ok(bIdx > denyIdx, "neighbor b read-allow after deny");
    assert.ok(cIdx > denyIdx, "neighbor c read-allow after deny");
    // Neighbors are read-only, not rw.
    assert.doesNotMatch(p, /\(allow file-read\* file-write\* \(subpath "\/root\/b"\)\)/);
  });

  it("escapes quotes and backslashes in paths", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: '/ws/we"ird\\dir',
      homeMirror: '/ws/we"ird\\dir/home',
      readMirrors: [],
    });
    assert.ok(p.includes('"/ws/we\\"ird\\\\dir"'));
  });

  it("re-allows read-only on projectionRoot when set, omits the line when absent", () => {
    const withProjection = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/a",
      readMirrors: [],
      projectionRoot: "/root/.portuni-sessions/HOME",
    });
    assert.match(
      withProjection,
      /\(allow file-read\* \(subpath "\/root\/\.portuni-sessions\/HOME"\)\)/,
    );
    assert.doesNotMatch(
      withProjection,
      /\(allow file-read\* file-write\* \(subpath "\/root\/\.portuni-sessions\/HOME"\)\)/,
    );

    const withoutProjection = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/a",
      readMirrors: [],
    });
    assert.doesNotMatch(withoutProjection, /\.portuni-sessions/);
  });

  it("narrows the projection allow to <projectionRoot>/<sessionId> when sessionId is set (#208 follow-up)", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/a",
      readMirrors: [],
      projectionRoot: "/root/.portuni-sessions/HOME",
      sessionId: "SESSION123",
    });
    assert.match(
      p,
      /\(allow file-read\* \(subpath "\/root\/\.portuni-sessions\/HOME\/SESSION123"\)\)/,
    );
    // The wide, unnarrowed grant must not also appear.
    assert.doesNotMatch(
      p,
      /\(allow file-read\* \(subpath "\/root\/\.portuni-sessions\/HOME"\)\)/,
    );
  });

  it("falls back to the wide projectionRoot grant when sessionId is absent", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/a",
      readMirrors: [],
      projectionRoot: "/root/.portuni-sessions/HOME",
    });
    assert.match(
      p,
      /\(allow file-read\* \(subpath "\/root\/\.portuni-sessions\/HOME"\)\)/,
    );
  });
});

describe("resolveSandboxScopeForNode", () => {
  let workspace: string;
  let originalRoot: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-sbx-"));
    originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
  });

  afterEach(async () => {
    resetLocalDbForTests();
    if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
    else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns home mirror and portuniRoot", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const scope = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);

    assert.ok(scope, "scope must resolve when the node has a mirror");
    assert.equal(scope.homeMirror.endsWith(join("org", "projects", "p1")), true);
    assert.ok(scope.portuniRoot.length > 0);
  });

  it("returns null when the node has no mirror", async () => {
    const { db } = await makeSharedDb();
    const scope = await resolveSandboxScopeForNode(db, SOLO_USER, ulid());
    assert.equal(scope, null);
  });

  it("computes projectionRoot as <portuniRoot>/.portuni-sessions/<nodeId>", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const scope = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);

    assert.ok(scope);
    assert.equal(scope.projectionRoot, join(scope.portuniRoot, ".portuni-sessions", nodeId));
  });

  it("grants read on depth-1 neighbour mirrors, not the home", async () => {
    const { db, nodeId, orgId } = await makeSharedDb(); // project belongs_to org
    const orgDir = join(workspace, "org");
    const homeDir = join(orgDir, "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);
    await registerMirror(SOLO_USER, orgId, orgDir);

    const scope = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);

    assert.ok(scope);
    // The org (depth-1 neighbour) real mirror is granted...
    assert.equal(scope.readMirrors.length, 1);
    assert.equal(scope.readMirrors[0].endsWith(join("", "org")), true);
    // ...and the home mirror is NOT in readMirrors (it's granted rw separately).
    assert.ok(!scope.readMirrors.includes(scope.homeMirror));
  });

  it("omits neighbours that have no local mirror", async () => {
    const { db, nodeId } = await makeSharedDb(); // org neighbour, but no org mirror
    const homeDir = join(workspace, "org", "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const scope = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);
    assert.ok(scope);
    assert.equal(scope.readMirrors.length, 0);
  });

  it("restart consolidation: resumeSessionId widens readMirrors with the session's accumulated read set (#191)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    // A node with no graph edge to nodeId -- not a depth-1 neighbour -- but
    // this session read it once via an ad-hoc expansion and it has a local
    // mirror on this device.
    const adhocId = "N000000000000000000ADHOC01";
    await db.execute({
      sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
      args: [adhocId, "process", "Ad-hoc process", "adhoc-proc", SOLO_USER],
    });
    const adhocDir = join(workspace, "elsewhere", "adhoc");
    await mkdir(adhocDir, { recursive: true });
    await registerMirror(SOLO_USER, adhocId, adhocDir);

    const session = await createSession(db, SOLO_USER, {
      node_id: nodeId,
      session_type: "interactive_task",
    });
    await upsertSessionScopeRead(db, session.id, adhocId, "disconnected", "test");
    // Resume authorization (#204) requires the session to be suspended.
    await transitionSessionState(db, SOLO_USER, session.id, "suspended");

    const fresh = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);
    assert.ok(fresh);
    assert.ok(!fresh.readMirrors.some((m) => m.endsWith(join("elsewhere", "adhoc"))));

    const resumed = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId, session.id);
    assert.ok(resumed);
    assert.ok(resumed.readMirrors.some((m) => m.endsWith(join("elsewhere", "adhoc"))));
  });

  it("resume authorization (#204): refuses a resumeSessionId owned by a different user", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);
    await db.execute({
      sql: "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)",
      args: ["someone-else", "else@x.com", "Someone Else"],
    });

    const session = await createSession(db, "someone-else", {
      node_id: nodeId,
      session_type: "interactive_task",
    });
    await transitionSessionState(db, "someone-else", session.id, "suspended");

    await assert.rejects(
      resolveSandboxScopeForNode(db, SOLO_USER, nodeId, session.id),
      ResumeSessionUnauthorizedError,
    );
  });

  it("resume authorization (#204): refuses a resumeSessionId anchored to a different node", async () => {
    const { db, nodeId, orgId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    const orgDir = join(workspace, "org");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);
    await registerMirror(SOLO_USER, orgId, orgDir);

    const session = await createSession(db, SOLO_USER, {
      node_id: orgId,
      session_type: "interactive_task",
    });
    await transitionSessionState(db, SOLO_USER, session.id, "suspended");

    await assert.rejects(
      resolveSandboxScopeForNode(db, SOLO_USER, nodeId, session.id),
      ResumeSessionUnauthorizedError,
    );
  });

  it("resume authorization (#204): refuses a resumeSessionId that is not suspended", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const session = await createSession(db, SOLO_USER, {
      node_id: nodeId,
      session_type: "interactive_task",
    });
    // Still running -- never suspended.
    await assert.rejects(
      resolveSandboxScopeForNode(db, SOLO_USER, nodeId, session.id),
      ResumeSessionUnauthorizedError,
    );
  });

  it("resolves by cwd: deepest containing mirror wins", async () => {
    const { db, nodeId, orgId } = await makeSharedDb();
    const orgDir = join(workspace, "org");
    const homeDir = join(orgDir, "projects", "p1");
    await mkdir(join(homeDir, "wip"), { recursive: true });
    await registerMirror(SOLO_USER, orgId, orgDir);
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const r = await resolveSandboxScopeForCwd(db, SOLO_USER, join(homeDir, "wip"));

    assert.ok(r, "cwd inside a mirror must resolve");
    assert.equal(r.nodeId, nodeId, "nested mirror must beat its ancestor");
    assert.ok(r.scope.homeMirror.endsWith(join("projects", "p1")));
  });

  it("mints a fresh sessionId for a non-resumed spawn, distinct each call (#208 follow-up)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const a = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);
    const b = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);

    assert.ok(a?.sessionId);
    assert.ok(b?.sessionId);
    assert.notEqual(a.sessionId, b.sessionId, "each fresh spawn must mint its own id");
  });

  it("reuses the already-validated resumeSessionId as sessionId on resume", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const session = await createSession(db, SOLO_USER, {
      node_id: nodeId,
      session_type: "interactive_task",
    });
    await transitionSessionState(db, SOLO_USER, session.id, "suspended");

    const resumed = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId, session.id);
    assert.equal(resumed?.sessionId, session.id);
  });

  it("resolves by cwd: returns null outside every mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const r = await resolveSandboxScopeForCwd(db, SOLO_USER, join(workspace, "elsewhere"));
    assert.equal(r, null);
  });
});

describe("resolveProjectionRootForNode", () => {
  let workspace: string;
  let originalRoot: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-sbx-proj-"));
    originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
  });

  afterEach(async () => {
    resetLocalDbForTests();
    if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
    else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns the same projectionRoot as resolveSandboxScopeForNode, without needing a db or the node's own mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const full = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);
    const light = await resolveProjectionRootForNode(SOLO_USER, nodeId);

    assert.ok(full);
    assert.ok(light);
    assert.equal(light.portuniRoot, full.portuniRoot);
    assert.equal(light.projectionRoot, full.projectionRoot);
  });

  it("returns null when no PORTUNI_ROOT is resolvable (no mirrors, no env override)", async () => {
    const r = await resolveProjectionRootForNode(SOLO_USER, ulid());
    assert.equal(r, null);
  });
});
