import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sha256File,
  md5File,
  sha256Buffer,
  md5Buffer,
  statForCache,
} from "../src/domain/sync/hash.js";

async function makeTempFile(contents: string | Buffer): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "portuni-hash-"));
  const path = join(dir, "fixture.bin");
  await fs.writeFile(path, contents);
  return path;
}

describe("sha256File", () => {
  it("computes correct SHA-256 over a file", async () => {
    const path = await makeTempFile("hello");
    const expected = createHash("sha256").update("hello").digest("hex");
    const actual = await sha256File(path);
    assert.equal(actual, expected);
  });
});

describe("md5File", () => {
  it("computes correct MD5 over a file", async () => {
    const path = await makeTempFile("hello");
    const expected = createHash("md5").update("hello").digest("hex");
    const actual = await md5File(path);
    assert.equal(actual, expected);
  });
});

describe("sha256Buffer", () => {
  it("matches the file variant", async () => {
    const buf = Buffer.from("hello");
    const path = await makeTempFile(buf);
    const fileHash = await sha256File(path);
    const bufHash = sha256Buffer(buf);
    assert.equal(bufHash, fileHash);
  });
});

describe("md5Buffer", () => {
  it("matches the file variant", async () => {
    const buf = Buffer.from("hello");
    const path = await makeTempFile(buf);
    const fileHash = await md5File(path);
    const bufHash = md5Buffer(buf);
    assert.equal(bufHash, fileHash);
  });
});

describe("statForCache", () => {
  it("returns mtime from fs.stat().mtimeMs and matching byte length", async () => {
    const contents = "hello";
    const path = await makeTempFile(contents);
    const expected = await fs.stat(path);
    const result = await statForCache(path);
    assert.equal(result.mtime, expected.mtimeMs);
    assert.equal(result.size, Buffer.byteLength(contents));
    assert.equal(result.size, expected.size);
  });
});
