// Every call site in the codebase writes SQLite-style positional `?`
// placeholders (libsql's own convention); Postgres/PGlite's wire protocol
// wants `$1, $2, ...` instead. Rewriting happens here, inside the pg/PGlite
// drivers, so call sites never change (B3 relies on this for the dialect-
// neutral SQL pass). Skips over everything a `?` can legitimately sit
// inside without being a placeholder: quoted string/identifier literals,
// `--` line comments, `/* */` block comments, and dollar-quoted bodies
// (`$fn$ ... $fn$`, the trigger functions in schema-triggers.pg.ts), so a
// `?` in any of them never renumbers the placeholders after it.
export function rewritePositionalPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    // 'string' -- a doubled '' inside is two consecutive quotes, which this
    // loop handles naturally (close, then immediately reopen).
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "$") {
      // $tag$ ... $tag$ (tag may be empty). Only a well-formed opening tag
      // starts a dollar-quoted body; a bare `$1` from an already-rewritten
      // fragment is left alone.
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === "?") {
      n += 1;
      out += `$${n}`;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
