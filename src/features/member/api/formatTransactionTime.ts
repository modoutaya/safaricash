// Story 2.4 — French short-form date+time for transaction rows.
//
// Output: "lun. 12 avr. à 09:14" (compact, mobile-friendly per the
// founder's choice in the 2.4 spec Q4 review).

const formatter = new Intl.DateTimeFormat("fr-FR", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatTransactionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // Intl returns e.g. "lun. 12 avr. 09:14" — insert "à" before the time
  // for the natural French phrasing. Split on the last space-separated
  // tokens (hour:minute) to be locale-format-tolerant.
  const formatted = formatter.format(date);
  // Most fr-FR Intl outputs use a comma between date and time:
  // "lun. 12 avr. 2026, 09:14" or "lun. 12 avr. 09:14" depending on
  // ICU version. Normalize: replace ", " or " " before the HH:MM with " à ".
  return formatted.replace(/[,]?\s+(\d{2}:\d{2})$/, " à $1");
}
