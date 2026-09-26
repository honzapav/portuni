// The account's UI language (#538): which language a window switches to
// once /me answers, and the locale every session request carries.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accountLocaleSwitch,
  requestLocale,
  setRequestLanguageSource,
  toRequestLocale,
} from "../apps/web/src/lib/locale.js";

describe("account locale after /me", () => {
  it("switches to the account's language when it differs from the cache", () => {
    assert.equal(accountLocaleSwitch({ account: "cs", cached: "en", current: "en", allowPseudo: false }), "cs");
    assert.equal(accountLocaleSwitch({ account: "en", cached: null, current: "cs", allowPseudo: false }), "en");
  });

  it("does nothing when the account, the cache and the UI already agree", () => {
    assert.equal(accountLocaleSwitch({ account: "cs", cached: "cs", current: "cs", allowPseudo: false }), null);
  });

  it("keeps the resolved language when the account has none or an unknown one", () => {
    assert.equal(accountLocaleSwitch({ account: null, cached: "cs", current: "cs", allowPseudo: false }), null);
    assert.equal(accountLocaleSwitch({ account: undefined, cached: null, current: "en", allowPseudo: false }), null);
    assert.equal(accountLocaleSwitch({ account: "de", cached: "en", current: "en", allowPseudo: false }), null);
  });

  it("leaves a cached pseudo alone only in a dev build", () => {
    assert.equal(accountLocaleSwitch({ account: "cs", cached: "pseudo", current: "pseudo", allowPseudo: true }), null);
    assert.equal(accountLocaleSwitch({ account: "cs", cached: "pseudo", current: "cs", allowPseudo: false }), "cs");
  });
});

describe("request locale", () => {
  after(() => setRequestLanguageSource(() => null));

  it("is the UI language when it is a catalog language, else English", () => {
    assert.equal(toRequestLocale("cs"), "cs");
    assert.equal(toRequestLocale("en"), "en");
    assert.equal(toRequestLocale("pseudo"), "en");
    assert.equal(toRequestLocale(undefined), "en");
  });

  it("reads the language from the registered source", () => {
    assert.equal(requestLocale(), "en");
    setRequestLanguageSource(() => "cs");
    assert.equal(requestLocale(), "cs");
    setRequestLanguageSource(() => "pseudo");
    assert.equal(requestLocale(), "en");
  });
});
