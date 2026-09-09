// Guards the class of bug that shipped in 0.13.6 and stopped the packaged
// app from rendering at all: a DOM global passed BY REFERENCE instead of
// called, so it later gets invoked with some other object as its receiver.
//
//   createUpdateScheduler({ setTimeout, clearTimeout, ... })   // <- the bug
//
// The functions land as properties on the deps object, the scheduler calls
// them as `deps.setTimeout(...)`, and a WebKit/WKWebView Window method
// refuses any receiver but a Window ("TypeError: Can only call
// Window.setTimeout on instances of Window"). Thrown out of a React effect
// during commit, that takes the whole tree down.
//
// Nothing else in the gate can see this. Typecheck and build are both blind
// to `this` binding; the unit tests inject plain functions, which have no
// receiver requirement; and a browser smoke test would not reach the code at
// all, since every such call site sits behind an `isTauri()` guard that is
// false outside the desktop shell. A source-level rule is what is left, and
// it is enough here: the mistake has one syntactic shape.
//
// The rule: these identifiers may be CALLED bare (`setTimeout(fn, 0)` is
// fine -- an unqualified call still gets the global object as its receiver)
// and may be reached through a receiver (`window.setTimeout`,
// `deps.clearTimeout`). What is refused is naming one in a value position --
// a shorthand property, a property value, a bare argument, an assignment
// right-hand side -- because that is where the receiver is dropped. Wrap it
// instead: `(fn, ms) => window.setTimeout(fn, ms)`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Window/global methods WebKit defines with a receiver check. Calling any of
// these with a foreign `this` throws rather than silently working, so passing
// one around detached is always a latent crash.
const RECEIVER_BOUND_GLOBALS = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "queueMicrotask",
  "fetch",
  "matchMedia",
  "getComputedStyle",
  "addEventListener",
  "removeEventListener",
  "postMessage",
  "scrollTo",
];
// `alert`, `confirm` and `prompt` are deliberately NOT on the list: this
// codebase uses all three as ordinary domain words (an agent prompt, a
// confirm handler), so the rule would be almost entirely false positives
// there while catching a mistake nobody makes -- those three are called,
// never handed around.

// A value position: what sits immediately before and after decides it.
// Before -- `{`, `,`, `(`, `[`, `:` or `=` -- means "this is being handed
// over". After -- `,`, `)`, `}`, `]`, `;` or end of input -- means "and not
// called". A type annotation (`setTimeout: (fn) => ...`) is followed by `:`,
// and `typeof setTimeout` is preceded by a word character, so both fall
// outside and stay allowed.
const OPENS_VALUE_POSITION = new Set(["{", ",", "(", "[", ":", "="]);
const CLOSES_VALUE_POSITION = new Set([",", ")", "}", "]", ";", ""]);

export type DetachedGlobal = { name: string; line: number };

// Blanks out comments and string/template bodies, keeping every newline so
// reported line numbers still line up with the original. Without this the
// rule trips over prose -- the comment above `windowTimerDeps` spells the
// offending shorthand out on purpose, and would flag itself.
export function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  const keep = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") out += keep(source[i++]);
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) out += keep(source[i++]);
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += " ";
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += keep(source[i++]);
      }
      out += " ";
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function findDetachedDomGlobals(rawSource: string): DetachedGlobal[] {
  const source = stripCommentsAndStrings(rawSource);
  const found: DetachedGlobal[] = [];
  for (const name of RECEIVER_BOUND_GLOBALS) {
    // Not preceded by `.` (a receiver) or a word character (`typeof x`, or
    // an identifier that merely ends with the same letters).
    const re = new RegExp(`(?<![.\\w$])${name}(?![\\w$])`, "g");
    for (const m of source.matchAll(re)) {
      const at = m.index ?? 0;
      const before = source.slice(0, at).trimEnd().slice(-1);
      const after = source.slice(at + name.length).trimStart().slice(0, 1);
      if (OPENS_VALUE_POSITION.has(before) && CLOSES_VALUE_POSITION.has(after)) {
        found.push({ name, line: source.slice(0, at).split("\n").length });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("findDetachedDomGlobals", () => {
  it("flags the exact shorthand that broke 0.13.6", () => {
    const found = findDetachedDomGlobals(`
      const scheduler = createUpdateScheduler({
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        checkDelayMs: CHECK_DELAY_MS,
      });
    `);
    assert.deepEqual(
      found.map((f) => f.name).sort(),
      ["clearInterval", "clearTimeout", "setInterval", "setTimeout"],
    );
  });

  it("flags a bare argument, an assignment and an explicit property value", () => {
    assert.equal(findDetachedDomGlobals("install(setTimeout);").length, 1);
    assert.equal(findDetachedDomGlobals("const t = setTimeout;").length, 1);
    assert.equal(findDetachedDomGlobals("const deps = { fetch: fetch };").length, 1);
  });

  it("allows a plain call -- an unqualified call keeps the global receiver", () => {
    assert.deepEqual(findDetachedDomGlobals("setTimeout(() => run(), 10);"), []);
    assert.deepEqual(findDetachedDomGlobals("const id = setInterval(tick, 5);"), []);
  });

  it("allows anything reached through a receiver", () => {
    assert.deepEqual(findDetachedDomGlobals("window.setTimeout(fn, 0);"), []);
    assert.deepEqual(findDetachedDomGlobals("deps.clearInterval(id);"), []);
    assert.deepEqual(findDetachedDomGlobals("const d = { setTimeout: win.setTimeout };"), []);
  });

  it("allows the wrapper form that replaced the bug", () => {
    assert.deepEqual(
      findDetachedDomGlobals("return { setTimeout: (fn, ms) => win.setTimeout(fn, ms) };"),
      [],
    );
  });

  it("ignores comments and string bodies, so prose about the bug is not the bug", () => {
    assert.deepEqual(
      findDetachedDomGlobals("// never write { setTimeout, clearTimeout } here\nrun();"),
      [],
    );
    assert.deepEqual(
      findDetachedDomGlobals("/* passing { setInterval, } detached breaks WebKit */\nrun();"),
      [],
    );
    assert.deepEqual(findDetachedDomGlobals('const msg = "{ setTimeout, }";'), []);
  });

  it("still reports the right line number after a comment was blanked out", () => {
    const found = findDetachedDomGlobals("// a comment\n\nconst t = setTimeout;\n");
    assert.deepEqual(found, [{ name: "setTimeout", line: 3 }]);
  });

  it("allows type positions", () => {
    assert.deepEqual(findDetachedDomGlobals("let t: ReturnType<typeof setTimeout> | null;"), []);
    assert.deepEqual(
      findDetachedDomGlobals("interface D { setTimeout: (fn: () => void, ms: number) => number }"),
      [],
    );
  });
});

describe("apps/web sources", () => {
  it("never hand a receiver-bound DOM global over detached", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("apps/web/src")) {
      for (const hit of findDetachedDomGlobals(readFileSync(file, "utf8"))) {
        offenders.push(`${file}:${hit.line} passes \`${hit.name}\` by reference`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Call it, or wrap it so the window stays the receiver -- see windowTimerDeps in apps/web/src/lib/update-schedule.ts:\n${offenders.join("\n")}`,
    );
  });
});
