/** Czech noun form for a count of files: 1 → "soubor", 2–4 → "soubory", 5+ → "souborů". */
export function pluralFiles(n: number): string {
  if (n === 1) return "soubor";
  if (n >= 2 && n <= 4) return "soubory";
  return "souborů";
}
