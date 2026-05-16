// Story 9.3 / FR37 — CSV serialisation + browser download.
//
// Pure RFC-4180 serialisation (separately tested) + a browser-native
// download trigger (Blob + object URL + a programmatic <a download>).
// No CSV / file-saver dependency.

/** RFC 4180 — a field containing a comma, a double-quote, or a line break
 *  is wrapped in double quotes with any internal double-quote doubled.
 *  Member names are free user text, so every field is run through this. */
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export type CsvCell = string | number;

/** Serialise a header row + data rows into an RFC-4180 CSV string
 *  (CRLF line endings). Numbers are stringified as-is. */
export function toCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [headers, ...rows]
    .map((row) => row.map((cell) => escapeCsvField(String(cell))).join(","))
    .join("\r\n");
}

/** Trigger a browser download of `content` as a `text/csv` file named
 *  `filename`. No-op-safe in non-DOM environments (guards `document`). */
export function triggerCsvDownload(filename: string, content: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    // Always release the DOM node + object URL, even if click() throws.
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
