// Syntax highlighting for the chat's code blocks, on a curated language set.
//
// `@streamdown/code`'s own `code` plugin statically imports shiki's
// `bundledLanguages` -- a record of every language shiki ships mapped to its
// own dynamic import. Every one of those is reachable, so the bundler emits a
// chunk per grammar: 716 extra files and ~23 MB of `dist`, all of it signed
// into `Portuni.app` and into every updater payload, to highlight languages a
// task transcript will never contain (#380). The plugin exposes no way to
// narrow the set -- `CodePluginOptions` is `{ themes }` and nothing else.
//
// So this is that plugin's shape (`CodeHighlighterPlugin`, same contract
// Streamdown calls) over `shiki/core` with the languages named below and
// nothing more. Same caching behaviour as the original: a hit answers
// synchronously, a miss returns null and calls the callback once the grammar
// has loaded, and an unknown language falls back to unhighlighted `text`
// rather than failing the block.

import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationAny, type TokensResult } from "shiki/core";
// Type-only, so it is erased at build time and pulls no grammar with it.
import type { BundledLanguage, BundledTheme, HighlighterGeneric } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

type ThemeInput = string | ThemeRegistrationAny;

// What actually shows up in a task transcript: what this repo is written in,
// what an agent writes to a mirror, and what tool output looks like. Adding
// one is a line here plus a rebuild -- deliberately explicit, since the whole
// point is that the set is finite.
const LANGUAGES: Record<string, () => Promise<unknown>> = {
  bash: () => import("@shikijs/langs/bash"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  html: () => import("@shikijs/langs/html"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  sql: () => import("@shikijs/langs/sql"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  yaml: () => import("@shikijs/langs/yaml"),
};

// The aliases people actually type in a fence, mapped onto the ids above.
const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  md: "markdown",
  py: "python",
  rs: "rust",
  yml: "yaml",
  patch: "diff",
};

const THEMES: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];

function resolveLanguage(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  const id = ALIASES[key] ?? key;
  return id in LANGUAGES ? id : null;
}

let corePromise: Promise<HighlighterCore> | null = null;
function core(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = Promise.all([
      import("@shikijs/themes/github-light"),
      import("@shikijs/themes/github-dark"),
    ]).then(([light, dark]) =>
      createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }),
    );
  }
  return corePromise;
}

// Grammars already handed to the highlighter, so a second block in the same
// language does not re-import or re-load it.
const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();

function ensureLanguage(id: string): Promise<void> {
  if (loaded.has(id)) return Promise.resolve();
  let inFlight = loading.get(id);
  if (!inFlight) {
    inFlight = Promise.all([core(), LANGUAGES[id]()])
      .then(async ([highlighter, mod]) => {
        await highlighter.loadLanguage((mod as { default: never }).default);
        loaded.add(id);
      })
      .finally(() => {
        loading.delete(id);
      });
    loading.set(id, inFlight);
  }
  return inFlight;
}

// Keyed the way the original keys it: language, both theme names, and enough
// of the code that two different blocks cannot collide.
function cacheKey(code: string, id: string): string {
  const head = code.slice(0, 100);
  const tail = code.length > 100 ? code.slice(-100) : "";
  return `${id}:${code.length}:${head}:${tail}`;
}

const results = new Map<string, TokensResult>();
const waiting = new Map<string, Set<(result: TokensResult) => void>>();

// `components/ai-elements/code-block.tsx` (a copied component, ours to edit)
// has its own highlighter and called shiki's full-bundle `createHighlighter`,
// which is the second way every grammar became reachable. It only ever uses
// `getLoadedLanguages()` and `codeToTokens()`, both of which a core
// highlighter has, so this drop-in keeps that file's diff to its import line.
// The cast is the price: its types say `HighlighterGeneric<BundledLanguage,
// BundledTheme>`, and a core highlighter is that minus the bundle it no
// longer carries.
export async function createHighlighter(options: {
  langs: string[];
  themes: string[];
}): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  await Promise.all(options.langs.map((lang) => {
    const id = resolveLanguage(lang);
    return id ? ensureLanguage(id) : Promise.resolve();
  }));
  return (await core()) as unknown as HighlighterGeneric<BundledLanguage, BundledTheme>;
}

export const code = {
  name: "shiki" as const,
  type: "code-highlighter" as const,
  getThemes: () => THEMES,
  getSupportedLanguages: () => Object.keys(LANGUAGES),
  supportsLanguage: (language: string) => resolveLanguage(language) !== null,
  highlight(
    { code: source, language }: { code: string; language: string; themes?: [ThemeInput, ThemeInput] },
    callback?: (result: TokensResult) => void,
  ): TokensResult | null {
    const id = resolveLanguage(language);
    // An unsupported language is rendered as plain text rather than left
    // unhandled -- a block in a language we do not ship still has to appear.
    if (!id) return null;

    const key = cacheKey(source, id);
    const hit = results.get(key);
    if (hit) return hit;

    if (callback) {
      let listeners = waiting.get(key);
      if (!listeners) {
        listeners = new Set();
        waiting.set(key, listeners);
      }
      listeners.add(callback);
    }

    void ensureLanguage(id)
      .then(async () => {
        const highlighter = await core();
        const tokens = highlighter.codeToTokens(source, {
          lang: id,
          themes: { light: "github-light", dark: "github-dark" },
        });
        results.set(key, tokens);
        const listeners = waiting.get(key);
        if (listeners) {
          for (const listener of listeners) listener(tokens);
          waiting.delete(key);
        }
      })
      .catch((e: unknown) => {
        // A grammar that fails to load leaves the block unhighlighted; it is
        // never worth breaking the transcript over.
        console.error("[chat] code highlighting failed:", e);
        waiting.delete(key);
      });

    return null;
  },
};
