// The catalog check of the gate (spec: Tooling and the gate, item 5): for
// every key, the placeholders and <Trans> tags of the English and Czech
// messages match, and every Czech plural key renders its own form for
// count 1, 2, 5 and 1.5 without falling back.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES, NAMESPACES } from "../apps/server/shared/i18n/config.js";
import { getFixedT } from "../apps/server/shared/i18n/server.js";

const LOCALES_DIR = join(import.meta.dirname, "../apps/server/shared/i18n/locales");
const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_KEY = new RegExp(`^(.*)_(${PLURAL_SUFFIXES.join("|")})$`);

type Flat = Map<string, string>;

function flatten(value: unknown, prefix = "", out: Flat = new Map()): Flat {
  if (typeof value === "string") {
    out.set(prefix, value);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function readCatalog(locale: string, ns: string): Flat {
  return flatten(JSON.parse(readFileSync(join(LOCALES_DIR, locale, `${ns}.json`), "utf8")));
}

// {{name}} and {{name, format}} -> name; $t(...) nesting is not used.
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{\{\s*([^,}\s]+)[^}]*\}\}/g)].map((m) => m[1]).sort();
}

// <link>, </link>, <br/> -> link, /link, br/
function tags(message: string): string[] {
  return [...message.matchAll(/<(\/?)([A-Za-z0-9_-]+)\s*(\/?)>/g)]
    .map((m) => `${m[1]}${m[2]}${m[3]}`)
    .sort();
}

function baseKey(key: string): string {
  return PLURAL_KEY.exec(key)?.[1] ?? key;
}

// Every message of a key in a locale; a plural key's forms are grouped.
function byBaseKey(flat: Flat): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, message] of flat) {
    const base = baseKey(key);
    out.set(base, [...(out.get(base) ?? []), message]);
  }
  return out;
}

describe("i18n catalog", () => {
  it("has a file for every locale and namespace, and nothing else", () => {
    for (const locale of LOCALES) {
      const files = readdirSync(join(LOCALES_DIR, locale)).sort();
      assert.deepEqual(files, NAMESPACES.map((ns) => `${ns}.json`).sort(), locale);
    }
  });

  for (const ns of NAMESPACES) {
    it(`${ns}: placeholders and <Trans> tags match between en and cs`, () => {
      const en = byBaseKey(readCatalog("en", ns));
      const cs = byBaseKey(readCatalog("cs", ns));
      assert.deepEqual([...cs.keys()].sort(), [...en.keys()].sort(), `${ns}: keys differ`);
      for (const [key, enMessages] of en) {
        const csMessages = cs.get(key) ?? [];
        for (const message of [...enMessages, ...csMessages]) {
          assert.deepEqual(
            placeholders(message),
            placeholders(enMessages[0]),
            `${ns}:${key}: placeholders of "${message}"`,
          );
          assert.deepEqual(tags(message), tags(enMessages[0]), `${ns}:${key}: tags of "${message}"`);
        }
      }
    });

    it(`${ns}: every cs plural renders its own form for 1, 2, 5 and 1.5`, () => {
      const cs = readCatalog("cs", ns);
      const bases = new Set([...cs.keys()].filter((k) => PLURAL_KEY.test(k)).map(baseKey));
      const rules = new Intl.PluralRules("cs");
      const t = getFixedT("cs", ns);
      for (const base of bases) {
        for (const count of [1, 2, 5, 1.5]) {
          const form = rules.select(count);
          const own = cs.get(`${base}_${form}`);
          assert.ok(own, `${ns}:${base}_${form} is missing (count ${count})`);
          // Every other placeholder gets a marker value, so the expected text
          // is the Czech form with its placeholders filled in.
          const values: Record<string, string | number> = { count };
          for (const name of placeholders(own)) if (name !== "count") values[name] = `<${name}>`;
          const expected = own.replace(/\{\{\s*([^,}\s]+)[^}]*\}\}/g, (_, name: string) =>
            String(values[name]),
          );
          const rendered = (t as unknown as (key: string, options: object) => string)(base, {
            ...values,
            interpolation: { escapeValue: false },
          });
          assert.equal(rendered, expected, `${ns}:${base} (count ${count})`);
        }
      }
    });
  }
});
