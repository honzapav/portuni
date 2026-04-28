import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDriveConfig, isDriveRemote, parseServiceAccountJson } from "../src/domain/sync/drive-config.js";

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
});
