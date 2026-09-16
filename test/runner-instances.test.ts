// Provider instances registry (apps/server/domain/runner/instances.ts):
// round trip, validation, and partial-update semantics for runners.json.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  InstanceDefaultsKeyRefusedError,
  InstanceEnvKeyRefusedError,
  createInstance,
  deleteInstance,
  getInstanceDefaults,
  getInstanceEnv,
  listInstances,
  setOrgDefault,
  updateInstance,
} from "../apps/server/domain/runner/instances.js";

describe("runner instances registry", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "portuni-runner-instances-"));
  });

  after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("round trips create -> list -> getInstanceEnv on a temp data dir", async () => {
    const created = await createInstance(
      { name: "Work", runner: "claude", env: { CLAUDE_CONFIG_DIR: "/home/x/.claude-work" } },
      dataDir,
    );
    assert.equal(created.name, "Work");
    assert.equal(created.runner, "claude");
    assert.deepEqual(created.env_keys, ["CLAUDE_CONFIG_DIR"]);
    assert.deepEqual(created.org_defaults, []);

    const list = await listInstances(dataDir);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], created);

    const env = await getInstanceEnv(created.id, dataDir);
    assert.deepEqual(env, { CLAUDE_CONFIG_DIR: "/home/x/.claude-work" });

    // Persisted to runners.json under the given data dir.
    const raw = JSON.parse(await readFile(join(dataDir, "runners.json"), "utf8"));
    assert.equal(raw.instances.length, 1);
    assert.equal(raw.instances[0].id, created.id);
  });

  it("never returns env values from listInstances -- only env_keys", async () => {
    const created = await createInstance({ name: "Secretish", runner: "claude", env: { FOO: "bar" } }, dataDir);
    const list = await listInstances(dataDir);
    const row = list.find((i) => i.id === created.id)!;
    assert.deepEqual(row.env_keys, ["FOO"]);
    assert.equal(JSON.stringify(row).includes("bar"), false);
  });

  it("rejects secret-shaped env keys with INSTANCE_ENV_KEY_REFUSED", async () => {
    for (const key of ["ANTHROPIC_API_KEY", "gh_token", "MY_SECRET", "DB_PASSWORD"]) {
      await assert.rejects(
        () => createInstance({ name: "X", runner: "claude", env: { [key]: "v" } }, dataDir),
        (err: unknown) => {
          assert.ok(err instanceof InstanceEnvKeyRefusedError);
          assert.equal(err.code, "INSTANCE_ENV_KEY_REFUSED");
          assert.equal(err.key, key);
          return true;
        },
      );
    }
  });

  it("rejects PORTUNI_* env keys", async () => {
    await assert.rejects(
      () => createInstance({ name: "X", runner: "claude", env: { PORTUNI_MCP_TOKEN: "v" } }, dataDir),
      (err: unknown) => {
        assert.ok(err instanceof InstanceEnvKeyRefusedError);
        return true;
      },
    );
  });

  it("allows a non-secret-shaped key like CLAUDE_CONFIG_DIR", async () => {
    const created = await createInstance({ name: "Fine", runner: "claude", env: { CLAUDE_CONFIG_DIR: "~/x" } }, dataDir);
    assert.deepEqual(created.env_keys, ["CLAUDE_CONFIG_DIR"]);
  });

  it("expands a leading ~ at read time, not on disk", async () => {
    const created = await createInstance({ name: "Tilde", runner: "claude", env: { CLAUDE_CONFIG_DIR: "~/dot-claude" } }, dataDir);

    const raw = JSON.parse(await readFile(join(dataDir, "runners.json"), "utf8"));
    const stored = raw.instances.find((i: { id: string }) => i.id === created.id);
    assert.equal(stored.env.CLAUDE_CONFIG_DIR, "~/dot-claude", "the literal ~ is what's on disk");

    const env = await getInstanceEnv(created.id, dataDir);
    assert.equal(env?.CLAUDE_CONFIG_DIR, join(homedir(), "dot-claude"));
  });

  it("updateInstance: an empty submitted value for an existing key means unchanged; omitted keys are dropped", async () => {
    const created = await createInstance(
      { name: "Update", runner: "claude", env: { A: "1", B: "2" } },
      dataDir,
    );

    const updated = await updateInstance(
      created.id,
      { env: { A: "", B: "new-b", C: "3" } },
      dataDir,
    );
    assert.deepEqual(new Set(updated.env_keys), new Set(["A", "B", "C"]));

    const env = await getInstanceEnv(created.id, dataDir);
    assert.deepEqual(env, { A: "1", B: "new-b", C: "3" });

    // D was never submitted at all in the update above -- confirm a key
    // genuinely omitted from a later update disappears.
    const droppedD = await updateInstance(created.id, { env: { A: "1" } }, dataDir);
    assert.deepEqual(droppedD.env_keys, ["A"]);
  });

  it("updateInstance rejects a newly-introduced secret-shaped key on the same rules as create", async () => {
    const created = await createInstance({ name: "U", runner: "claude", env: {} }, dataDir);
    await assert.rejects(() => updateInstance(created.id, { env: { API_KEY: "v" } }, dataDir), InstanceEnvKeyRefusedError);
  });

  it("updateInstance throws for an unknown id", async () => {
    await assert.rejects(() => updateInstance("nonexistent", { name: "x" }, dataDir));
  });

  it("deleteInstance removes the row; a second delete throws", async () => {
    const created = await createInstance({ name: "ToDelete", runner: "claude" }, dataDir);
    await deleteInstance(created.id, dataDir);
    const list = await listInstances(dataDir);
    assert.ok(!list.some((i) => i.id === created.id));
    await assert.rejects(() => deleteInstance(created.id, dataDir));
  });

  it("setOrgDefault is exclusive across instances and clears with null", async () => {
    const a = await createInstance({ name: "A", runner: "claude" }, dataDir);
    const b = await createInstance({ name: "B", runner: "claude" }, dataDir);

    await setOrgDefault("org-1", a.id, dataDir);
    let list = await listInstances(dataDir);
    assert.deepEqual(list.find((i) => i.id === a.id)?.org_defaults, ["org-1"]);
    assert.deepEqual(list.find((i) => i.id === b.id)?.org_defaults, []);

    // Reassigning to b removes org-1 from a.
    await setOrgDefault("org-1", b.id, dataDir);
    list = await listInstances(dataDir);
    assert.deepEqual(list.find((i) => i.id === a.id)?.org_defaults, []);
    assert.deepEqual(list.find((i) => i.id === b.id)?.org_defaults, ["org-1"]);

    // Clearing with null leaves no instance default for org-1.
    await setOrgDefault("org-1", null, dataDir);
    list = await listInstances(dataDir);
    assert.deepEqual(list.find((i) => i.id === a.id)?.org_defaults, []);
    assert.deepEqual(list.find((i) => i.id === b.id)?.org_defaults, []);
  });

  it("setOrgDefault throws for an unknown instance id", async () => {
    await assert.rejects(() => setOrgDefault("org-x", "nonexistent", dataDir));
  });

  it("listInstances on a fresh (nonexistent) file returns an empty list", async () => {
    const freshDir = await mkdtemp(join(tmpdir(), "portuni-runner-instances-fresh-"));
    try {
      assert.deepEqual(await listInstances(freshDir), []);
      assert.equal(await getInstanceEnv("anything", freshDir), null);
    } finally {
      await rm(freshDir, { recursive: true, force: true });
    }
  });
});

