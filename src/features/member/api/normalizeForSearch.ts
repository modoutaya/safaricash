// Story 2.1 — case- + diacritic-insensitive normalisation for search match.
//
// Example: normalizeForSearch("Fâtôu Ndiaye") === "fatou ndiaye"
// Uses NFD decomposition + the Unicode `Diacritic` property to strip
// combining marks. Gracefully no-ops on runtimes that don't support the
// `\p{Diacritic}` regex flag (none known for Node 22 / modern Chromium).

export function normalizeForSearch(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}
