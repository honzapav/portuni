import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDriveConfig, isDriveRemote, parseServiceAccountJson, assertSaDriveConfig } from "../apps/server/domain/sync/drive-config.js";

const sampleSA = JSON.stringify({
  type: "service_account",
  client_email: "portuni@proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n",
  token_uri: "https://oauth2.googleapis.com/token",
  project_id: "p", private_key_id: "k", client_id: "c",
});

describe("drive-config", () => {
  it("accepts valid shared drive config", () => {
    const c = parseDriveConfig({ shared_drive_id: "0AXyz" });
    assert.equal(c.shared_drive_id, "0AXyz");
    assert.equal(c.root_folder_id, undefined);
  });
  it("accepts optional root_folder_id", () => {
    const c = parseDriveConfig({ shared_drive_id: "0AXyz", root_folder_id: "1Abc" });
    assert.equal(c.root_folder_id, "1Abc");
  });
  it("rejects missing shared_drive_id", () => {
    assert.throws(() => parseDriveConfig({}), /shared_drive_id/);
  });
  it("parseServiceAccountJson accepts valid SA", () => {
    const sa = parseServiceAccountJson(sampleSA);
    assert.equal(sa.client_email, "portuni@proj.iam.gserviceaccount.com");
  });
  it("parseServiceAccountJson rejects malformed JSON", () => {
    assert.throws(() => parseServiceAccountJson("not json"), /JSON/);
  });
  it("parseServiceAccountJson rejects missing fields", () => {
    const bad = JSON.stringify({ type: "service_account", client_email: "x" });
    assert.throws(() => parseServiceAccountJson(bad), /private_key/);
  });
  it("isDriveRemote", () => {
    assert.ok(isDriveRemote({ name: "d", type: "gdrive", config: {} }));
  });

  // token_uri receives a JWT signed with the SA private key. An attacker
  // who can plant a crafted SA JSON must not be able to redirect that
  // signed assertion to their own server (SSRF + token-grant replay).
  it("parseServiceAccountJson rejects a non-Google token_uri", () => {
    const bad = JSON.stringify({
      type: "service_account",
      client_email: "x@p.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      token_uri: "https://attacker.example.com/token",
    });
    assert.throws(() => parseServiceAccountJson(bad), /token_uri/);
  });

  it("parseServiceAccountJson rejects a plain-http token_uri", () => {
    const bad = JSON.stringify({
      type: "service_account",
      client_email: "x@p.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      token_uri: "http://oauth2.googleapis.com/token",
    });
    assert.throws(() => parseServiceAccountJson(bad), /token_uri/);
  });
});

describe("parseDriveConfig (refresh-token era)", () => {
  it("accepts root_folder_id-only config (My Drive)", () => {
    const cfg = parseDriveConfig({ root_folder_id: "F1" });
    assert.equal(cfg.root_folder_id, "F1");
    assert.equal(cfg.shared_drive_id, undefined);
  });

  it("still accepts shared_drive_id-only config", () => {
    const cfg = parseDriveConfig({ shared_drive_id: "D1" });
    assert.equal(cfg.shared_drive_id, "D1");
  });

  it("rejects config with neither id", () => {
    assert.throws(() => parseDriveConfig({}), /shared_drive_id or root_folder_id/);
  });

  it("assertSaDriveConfig rejects My Drive for service accounts", () => {
    assert.throws(
      () => assertSaDriveConfig(parseDriveConfig({ root_folder_id: "F1" })),
      /Personal My Drive is not supported/,
    );
    assertSaDriveConfig(parseDriveConfig({ shared_drive_id: "D1" })); // no throw
  });
});
