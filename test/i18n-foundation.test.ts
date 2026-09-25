// The i18n foundation (#528): the shared server instance, the pseudo-locale
// and the web's boot-language resolution.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  firstSupportedLocale,
  toSupportedLocale,
} from "../apps/server/shared/i18n/config.js";
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { PSEUDO_PADDING, pseudoLocalize } from "../apps/server/shared/i18n/pseudo.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";
import { getFixedT, serverI18n } from "../apps/server/shared/i18n/server.js";
import { resolveBootLocale } from "../apps/web/src/lib/locale.js";

describe("server i18n instance", () => {
  it("is ready synchronously, in English, with every namespace of both languages", () => {
    assert.equal(serverI18n.isInitialized, true);
    assert.equal(serverI18n.language, "en");
    assert.equal(serverI18n.hasResourceBundle("cs", "server"), true);
    assert.equal(serverI18n.hasResourceBundle("en", "errors"), true);
  });

  it("translates the sample key in both languages concurrently without crosstalk", async () => {
    // Interleave many requests in both languages across microtask and
    // macrotask boundaries; each keeps its own fixed language.
    const render = async (locale: "en" | "cs", i: number) => {
      const t = getFixedT(locale, "server");
      await Promise.resolve();
      const first = t(($) => $.sample.message, { userName: `user${i}` });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const second = t(($) => $.sample.message, { userName: `user${i}` });
      return { locale, first, second };
    };
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => render(i % 2 === 0 ? "en" : "cs", i)),
    );
    results.forEach(({ locale, first, second }, i) => {
      const expected = locale === "en" ? `Hello, user${i}.` : `Dobrý den, user${i}.`;
      assert.equal(first, expected);
      assert.equal(second, expected);
    });
    assert.equal(serverI18n.language, "en", "getFixedT never changes the instance language");
  });

  it("escapes interpolated values (server-rendered pages)", () => {
    const t = getFixedT("en", "server");
    assert.equal(t(($) => $.sample.message, { userName: "<b>x</b>" }), "Hello, &lt;b&gt;x&lt;&#x2F;b&gt;.");
  });

  it("renders plurals per language", () => {
    const en = getFixedT("en", "common");
    const cs = getFixedT("cs", "common");
    assert.equal(en(($) => $.sample.items, { count: 1 }), "1 item");
    assert.equal(en(($) => $.sample.items, { count: 5 }), "5 items");
    assert.equal(cs(($) => $.sample.items, { count: 2 }), "2 položky");
    assert.equal(cs(($) => $.sample.items, { count: 5 }), "5 položek");
  });

  it("carries a sample key in every namespace the web and server read", () => {
    const common = getFixedT("en", "common");
    const node = getFixedT("en", "node");
    const files = getFixedT("en", "files");
    const chat = getFixedT("en", "chat");
    const graph = getFixedT("en", "graph");
    const settings = getFixedT("en", "settings");
    const errors = getFixedT("en", "errors");
    assert.equal(common(($) => $.sample.link), "Open <link>settings</link>.");
    assert.equal(node(($) => $.sample.message, { nodeName: "A" }), "Details of the node A.");
    assert.equal(files(($) => $.sample.message, { nodeName: "A" }), "Files of the node A.");
    assert.equal(chat(($) => $.sample.message, { runnerName: "C" }), "Thread with C.");
    assert.equal(graph(($) => $.sample.message, { workspaceName: "W" }), "Graph of W.");
    assert.equal(settings(($) => $.sample.message, { workspaceName: "W" }), "Settings of W.");
    assert.equal(
      errors(($) => $.sample.message, { requestId: "r1" }),
      "Something went wrong (request r1).",
    );
  });
});

describe("pseudo-locale", () => {
  it("wraps, accents and pads by 35 %, keeping placeholders and tags", () => {
    const out = pseudoLocalize("Open <link>settings</link> for {{name}}");
    assert.ok(out.startsWith("⟦") && out.endsWith("⟧"));
    assert.ok(out.includes("<link>") && out.includes("</link>") && out.includes("{{name}}"));
    assert.ok(out.includes("Óp"), out);
    const letters = "Opensettingsfor".length;
    assert.ok(out.includes("~".repeat(Math.ceil(letters * PSEUDO_PADDING))), out);
  });

  it("applies only to the pseudo language of a pseudo-enabled instance", () => {
    const { i18n } = createI18n({
      lng: "pseudo",
      resources: { en: RESOURCES.en },
      escapeValue: false,
      initAsync: false,
      pseudo: true,
    });
    assert.equal(i18n.t(($) => $.sample.message, { userName: "Ann" }).startsWith("⟦"), true);
    assert.equal(
      i18n.getFixedT("en")(($) => $.sample.message, { userName: "Ann" }),
      "Welcome to Portuni, Ann.",
    );
  });
});

describe("boot locale", () => {
  it("maps language tags to a supported locale by primary subtag", () => {
    assert.equal(toSupportedLocale("cs-CZ"), "cs");
    assert.equal(toSupportedLocale("EN_us"), "en");
    assert.equal(toSupportedLocale("de"), null);
    assert.equal(firstSupportedLocale(["de-DE", "cs-CZ", "en"]), "cs");
    assert.equal(firstSupportedLocale([]), null);
  });

  it("prefers the window cache, then the OS language, then English", () => {
    assert.equal(resolveBootLocale({ cached: "cs", navigatorLanguages: ["en-US"], allowPseudo: false }), "cs");
    assert.equal(resolveBootLocale({ cached: null, navigatorLanguages: ["de", "cs-CZ"], allowPseudo: false }), "cs");
    assert.equal(resolveBootLocale({ cached: "fr", navigatorLanguages: ["de"], allowPseudo: false }), "en");
    assert.equal(resolveBootLocale({ cached: null, navigatorLanguages: undefined, allowPseudo: false }), "en");
  });

  it("honours a cached pseudo only in a dev build", () => {
    assert.equal(resolveBootLocale({ cached: "pseudo", navigatorLanguages: ["cs"], allowPseudo: true }), "pseudo");
    assert.equal(resolveBootLocale({ cached: "pseudo", navigatorLanguages: ["cs"], allowPseudo: false }), "cs");
  });
});
