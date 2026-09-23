// #460 "Navázat na handoff": the pure mapping the Relace tab's handoff list
// is built from (apps/web/src/lib/handoff-files.ts). Run from the server's
// node:test runner like every other web helper.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handoffFileEntries } from "../apps/web/src/lib/handoff-files.js";
import type { DetailFile, SessionSummary } from "../apps/web/src/types.js";

function file(overrides: Partial<DetailFile> & { id: string; relative_path: string | null }): DetailFile {
  return {
    id: overrides.id,
    filename: overrides.filename ?? (overrides.relative_path?.split("/").pop() ?? ""),
    status: "wip",
    local_path: null,
    relative_path: overrides.relative_path,
    mime_type: "text/markdown",
  };
}

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    id: overrides.id,
    node_id: "n1",
    node_name: "Proj",
    user_id: "U1",
    session_type: "interactive_task",
    cli: null,
    instance_id: null,
    brief: null,
    runner: "claude",
    host_id: overrides.host_id ?? null,
    host_label: overrides.host_label ?? null,
    waiting_since: null,
    state: "suspended",
    name: overrides.name ?? "Vlákno",
    name_is_custom: false,
    handoff_path: null,
    write_count: 0,
    model: null,
    effort: null,
    context_used_tokens: null,
    context_max_tokens: null,
    created_at: "2026-09-20 10:00:00",
    last_active_at: overrides.last_active_at ?? "2026-09-20 10:00:00",
    closed_at: null,
  };
}

describe("handoffFileEntries", () => {
  it("keeps only wip/sessions/<id>-handoff.md and names them from the source record", () => {
    const entries = handoffFileEntries(
      [
        file({ id: "f1", relative_path: "wip/sessions/01AAA-handoff.md" }),
        file({ id: "f2", relative_path: "wip/docs/plan.md" }),
        file({ id: "f3", relative_path: null }),
        file({ id: "f4", relative_path: "wip/sessions/notes.md" }),
      ],
      [session({ id: "01AAA", name: "Oprava sync agenta", host_label: "MacBook", last_active_at: "2026-09-21 08:00:00" })],
    );

    assert.deepEqual(entries, [
      {
        file_id: "f1",
        relative_path: "wip/sessions/01AAA-handoff.md",
        session_id: "01AAA",
        title: "Oprava sync agenta",
        host: "MacBook",
        last_active_at: "2026-09-21 08:00:00",
      },
    ]);
  });

  it("falls back to the file name for a thread this user cannot see (another machine, another owner)", () => {
    const [entry] = handoffFileEntries([file({ id: "f1", relative_path: "wip/sessions/01BBB-handoff.md" })], []);
    assert.equal(entry.title, "01BBB-handoff.md");
    assert.equal(entry.host, null);
    assert.equal(entry.last_active_at, null);
  });

  it("orders newest first, by the source record's activity and then by the id in the file name", () => {
    const entries = handoffFileEntries(
      [
        file({ id: "f1", relative_path: "wip/sessions/01AAA-handoff.md" }),
        file({ id: "f2", relative_path: "wip/sessions/01CCC-handoff.md" }),
        file({ id: "f3", relative_path: "wip/sessions/01BBB-handoff.md" }),
      ],
      [
        session({ id: "01AAA", last_active_at: "2026-09-21 08:00:00" }),
        session({ id: "01BBB", last_active_at: "2026-09-22 08:00:00" }),
      ],
    );
    assert.deepEqual(
      entries.map((e) => e.session_id),
      ["01BBB", "01AAA", "01CCC"],
    );
  });

  it("prefers the host label over the raw host id", () => {
    const [entry] = handoffFileEntries(
      [file({ id: "f1", relative_path: "wip/sessions/01AAA-handoff.md" })],
      [session({ id: "01AAA", host_id: "mac-1", host_label: "  " })],
    );
    assert.equal(entry.host, "mac-1");
  });
});
