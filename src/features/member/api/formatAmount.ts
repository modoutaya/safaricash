// Story 2.1 — FCFA amount formatter. French locale groups thousands with
// a non-breaking space (U+00A0) per NFR-L3. Intl.NumberFormat("fr-FR")
// already produces this — no manual concat.

const FR_FORMATTER = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

export function formatFcfaAmount(amount: number): string {
  return FR_FORMATTER.format(amount);
}
