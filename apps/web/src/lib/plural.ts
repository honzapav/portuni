// Czech counts the noun by the number: 1 / 2-4 / 0 and 5+ each take their
// own form. One place for the forms the UI needs, so a count rendered in the
// sidebar and the same count rendered in the sync overview cannot drift.

/** Czech noun form for a count of files: 1 → "soubor", 2–4 → "soubory", 5+ → "souborů". */
export function pluralFiles(n: number): string {
  if (n === 1) return "soubor";
  if (n >= 2 && n <= 4) return "soubory";
  return "souborů";
}

/** Czech noun form for a count of nodes: 1 → "uzel", 2–4 → "uzly", 5+ → "uzlů". */
export function pluralNodes(n: number): string {
  if (n === 1) return "uzel";
  if (n >= 2 && n <= 4) return "uzly";
  return "uzlů";
}

/** Czech noun form for a count of plan changes: 1 → "změna", 2–4 → "změny", 5+ → "změn". */
export function pluralChanges(n: number): string {
  if (n === 1) return "změna";
  if (n >= 2 && n <= 4) return "změny";
  return "změn";
}
