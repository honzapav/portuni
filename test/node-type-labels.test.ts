// #533: the POPP node type labels live in the catalog once (common
// `node_type.*`), reached through one complete Record in
// apps/web/src/lib/node-type-labels.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";
import { NODE_TYPES } from "../apps/server/shared/popp.js";
import { isNodeType, nodeTypeLabel } from "../apps/web/src/lib/node-type-labels.js";

const { i18n } = createI18n({
  lng: "en",
  resources: { en: RESOURCES.en, cs: RESOURCES.cs },
  escapeValue: false,
  initAsync: false,
});
const tEn = i18n.getFixedT("en", "common");
const tCs = i18n.getFixedT("cs", "common");

describe("nodeTypeLabel", () => {
  it("labels every POPP node type in English", () => {
    assert.deepEqual(
      NODE_TYPES.map((type) => nodeTypeLabel(type, tEn)),
      ["Organization", "Project", "Process", "Area", "Principle"],
    );
  });

  it("labels every POPP node type in Czech", () => {
    assert.deepEqual(
      NODE_TYPES.map((type) => nodeTypeLabel(type, tCs)),
      ["Organizace", "Projekt", "Proces", "Oblast", "Princip"],
    );
  });

  it("shows a type this build does not know as stored", () => {
    assert.equal(isNodeType("widget"), false);
    assert.equal(nodeTypeLabel("widget", tEn), "widget");
  });
});
