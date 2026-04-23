// Strip diacritics and lowercase a string for diacritic-insensitive search.
// "Návrhy a cenotvorba" and "navrhy a cenotvorba" both fold to the same key,
// so users can type without diacritics and still find Czech terms.
export function foldForSearch(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
