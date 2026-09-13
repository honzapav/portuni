// Every call site in the codebase writes SQLite-style positional `?`
// placeholders (libsql's own convention); Postgres/PGlite's wire protocol
// wants `$1, $2, ...` instead. Rewriting happens here, inside the pg/PGlite
// drivers, so call sites never change (B3 relies on this for the dialect-
// neutral SQL pass). Skips over quoted string/identifier literals so a
// literal `?` inside one (rare, but SQL text can contain it) is not
// mistaken for a placeholder.
export function rewritePositionalPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inSingle) {
      out += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      out += c;
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      out += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      continue;
    }
    if (c === "?") {
      n += 1;
      out += `$${n}`;
      continue;
    }
    out += c;
  }
  return out;
}
