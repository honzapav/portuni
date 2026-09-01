// Tests for apps/server/domain/session-handoff.ts: writing + hashing the
// handoff at suspend, the suspend/resume round trip, hash-change surfacing
// on resume, and conversation-resumability (including the
// expired-conversation degradation to handoff-only resume).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  writeHandoffAndSuspend,
  handoffRelativePath,
  getResumeInfo,
  checkConversationResumable,
  claudeProjectSlug,
} from "../apps/server/domain/session-handoff.js";
import { createSession, getSession, transitionSessionState } from "../apps/server/domain/sessions.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

let workspace: string;
let shared: SharedDb;
let mirrorRoot: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-session-handoff-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  shared = await makeSharedDb();
  mirrorRoot = join(workspace, "mirror");
  await mkdir(mirrorRoot, { recursive: true });
  await registerMirror("U1", shared.nodeId, mirrorRoot);
});

after(async () => {
  resetLocalDbForTests();
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  await rm(workspace, { recursive: true, force: true });
});

describe("writeHandoffAndSuspend", () => {
  it("writes the handoff file at the fixed path, hashes it independently, and suspends the session", async () => {
    const session = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });

    const result = await writeHandoffAndSuspend(
      shared.db,
      "U1",
      { id: session.id, nodeId: shared.nodeId, mirrorRoot },
      "# Handoff\n\nDid X, next do Y.",
      "claude-conv-abc",
    );

    assert.equal(result.handoffPath, handoffRelativePath(session.id));
    assert.equal(result.handoffHash, sha256("# Handoff\n\nDid X, next do Y."));
    assert.equal(result.session.state, "suspended");
    assert.equal(result.session.handoff_path, result.handoffPath);
    assert.equal(result.session.handoff_hash, result.handoffHash);
    assert.equal(result.session.agent_session_id, "claude-conv-abc");

    const onDisk = await readFile(join(mirrorRoot, result.handoffPath), "utf8");
    assert.equal(onDisk, "# Handoff\n\nDid X, next do Y.");

    // Persisted, not just returned.
    const fetched = await getSession(shared.db, session.id);
    assert.equal(fetched?.state, "suspended");
    assert.equal(fetched?.handoff_hash, result.handoffHash);
  });

  it("suspend/resume round trip: transitioning back to running preserves the handoff pointer", async () => {
    const session = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "headless",
    });
    const suspended = await writeHandoffAndSuspend(
      shared.db,
      "U1",
      { id: session.id, nodeId: shared.nodeId, mirrorRoot },
      "round trip content",
    );
    assert.equal(suspended.session.state, "suspended");

    const resumed = await transitionSessionState(shared.db, "U1", session.id, "running");
    assert.equal(resumed.state, "running");
    // Resuming (a plain state transition) does not touch the handoff record --
    // it stays available for inspection even after the session is live again.
    assert.equal(resumed.handoff_path, suspended.handoffPath);
    assert.equal(resumed.handoff_hash, suspended.handoffHash);
  });

  it("re-suspending an already-suspended session updates the handoff (RALPH loop iteration)", async () => {
    const session = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "headless",
    });
    const first = await writeHandoffAndSuspend(
      shared.db,
      "U1",
      { id: session.id, nodeId: shared.nodeId, mirrorRoot },
      "iteration 1",
    );
    const second = await writeHandoffAndSuspend(
      shared.db,
      "U1",
      { id: session.id, nodeId: shared.nodeId, mirrorRoot },
      "iteration 2",
    );
    assert.notEqual(first.handoffHash, second.handoffHash);
    assert.equal(second.session.state, "suspended");
    const onDisk = await readFile(join(mirrorRoot, second.handoffPath), "utf8");
    assert.equal(onDisk, "iteration 2");
  });
});

