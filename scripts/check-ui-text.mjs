#!/usr/bin/env node
// Gate check: no Czech text outside the catalog (spec:
// docs/superpowers/specs/2026-09-25-localization-design.md, "Tooling and the
// gate", item 6). Every file under apps/web/src, apps/desktop/src and
// apps/server is scanned with its comments removed; a Czech diacritic left in
// the code is a user-facing text that belongs in
// apps/server/shared/i18n/locales/. TypeScript is stripped by esbuild (types
// and comments go, strings and JSX text stay), Rust by a small lexer below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCAN = ["apps/web/src", "apps/desktop/src", "apps/server"];
// Paths that may hold Czech: the catalog itself, the glossary, the key types
// generated from the catalog, and the pseudo-locale's accent map (characters,
// not text).
const ALLOWED = [
  "apps/server/shared/i18n/locales/",
  "apps/server/shared/i18n/glossary.md",
  "apps/server/shared/i18n/types/",
  "apps/server/shared/i18n/pseudo.ts",
];
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "gen"]);
export const CZECH = /[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/;

/** Rust source with every comment removed; strings and chars kept. */
export function stripRustComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          if (src[i] === "\n") out += "\n";
          i++;
        }
      }
      continue;
    }
    // Raw string: r"..", r#".."#, br#".."#.
    const raw = /^b?r(#*)"/.exec(src.slice(i, i + 12));
    if (raw && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) {
      const close = `"${raw[1]}`;
      const end = src.indexOf(close, i + raw[0].length);
      const stop = end === -1 ? n : end + close.length;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      // A char literal ('x', '\n', '\u{..}'); a lifetime ('a) is copied as is.
      const m = /^'(\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'/u.exec(src.slice(i, i + 12));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** TypeScript/JavaScript source with types and comments removed. */
export function stripTsComments(src, file) {
  const loader = file.endsWith(".tsx")
    ? "tsx"
    : file.endsWith(".ts") || file.endsWith(".mts")
      ? "ts"
      : "js";
  return transformSync(src, {
    loader,
    charset: "utf8",
    legalComments: "none",
    // Whitespace minification is what drops every comment (a plain
    // transform keeps some); strings and JSX text come through unchanged.
    minifyWhitespace: true,
    jsx: "preserve",
    sourcefile: file,
  }).code;
}

const CZECH_WORD =
  /[^\s"'`<>{}()[\],;:=]*[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^\s"'`<>{}()[\],;:=]*/g;

/**
 * Offending lines of one file, `{ line, text }` in source line numbers. The
 * decision is made on the stripped code; the line is only looked up for the
 * report (the first source line holding the word outside a line comment).
 */
export function findCzech(src, file) {
  let code;
  if (file.endsWith(".rs")) code = stripRustComments(src);
  else if (/\.(ts|tsx|mts|js|mjs|jsx)$/.test(file)) code = stripTsComments(src, file);
  else code = src;
  const words = new Set(code.match(CZECH_WORD) ?? []);
  const srcLines = src.split("\n");
  const lines = new Map();
  for (const word of words) {
    let idx = srcLines.findIndex((l) => l.replace(/(^|\s)\/\/.*$/, "").includes(word));
    if (idx < 0) idx = srcLines.findIndex((l) => l.includes(word));
    lines.set(idx + 1, (srcLines[idx] ?? word).trim());
  }
  return [...lines].sort((a, b) => a[0] - b[0]).map(([line, text]) => ({ line, text }));
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(path);
    } else yield path;
  }
}

function main() {
  let failures = 0;
  for (const base of SCAN) {
    for (const path of walk(join(ROOT, base))) {
      const rel = relative(ROOT, path);
      if (ALLOWED.some((a) => rel.startsWith(a))) continue;
      const src = readFileSync(path, "utf8");
      if (!CZECH.test(src)) continue;
      for (const hit of findCzech(src, rel)) {
        failures++;
        console.error(`${rel}:${hit.line}: ${hit.text}`);
      }
    }
  }
  if (failures > 0) {
    console.error(
      `\n${failures} line(s) with Czech text outside the catalog. Move the text into apps/server/shared/i18n/locales/ and read it through t().`,
    );
    process.exit(1);
  }
  console.log("no Czech text outside the catalog");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
