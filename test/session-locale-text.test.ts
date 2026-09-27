// #539: text the device writes for a person -- the handoff file and the
// default thread name -- is in the language of the request that caused it,
// English when the request carried none. Asserted on the pure summary
// builder, on the session runtime in a personal workspace (Předat,
// Pokračovat v nové session, two concurrent requests in different
// languages), and on a draft a sync agent records on the central server
// (a fake central server running the real routes behind the real HTTP
// CentralClient).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import { CentralSessionStore } from "../apps/server/domain/runner/store-central.js";
import { createSessionRuntime } from "../apps/server/domain/runner/session-runtime.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { FakeRunnerAdapter } from "../apps/server/domain/runner/adapters/fake.js";
import type { RunnerAdapter } from "../apps/server/domain/runner/types.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";
import type { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import { createDraftSession } from "../apps/server/domain/sessions.js";
import { buildRunSummaryContent, formatHandoffTimestamp } from "../apps/server/domain/session-handoff.js";
import { createHttpCentralClient } from "../apps/server/domain/sync/central/client.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { clearTestContentDb, installTestContentDb } from "./helpers/content-db.js";

let content: SessionContentStore;

async function sharedDb(): Promise<SharedDb> {
  const shared = await makeSharedDb();
  setDbForTesting(shared.db);
  content = (await installTestContentDb()).content;
  return shared;
}

afterEach(() => {
  setDbForTesting(null);
  clearTestContentDb();
});

function stubProvision() {
  return async (input: { nodeId: string }): Promise<ProvisionRunResult> => ({
    cwd: "/tmp/mirror",
    orientation: "orientation text",
    mcp: { url: "http://localhost:4011/mcp", token: "tok", homeNodeId: input.nodeId },
    portuniRoot: "/tmp",
    mirrors: ["/tmp/mirror"],
  });
}

function registryOf(adapter: RunnerAdapter) {
  return { getAdapter: (id: string) => (id === adapter.id ? adapter : null) };
}

const SUMMARY_INPUT = {
  nodeName: "Proj <A & B>",
  sessionName: "Thread",
  reason: "handoff" as const,
  events: [
    { kind: "user_message", payload: { text: "hello there" } },
    { kind: "assistant_message", payload: { text: "hi back" } },
  ],
  writeSet: ["N1"],
  readSet: [],
  lastActiveAt: "2026-09-26 08:05:00",
};

describe("handoff summary in the request's language (#539)", () => {
  it("writes the summary in English", () => {
    const out = buildRunSummaryContent({ ...SUMMARY_INPUT, locale: "en" });
    assert.match(out, /^Node: Proj <A & B>$/m, "Markdown, so the node name is not HTML-escaped");
    assert.match(out, new RegExp(`^Last activity: ${formatHandoffTimestamp(SUMMARY_INPUT.lastActiveAt, "en")} UTC$`, "m"));
    assert.match(out, /^## Recent messages\n- \*\*User:\*\* hello there\n- \*\*Agent:\*\* hi back$/m);
    assert.match(out, /^## Changed files\n\(none\)$/m);
    assert.match(out, /^## Open question\n\(none\)$/m);
    assert.match(out, /^## Write scope\n- N1$/m);
    assert.match(out, /^## Read scope\n\(none\)$/m);
    assert.match(out, /The conversation was not saved; continue from this summary\.$/);
    assert.doesNotMatch(out, /[ěščřžýáíéúů]/);
  });

  it("writes the summary in Czech", () => {
    const out = buildRunSummaryContent({ ...SUMMARY_INPUT, locale: "cs" });
    assert.match(out, /^Uzel: Proj <A & B>$/m);
    assert.match(out, new RegExp(`^Poslední aktivita: ${formatHandoffTimestamp(SUMMARY_INPUT.lastActiveAt, "cs")} UTC$`, "m"));
    assert.match(out, /^## Poslední zprávy\n- \*\*Uživatel:\*\* hello there\n- \*\*Agent:\*\* hi back$/m);
    assert.match(out, /^## Otevřená otázka\n\(žádná\)$/m);
    assert.match(out, /^## Čtecí rozsah\n\(žádný\)$/m);
    assert.match(out, /Konverzace nebyla uložena; pokračuj z tohoto shrnutí\.$/);
  });

  it("writes English when the request carried no locale", () => {
    assert.equal(buildRunSummaryContent(SUMMARY_INPUT), buildRunSummaryContent({ ...SUMMARY_INPUT, locale: "en" }));
  });

  it("formats the last activity with Intl in the summary's language, in UTC", () => {
    const at = "2026-09-26 08:05:00";
    const date = new Date("2026-09-26T08:05:00Z");
    for (const locale of ["en", "cs"] as const) {
      const expected = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
      assert.equal(formatHandoffTimestamp(at, locale), expected.format(date));
      assert.equal(formatHandoffTimestamp(date.toISOString(), locale), expected.format(date));
    }
    assert.equal(formatHandoffTimestamp("not a date", "cs"), "not a date");
  });

  it("builds many summaries in alternating languages with no crosstalk", async () => {
    const outs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() => buildRunSummaryContent({ ...SUMMARY_INPUT, locale: i % 2 ? "cs" : "en" })),
      ),
    );
    outs.forEach((out, i) => {
      assert.match(out, i % 2 ? /^Uzel: /m : /^Node: /m);
    });
  });
});

describe("session runtime writes the handoff file in the request's language (#539)", () => {
  let workspace: string | null = null;

  afterEach(async () => {
    resetLocalDbForTests();
    delete process.env.PORTUNI_WORKSPACE_ROOT;
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = null;
  });

  async function withMirror() {
    const shared = await sharedDb();
    workspace = await mkdtemp(join(tmpdir(), "portuni-locale-handoff-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    const mirrorRoot = join(workspace, "mirror");
    await mkdir(mirrorRoot, { recursive: true });
    await registerMirror("U1", shared.nodeId, mirrorRoot);
    const store = new DbSessionStore(shared.db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });
    return { ...shared, store, runtime, mirrorRoot };
  }

  it("two concurrent hand-off requests in different languages each get their own", async () => {
    const { nodeId, runtime, mirrorRoot } = await withMirror();
    const { session: a } = await runtime.startTask({ userId: "U1", nodeId, brief: "first", runner: "fake" });
    const { session: b } = await runtime.startTask({ userId: "U1", nodeId, brief: "second", runner: "fake" });

    const [ra, rb] = await Promise.all([
      runtime.handoff(a.id, { locale: "cs" }),
      runtime.handoff(b.id, { locale: "en" }),
    ]);

    const fileA = await readFile(join(mirrorRoot, ra.handoff_path), "utf8");
    const fileB = await readFile(join(mirrorRoot, rb.handoff_path), "utf8");
    assert.match(fileA, /^## Poslední zprávy$/m);
    assert.match(fileA, /\*\*Uživatel:\*\* first/);
    assert.match(fileB, /^## Recent messages$/m);
    assert.match(fileB, /\*\*User:\*\* second/);
    assert.doesNotMatch(fileB, /Poslední/);
  });

  it("a hand-off with no locale writes English", async () => {
    const { nodeId, runtime, mirrorRoot } = await withMirror();
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const { handoff_path } = await runtime.handoff(session.id);
    assert.match(await readFile(join(mirrorRoot, handoff_path), "utf8"), /^## Recent messages$/m);
  });

  it("continue in a new thread writes the old thread's file in the request's language", async () => {
    const { nodeId, runtime, mirrorRoot } = await withMirror();
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "the old task", runner: "fake" });
    await runtime.continueSession(session.id, { locale: "cs" });
    const onDisk = await readFile(join(mirrorRoot, `wip/sessions/${session.id}-handoff.md`), "utf8");
    assert.match(onDisk, /\*\*Uživatel:\*\* the old task/);
    assert.match(onDisk, /^Uzel: /m);
  });
});

const identity: RequestIdentity = {
  userId: "U1",
  email: "a@b",
  name: "A",
  globalScope: "admin",
  groups: [],
  groupIds: [],
  via: "env",
};

// A fake central server: every request the HTTP CentralClient sends goes
// through the central server's real REST router, on the shared test db.
function centralFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    const req = new Readable({
      read() {
        if (bodyStr) this.push(Buffer.from(bodyStr));
        this.push(null);
      },
    }) as unknown as IncomingMessage;
    req.method = init?.method ?? "GET";
    req.url = url.pathname + url.search;
    req.headers = { "content-type": "application/json" };
    let status = 0;
    let body = "";
    const res = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        body += chunk.toString();
        cb();
      },
    }) as unknown as ServerResponse;
    (res as unknown as { writeHead: (code: number) => void }).writeHead = (code: number) => {
      status = code;
    };
    (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
      if (data) body += data;
    };
    await routeApiRequest(req, res, url, identity);
    return new Response(body || null, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("default thread name in the request's language (#539)", () => {
  it("names a draft in English with no locale and in the language asked for", async () => {
    const { db, nodeId } = await sharedDb();
    assert.equal((await createDraftSession(db, "U1", nodeId)).name, "New task");
    assert.equal((await createDraftSession(db, "U1", nodeId, { locale: "cs" })).name, "Nový úkol");
    assert.equal((await createDraftSession(db, "U1", nodeId, { locale: "en" })).name, "New task");
  });

  it("personal workspace: the runtime names the draft in the POST /sessions language", async () => {
    const { db, nodeId } = await sharedDb();
    const runtime = createSessionRuntime({
      store: new DbSessionStore(db),
      content,
      registry: registryOf(new FakeRunnerAdapter({ script: [] })),
      provision: stubProvision(),
    });
    assert.equal((await runtime.createDraft({ userId: "U1", nodeId, locale: "cs" })).name, "Nový úkol");
    assert.equal((await runtime.createDraft({ userId: "U1", nodeId })).name, "New task");
  });

  it("team workspace: a draft the sync agent records on the central server is named in the request's language", async () => {
    const { db, nodeId } = await sharedDb();
    const client = createHttpCentralClient({ baseUrl: "http://central.test", token: "t", fetchImpl: centralFetch() });
    const runtime = createSessionRuntime({
      store: new CentralSessionStore(client),
      content,
      registry: registryOf(new FakeRunnerAdapter({ script: [] })),
      provision: stubProvision(),
      resolveNodeOrgId: async () => null,
    });

    const cs = await runtime.createDraft({ userId: "U1", nodeId, locale: "cs" });
    const en = await runtime.createDraft({ userId: "U1", nodeId });
    assert.equal(cs.name, "Nový úkol");
    assert.equal(en.name, "New task");
    const rows = await db.execute({ sql: "SELECT id, name FROM sessions WHERE id IN (?, ?)", args: [cs.id, en.id] });
    assert.deepEqual(
      Object.fromEntries(rows.rows.map((r) => [String(r.id), String(r.name)])),
      { [cs.id]: "Nový úkol", [en.id]: "New task" },
    );
  });
});
