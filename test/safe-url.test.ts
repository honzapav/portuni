import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSafeExternalLink, sanitizeExternalLink } from "../src/shared/safe-url.js";

describe("isSafeExternalLink", () => {
  it("accepts https", () => {
    assert.equal(isSafeExternalLink("https://example.com"), true);
  });
  it("accepts http", () => {
    assert.equal(isSafeExternalLink("http://example.com/x"), true);
  });
  it("accepts mailto", () => {
    assert.equal(isSafeExternalLink("mailto:a@b.cz"), true);
  });
  it("rejects javascript:", () => {
    assert.equal(isSafeExternalLink("javascript:alert(1)"), false);
  });
  it("rejects javascript: with whitespace and case games", () => {
    assert.equal(isSafeExternalLink("  JaVaScRiPt:alert(1)"), false);
  });
  it("rejects data:", () => {
    assert.equal(isSafeExternalLink("data:text/html,<script>alert(1)</script>"), false);
  });
  it("rejects file:", () => {
    assert.equal(isSafeExternalLink("file:///etc/passwd"), false);
  });
  it("rejects empty / whitespace", () => {
    assert.equal(isSafeExternalLink(""), false);
    assert.equal(isSafeExternalLink("   "), false);
  });
  it("rejects non-URL strings", () => {
    assert.equal(isSafeExternalLink("just a label"), false);
  });
});

describe("sanitizeExternalLink", () => {
  it("returns trimmed value for safe URL", () => {
    assert.equal(sanitizeExternalLink("  https://example.com  "), "https://example.com");
  });
  it("returns null for unsafe URL", () => {
    assert.equal(sanitizeExternalLink("javascript:1"), null);
  });
  it("returns null for null/undefined", () => {
    assert.equal(sanitizeExternalLink(null), null);
    assert.equal(sanitizeExternalLink(undefined), null);
  });
});
