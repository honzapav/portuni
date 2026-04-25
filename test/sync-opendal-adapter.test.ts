import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenDALAdapter } from "../src/sync/opendal-adapter.js";
import type { RemoteConfig, DeviceTokens } from "../src/sync/types.js";

const noTokens: DeviceTokens = {};

describe("opendal-adapter (memory backend)", () => {
  function memRemote(): RemoteConfig {
    return { name: "mem", type: "memory", config: {} };
  }

  it("put then get roundtrip", async () => {
    const a = createOpenDALAdapter(memRemote(), noTokens);
    const buf = Buffer.from("hello world", "utf8");
    const ref = await a.put("file.txt", buf);
    assert.equal(ref.path, "file.txt");
    assert.equal(ref.size, buf.length);
    assert.ok(ref.hash, "put returns sha256 hash");
    assert.equal(ref.hash!.length, 64);
    const got = await a.get("file.txt");
    assert.equal(got.toString("utf8"), "hello world");
  });

  it("stat returns FileRef with size for existing file, null for missing", async () => {
    const a = createOpenDALAdapter(memRemote(), noTokens);
    await a.put("x.txt", Buffer.from("abc"));
    const s = await a.stat("x.txt");
    assert.ok(s);
    assert.equal(s.size, 3);
    assert.equal(s.path, "x.txt");

    const missing = await a.stat("nope.txt");
    assert.equal(missing, null);
  });

  it("list over prefix returns entries", async () => {
    const a = createOpenDALAdapter(memRemote(), noTokens);
    await a.put("dir/a.txt", Buffer.from("a"));
    await a.put("dir/b.txt", Buffer.from("bb"));
    await a.put("other.txt", Buffer.from("o"));
    const entries = await a.list("dir/");
    const names = entries.map((e) => e.path).sort();
    assert.deepEqual(names, ["dir/a.txt", "dir/b.txt"]);
  });

  it("delete removes file; subsequent stat returns null", async () => {
    const a = createOpenDALAdapter(memRemote(), noTokens);
    await a.put("toDelete.txt", Buffer.from("x"));
    await a.delete("toDelete.txt");
    assert.equal(await a.stat("toDelete.txt"), null);
  });

  it("rename moves file", async () => {
    const a = createOpenDALAdapter(memRemote(), noTokens);
    await a.put("from.txt", Buffer.from("renamed"));
    await a.rename("from.txt", "to.txt");
    assert.equal(await a.stat("from.txt"), null);
    const after = await a.stat("to.txt");
    assert.ok(after);
    const got = await a.get("to.txt");
    assert.equal(got.toString("utf8"), "renamed");
  });

  it("export method is absent (optional)", () => {
    const a = createOpenDALAdapter(memRemote(), noTokens);
    assert.equal(typeof a.export, "undefined");
  });

  it("unsupported backend type throws with clear message", () => {
    const bad: RemoteConfig = { name: "x", type: "gdrive", config: {} };
    assert.throws(() => createOpenDALAdapter(bad, noTokens), /gdrive/);
  });
});

describe("opendal-adapter (fs backend)", () => {
  let remoteRoot: string;

  beforeEach(async () => {
    remoteRoot = await mkdtemp(join(tmpdir(), "portuni-opendal-fs-"));
  });

  afterEach(async () => {
    await rm(remoteRoot, { recursive: true, force: true });
  });

  function fsRemote(): RemoteConfig {
    return { name: "fs", type: "fs", config: { root: remoteRoot } };
  }

  it("put writes to the disk; get reads it back", async () => {
    const a = createOpenDALAdapter(fsRemote(), noTokens);
    await a.put("hello.txt", Buffer.from("world", "utf8"));
    const onDisk = await readFile(join(remoteRoot, "hello.txt"), "utf8");
    assert.equal(onDisk, "world");
    const got = await a.get("hello.txt");
    assert.equal(got.toString("utf8"), "world");
  });

  it("stat / list / delete / rename roundtrip", async () => {
    const a = createOpenDALAdapter(fsRemote(), noTokens);
    await a.put("a/x.txt", Buffer.from("X"));
    await a.put("a/y.txt", Buffer.from("YY"));

    const s = await a.stat("a/x.txt");
    assert.ok(s);
    assert.equal(s.size, 1);

    const ls = await a.list("a/");
    const paths = ls.map((e) => e.path).sort();
    assert.deepEqual(paths, ["a/x.txt", "a/y.txt"]);

    await a.rename("a/x.txt", "a/z.txt");
    assert.equal(await a.stat("a/x.txt"), null);
    assert.ok(await a.stat("a/z.txt"));

    await a.delete("a/y.txt");
    assert.equal(await a.stat("a/y.txt"), null);
  });

  it("url returns a file:// URL for fs backend", async () => {
    const a = createOpenDALAdapter(fsRemote(), noTokens);
    const u = await a.url("foo.txt");
    assert.ok(u.startsWith("file://"));
    assert.ok(u.includes("foo.txt"));
  });

  it("list of missing prefix returns empty array (no throw)", async () => {
    const a = createOpenDALAdapter(fsRemote(), noTokens);
    const ls = await a.list("does/not/exist/");
    assert.deepEqual(ls, []);
  });
});