// #375: an instance's own model/reasoning-effort defaults.
describe("runner instances registry: model/effort defaults", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "portuni-runner-instances-defaults-"));
  });

  after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("round trips defaults through create -> list -> getInstanceDefaults", async () => {
    const created = await createInstance(
      { name: "Team", runner: "claude", defaults: { model: "claude-opus-4-8", effort: "high" } },
      dataDir,
    );
    assert.deepEqual(created.defaults, { model: "claude-opus-4-8", effort: "high" });

    const list = await listInstances(dataDir);
    assert.deepEqual(list.find((i) => i.id === created.id)?.defaults, { model: "claude-opus-4-8", effort: "high" });

    assert.deepEqual(await getInstanceDefaults(created.id, dataDir), { model: "claude-opus-4-8", effort: "high" });
  });

  it("defaults to {} when not given, and for an instance created before #375", async () => {
    const created = await createInstance({ name: "No defaults", runner: "claude" }, dataDir);
    assert.deepEqual(created.defaults, {});

    // Simulate a pre-#375 runners.json row with no `defaults` key at all.
    const path = join(dataDir, "runners.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    delete raw.instances.find((i: { id: string }) => i.id === created.id)!.defaults;
    await writeFile(path, JSON.stringify(raw));

    const list = await listInstances(dataDir);
    assert.deepEqual(list.find((i) => i.id === created.id)?.defaults, {});
  });

  it("rejects an unknown key inside defaults", async () => {
    await assert.rejects(
      () => createInstance({ name: "Bad", runner: "claude", defaults: { nonsense: "x" } as never }, dataDir),
      InstanceDefaultsKeyRefusedError,
    );
  });

  it("rejects an invalid effort level", async () => {
    await assert.rejects(
      () => createInstance({ name: "Bad effort", runner: "claude", defaults: { effort: "extreme" as never } }, dataDir),
      InstanceDefaultsKeyRefusedError,
    );
  });

  it("updateInstance replaces defaults wholesale", async () => {
    const created = await createInstance(
      { name: "Replace me", runner: "claude", defaults: { model: "claude-opus-4-8" } },
      dataDir,
    );
    const updated = await updateInstance(created.id, { defaults: { effort: "max" } }, dataDir);
    assert.deepEqual(updated.defaults, { effort: "max" });
  });
});
