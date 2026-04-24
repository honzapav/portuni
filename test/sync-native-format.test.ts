import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectNativeFormat, EXPORT_MIME } from "../src/sync/native-format.js";

describe("native-format", () => {
  it("identifies Google Docs as native gdoc", () => {
    const r = detectNativeFormat("application/vnd.google-apps.document");
    assert.equal(r.is_native_format, true);
    assert.equal(r.native_format, "gdoc");
  });
  it("identifies Google Sheets as native gsheet", () => {
    const r = detectNativeFormat("application/vnd.google-apps.spreadsheet");
    assert.equal(r.native_format, "gsheet");
  });
  it("identifies Google Slides as native gslide", () => {
    const r = detectNativeFormat("application/vnd.google-apps.presentation");
    assert.equal(r.native_format, "gslide");
  });
  it("regular MIME types are not native", () => {
    const r = detectNativeFormat("application/pdf");
    assert.equal(r.is_native_format, false);
    assert.equal(r.native_format, undefined);
  });
  it("null/undefined handled", () => {
    assert.equal(detectNativeFormat(null).is_native_format, false);
    assert.equal(detectNativeFormat(undefined).is_native_format, false);
  });
  it("EXPORT_MIME has pdf/markdown/docx", () => {
    assert.equal(EXPORT_MIME.pdf, "application/pdf");
    assert.equal(EXPORT_MIME.markdown, "text/markdown");
    assert.ok(EXPORT_MIME.docx.includes("wordprocessing"));
  });
});