describe("getResumeInfo: hash-change surfacing", () => {
  it("handoffChanged is false right after suspend (nothing edited)", async () => {
    const session = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });
    const { session: suspended } = await writeHandoffAndSuspend(
      shared.db,
      "U1",
      { id: session.id, nodeId: shared.nodeId, mirrorRoot },
      "unedited content",
    );
    const info = await getResumeInfo(suspended, mirrorRoot);
    assert.equal(info.handoffChanged, false);
    assert.equal(info.currentHandoffHash, info.storedHandoffHash);
  });

  it("handoffChanged is true when the file was edited after suspend", async () => {
    const session = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });
    const { session: suspended, handoffPath } = await writeHandoffAndSuspend(
      shared.db,
      "U1",
      { id: session.id, nodeId: shared.nodeId, mirrorRoot },
      "original content",
    );
    // A human (or another agent) edits the handoff on disk after suspend --
    // a legitimate steering channel per the spec, which must be visible.
    await writeFile(join(mirrorRoot, handoffPath), "edited content", "utf8");

    const info = await getResumeInfo(suspended, mirrorRoot);
    assert.equal(info.handoffChanged, true);
    assert.equal(info.currentHandoffHash, sha256("edited content"));
    assert.notEqual(info.currentHandoffHash, info.storedHandoffHash);
  });

  it("handoffChanged is true when the file is now missing entirely", async () => {
    const session = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });
    const { session: suspended, handoffPath } = await writeHandoffAndSuspend(
      shared.db,
      "U1",
      { id: session.id, nodeId: shared.nodeId, mirrorRoot },
      "will be deleted",
    );
    await rm(join(mirrorRoot, handoffPath));

    const info = await getResumeInfo(suspended, mirrorRoot);
    assert.equal(info.currentHandoffHash, null);
    assert.equal(info.handoffChanged, true);
  });

  it("degrades gracefully (currentHandoffHash null) when there is no mirror on this machine", async () => {
    const session = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });
    const { session: suspended } = await writeHandoffAndSuspend(
      shared.db,
      "U1",
      { id: session.id, nodeId: shared.nodeId, mirrorRoot },
      "some content",
    );
    const info = await getResumeInfo(suspended, null);
    assert.equal(info.currentHandoffHash, null);
    assert.equal(info.conversationResumable, false);
  });
});

describe("checkConversationResumable: expired-conversation degradation to handoff path", () => {
  it("false for any non-Claude CLI, even with a real conversation id and cwd", async () => {
    assert.equal(await checkConversationResumable("codex", "some-id", "/tmp/x"), false);
    assert.equal(await checkConversationResumable(null, "some-id", "/tmp/x"), false);
  });

  it("false when agent_session_id or cwd is missing", async () => {
    assert.equal(await checkConversationResumable("claude", null, "/tmp/x"), false);
    assert.equal(await checkConversationResumable("claude", "some-id", null), false);
  });

  it("false (degrades to handoff-resume) when the conversation transcript does not exist", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "portuni-fakehome-"));
    try {
      const resumable = await checkConversationResumable("claude", "missing-conv", "/some/cwd", fakeHome);
      assert.equal(resumable, false);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("true when the conversation transcript exists at the expected path", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "portuni-fakehome-"));
    try {
      const cwd = "/Users/test/mirrors/some-project";
      const projectDir = join(fakeHome, ".claude", "projects", claudeProjectSlug(cwd));
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "conv-123.jsonl"), "{}\n", "utf8");

      const resumable = await checkConversationResumable("claude", "conv-123", cwd, fakeHome);
      assert.equal(resumable, true);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("getResumeInfo surfaces conversationResumable: true end to end when the transcript exists", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "portuni-fakehome-"));
    try {
      const session = await createSession(shared.db, "U1", {
        node_id: shared.nodeId,
        session_type: "interactive_task",
      });
      const { session: suspended } = await writeHandoffAndSuspend(
        shared.db,
        "U1",
        { id: session.id, nodeId: shared.nodeId, mirrorRoot },
        "content",
        "conv-live",
      );
      const projectDir = join(fakeHome, ".claude", "projects", claudeProjectSlug(mirrorRoot));
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "conv-live.jsonl"), "{}\n", "utf8");

      // cli is null on this session (not yet tracked by createSession's
      // input in this test) -- conversationResumable is always false
      // without it, matching "Claude first" / degrade-safe-by-default.
      const infoNoCle = await getResumeInfo(suspended, mirrorRoot, fakeHome);
      assert.equal(infoNoCle.conversationResumable, false);

      const withCli = { ...suspended, cli: "claude" };
      const info = await getResumeInfo(withCli, mirrorRoot, fakeHome);
      assert.equal(info.conversationResumable, true);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
