// Pure form-validation helpers behind Settings › Runners
// (apps/web/src/lib/runners.ts) -- mirrors apps/server/domain/runner/
// instances.ts's key-refusal rules and env text parsing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";
import {
  envKeysToText,
  isPortuniEnvKey,
  isSecretShapedEnvKey,
  parseEnvText,
  validateEnvKeys,
} from "../apps/web/src/lib/runners.js";

const { i18n } = createI18n({
  lng: "en",
  resources: { en: RESOURCES.en, cs: RESOURCES.cs },
  escapeValue: false,
  initAsync: false,
});
const tEn = i18n.getFixedT("en", "settings");

describe("isSecretShapedEnvKey", () => {
  it("flags *_TOKEN/*_KEY/*_SECRET/*PASSWORD* case-insensitively", () => {
    for (const key of ["ANTHROPIC_API_KEY", "gh_token", "MY_SECRET", "DB_PASSWORD", "password_hash"]) {
      assert.equal(isSecretShapedEnvKey(key), true, key);
    }
  });

  it("does not flag ordinary keys", () => {
    for (const key of ["CLAUDE_CONFIG_DIR", "EDITOR", "PATH"]) {
      assert.equal(isSecretShapedEnvKey(key), false, key);
    }
  });
});

describe("isPortuniEnvKey", () => {
  it("flags any PORTUNI_* key case-insensitively", () => {
    assert.equal(isPortuniEnvKey("PORTUNI_MCP_TOKEN"), true);
    assert.equal(isPortuniEnvKey("portuni_root"), true);
  });

  it("does not flag an unrelated key", () => {
    assert.equal(isPortuniEnvKey("CLAUDE_CONFIG_DIR"), false);
  });
});

describe("validateEnvKeys", () => {
  it("returns null when every key is fine", () => {
    assert.equal(validateEnvKeys({ CLAUDE_CONFIG_DIR: "/x" }, tEn), null);
  });

  it("returns a message naming the first secret-shaped key", () => {
    const message = validateEnvKeys({ CLAUDE_CONFIG_DIR: "/x", API_KEY: "sk-1" }, tEn);
    assert.equal(
      message,
      "“API_KEY” looks like a secret (*_TOKEN/*_KEY/*_SECRET/*PASSWORD*); store it in the OS keychain, not here.",
    );
  });

  it("returns a message naming a PORTUNI_* key", () => {
    const message = validateEnvKeys({ PORTUNI_ROOT: "v" }, tEn);
    assert.equal(message, "“PORTUNI_ROOT”: PORTUNI_* variables cannot be set from the instance registry.");
  });
});

describe("parseEnvText", () => {
  it("parses KEY=value lines, trimming whitespace and skipping blanks/comments", () => {
    const text = "A=1\n  B = 2 \n\n# comment\nC=";
    assert.deepEqual(parseEnvText(text), { A: "1", B: "2", C: "" });
  });

  it("ignores a line with no '=' or a leading '='", () => {
    assert.deepEqual(parseEnvText("noequals\n=leadingeq"), {});
  });
});

describe("envKeysToText", () => {
  it("renders each key with an empty value, one per line", () => {
    assert.equal(envKeysToText(["A", "B"]), "A=\nB=");
  });

  it("round trips with parseEnvText back to empty values", () => {
    assert.deepEqual(parseEnvText(envKeysToText(["A", "B"])), { A: "", B: "" });
  });
});
