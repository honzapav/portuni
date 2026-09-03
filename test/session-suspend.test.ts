import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  correlateSessions,
  suspendableTerminalIds,
  allSuspended,
  suspendPollTimedOut,
} from "../apps/web/src/lib/session-suspend.js";
import type { SessionSummary } from "../apps/web/src/types";

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s1",
    node_id: "n1",
    user_id: "u1",
    session_type: "interactive_task",
    cli: null,
    profile_id: null,
    terminal_id: null,
    state: "running",
    name: "Session",
    name_is_custom: false,
    handoff_path: null,
    write_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    last_active_at: "2026-01-01T00:00:00.000Z",
    closed_at: null,
    ...overrides,
  };
}

describe("correlateSessions", () => {
  it("keeps only rows with a terminal_id", () => {
    const rows = [
      summary({ id: "s1", terminal_id: "term_a", state: "running" }),
      summary({ id: "s2", terminal_id: null, state: "running" }),
      summary({ id: "s3", terminal_id: "term_c", state: "suspended" }),
    ];
    assert.deepEqual(correlateSessions(rows), [
      { terminalId: "term_a", state: "running" },
      { terminalId: "term_c", state: "suspended" },
    ]);
  });

  it("is empty for an empty input", () => {
    assert.deepEqual(correlateSessions([]), []);
  });
});

describe("suspendableTerminalIds", () => {
  const agent = { id: "term_a", command: "claude 'hello'" };
  const shell = { id: "term_b", command: "zsh -l" };
  const codex = { id: "term_c", command: "codex" };

  it("requires both an agent command and a correlated running session", () => {
    const correlated = [
      { terminalId: "term_a", state: "running" as const },
      { terminalId: "term_b", state: "running" as const },
    ];
    // term_a: agent + running -> suspendable.
    // term_b: running but not an agent command -> not suspendable.
    // term_c (codex): agent-shaped but no correlated row at all -> not suspendable.
    assert.deepEqual(suspendableTerminalIds([agent, shell, codex], correlated), ["term_a"]);
  });

  it("excludes an agent terminal whose correlated session is not running", () => {
    const correlated = [{ terminalId: "term_a", state: "suspended" as const }];
    assert.deepEqual(suspendableTerminalIds([agent], correlated), []);
  });

  it("is empty with no correlated sessions at all", () => {
    assert.deepEqual(suspendableTerminalIds([agent, shell], []), []);
  });
});

describe("allSuspended", () => {
  it("is true only once nothing is still running", () => {
    assert.equal(allSuspended(["suspended", "closed"]), true);
    assert.equal(allSuspended(["suspended", "running"]), false);
  });

  it("is vacuously true for an empty list", () => {
    assert.equal(allSuspended([]), true);
  });
});

describe("suspendPollTimedOut", () => {
  it("is false before the deadline and true at/after it", () => {
    const startedAt = 1_000;
    assert.equal(suspendPollTimedOut(startedAt, startedAt + 29_999, 30_000), false);
    assert.equal(suspendPollTimedOut(startedAt, startedAt + 30_000, 30_000), true);
    assert.equal(suspendPollTimedOut(startedAt, startedAt + 40_000, 30_000), true);
  });

  it("defaults to the 30s constant", () => {
    const startedAt = 1_000;
    assert.equal(suspendPollTimedOut(startedAt, startedAt + 30_000), true);
  });
});
