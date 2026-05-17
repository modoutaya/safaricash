// Story 6.4 — receipt-page render module (no-JS, semantic HTML, UX-DR19).
//
// Pure template-literal HTML. Inline <style> block (no Tailwind, no
// build step). System-ui font stack. Mobile-first fluid layout (no
// breakpoints — UX-DR19).
//
// The render functions never embed user-controlled raw HTML — every
// dynamic value flows through `escapeHtml()` to defend against XSS.

export type ReceiptPayload = {
  amount: number;
  kind: "contribution" | "rattrapage" | "advance" | "settlement" | string;
  cycle_day: number;
  created_at: string; // ISO 8601
  member_first_name: string;
  projected_balance: number;
  daily_amount: number;
  /** Story 7.5 — cycle period for the settlement receipt page.
   *  ISO date strings YYYY-MM-DD. Optional for pre-Story-7.5 RPC versions. */
  cycle_start_date?: string;
  cycle_end_date?: string;
  /** Story 10.5 — when non-null the saver is anonymised (FR48); the
   *  receipt-page opt-out link is then omitted. ISO 8601 timestamp. */
  anonymised_at?: string | null;
};

const KIND_LABELS: Record<string, string> = {
  contribution: "Contribution",
  rattrapage: "Rattrapage",
  advance: "Prêt express",
  settlement: "Clôture du cycle",
};

const TRACKER_DISCLOSURE =
  "SafariCash est un journal d'épargne et non une banque. Cette page documente votre transaction; aucune somme n'est mouvementée par SafariCash.";

const REVERSIBILITY_NOTE = "Appuyé par erreur ? Vous pourrez annuler dans les 24h.";

const DISPUTE_CTA_LABEL = "Cette transaction n'est pas moi";

// Story 10.1 — dispute confirmation + acknowledgment copy (UX-DR11 / FR33b).
const DISPUTE_FORM_INTRO =
  "Signaler un problème avec cette transaction. Votre collecteur et SafariCash en seront informés.";
const DISPUTE_NOTES_LABEL = "Dites-nous ce qui s'est passé (optionnel)";
const DISPUTE_CONFIRM_LABEL = "Signaler";
const DISPUTE_CANCEL_LABEL = "Annuler";
const DISPUTE_ACK =
  "Merci. Votre signalement a été transmis au collecteur et à SafariCash. Nous vous recontacterons sous 48h via SMS.";
const DISPUTE_ALREADY = "Signalement déjà envoyé. Réponse sous 48 h.";
const DISPUTE_NOTES_MAXLENGTH = 500;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAmount(value: number): string {
  // ASCII-space thousands grouping (matches the SMS rendering convention
  // from Story 6.3's format_sms_body helper).
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatDateTime(iso: string): string {
  // Africa/Dakar (UTC+0; no DST). Format: JJ/MM/AAAA HH:MM.
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const fmt = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Africa/Dakar",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(date);
}

/** Story 7.5 — cycle date formatter for the settlement receipt page.
 *  Input is YYYY-MM-DD (date-only); output is DD/MM/YYYY (no time, no TZ). */
function formatCycleDate(iso: string): string {
  // Append `T00:00:00Z` so the Date constructor doesn't apply local-TZ drift.
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  const fmt = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return fmt.format(date);
}

const STYLE_BLOCK = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5;
    color: #111827;
    background: #f9fafb;
    padding: 1.5rem 1rem;
  }
  main {
    max-width: 480px;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 12px;
    padding: 1.5rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }
  header h1 {
    font-size: 1.5rem;
    margin: 0 0 0.25rem;
    color: #085041;
  }
  header p {
    margin: 0 0 1.5rem;
    color: #4b5563;
    font-size: 0.95rem;
  }
  dl {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem 0;
    margin: 0 0 1.5rem;
  }
  dl > div {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid #e5e7eb;
  }
  dt {
    color: #4b5563;
    font-size: 0.95rem;
  }
  dd {
    margin: 0;
    font-weight: 600;
    text-align: right;
    color: #111827;
  }
  .dispute {
    background: #faece7;
    border-radius: 8px;
    padding: 1rem;
    margin: 0 0 1rem;
  }
  .dispute a {
    display: block;
    background: #b91c1c;
    color: #ffffff;
    text-align: center;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    text-decoration: none;
    font-weight: 600;
  }
  .dispute a:hover, .dispute a:focus { text-decoration: underline; }
  .dispute small {
    display: block;
    margin-top: 0.5rem;
    color: #6b7280;
    font-size: 0.875rem;
    text-align: center;
  }
  aside.disclosure {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid #e5e7eb;
    color: #6b7280;
    font-size: 0.85rem;
  }
  .not-found {
    color: #4b5563;
    font-size: 1rem;
  }
  .settlement-closing {
    margin: 0 0 1.5rem;
    padding: 1rem;
    background: #e1f5ee;
    color: #085041;
    border-radius: 8px;
    text-align: center;
    font-size: 0.95rem;
  }
  .opt-out {
    margin-top: 1rem;
    text-align: center;
  }
  .opt-out a {
    color: #6b7280;
    font-size: 0.9rem;
    text-decoration: underline;
  }
  .opt-out small {
    display: block;
    margin-top: 0.25rem;
    color: #9ca3af;
    font-size: 0.8rem;
  }
  .opt-out-form {
    margin-top: 1rem;
    text-align: center;
  }
  .opt-out-form button {
    background: #4b5563;
    color: #ffffff;
    padding: 0.75rem 1.25rem;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
  }
  .opt-out-form button:hover, .opt-out-form button:focus {
    background: #374151;
  }
  .opt-out-confirmed {
    color: #4b5563;
    font-size: 1rem;
  }
  .dispute-form {
    background: #faece7;
    border-radius: 8px;
    padding: 1rem;
    margin: 1rem 0 0;
  }
  .dispute-form p.intro {
    margin: 0 0 1rem;
    color: #712b13;
    font-size: 0.95rem;
  }
  .dispute-form label {
    display: block;
    margin-bottom: 0.5rem;
    color: #4b5563;
    font-size: 0.9rem;
  }
  .dispute-form textarea {
    width: 100%;
    min-height: 5rem;
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-family: inherit;
    font-size: 1rem;
    resize: vertical;
  }
  .dispute-actions {
    margin-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .dispute-actions button {
    background: #b91c1c;
    color: #ffffff;
    padding: 0.75rem 1rem;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
  }
  .dispute-actions button:hover, .dispute-actions button:focus {
    background: #991b1b;
  }
  .dispute-actions a.cancel {
    text-align: center;
    padding: 0.75rem 1rem;
    color: #4b5563;
    text-decoration: underline;
    font-size: 0.95rem;
  }
  .dispute-ack {
    margin: 1rem 0 0;
    padding: 1rem;
    background: #e1f5ee;
    color: #085041;
    border-radius: 8px;
    font-size: 0.95rem;
  }
`.trim();

function htmlShell(title: string, bodyContent: string, lang: string = "fr"): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE_BLOCK}</style>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

/** Story 10.5 — the receipt-page footer opt-out link. Omitted entirely for
 *  an anonymised saver (AC #1): their data is already destroyed (FR48), so a
 *  "stop SMS" surface is incoherent — callers pass "" when anonymised_at is set. */
function optOutSection(token: string): string {
  return `<section class="opt-out" aria-label="Ne plus recevoir de SMS">
    <a href="/r/${escapeHtml(token)}/opt-out">Ne plus recevoir de SMS</a>
    <small>Votre opt-out est traçable et peut être annulé via votre collecteur.</small>
  </section>`;
}

export function renderReceiptHtml(token: string, payload: ReceiptPayload): string {
  // Story 7.5 — settlement receipt page is a separate visual surface
  // (different title / header / rows / no dispute CTA). Branch early
  // rather than weaving conditionals into the existing transaction layout.
  if (payload.kind === "settlement") {
    return renderSettlementReceiptHtml(token, payload);
  }

  const kindLabel = KIND_LABELS[payload.kind] ?? "Opération";
  const projectedLabel =
    payload.kind === "advance" ? "Nouveau solde projeté" : "Solde projeté en fin de cycle";

  const body = `
<main>
  <header>
    <h1>SafariCash</h1>
    <p>Reçu pour ${escapeHtml(payload.member_first_name)}</p>
  </header>

  <dl>
    <div>
      <dt>Montant reçu</dt>
      <dd>${formatAmount(payload.amount)} FCFA</dd>
    </div>
    <div>
      <dt>Date et heure</dt>
      <dd>${escapeHtml(formatDateTime(payload.created_at))}</dd>
    </div>
    <div>
      <dt>Jour du cycle</dt>
      <dd>${payload.cycle_day} / 30</dd>
    </div>
    <div>
      <dt>Type d'opération</dt>
      <dd>${escapeHtml(kindLabel)}</dd>
    </div>
    <div>
      <dt>${escapeHtml(projectedLabel)}</dt>
      <dd>${formatAmount(payload.projected_balance)} FCFA</dd>
    </div>
  </dl>

  <section class="dispute" aria-label="Signaler une transaction">
    <a href="/r/${escapeHtml(token)}/dispute">${DISPUTE_CTA_LABEL}</a>
    <small>${REVERSIBILITY_NOTE}</small>
  </section>

  ${payload.anonymised_at ? "" : optOutSection(token)}

  <aside class="disclosure">${TRACKER_DISCLOSURE}</aside>
</main>
`.trim();

  return htmlShell(`Reçu SafariCash — ${payload.member_first_name}`, body);
}

const SETTLEMENT_CLOSING_STATEMENT =
  "Merci de votre confiance. Ce reçu finalise votre cycle d'épargne.";

/** Story 7.5 — settlement receipt page.
 *  Different from the contribution / advance / rattrapage receipt:
 *  - "Cycle clôturé" headline (no "Reçu pour {name}").
 *  - Shows the cycle period (start → end) if available.
 *  - Skips the "projected balance" + "cycle day" rows (moot post-settlement).
 *  - Hides the dispute CTA (settlement is structurally irreversible).
 *  - Keeps the opt-out CTA + disclosure note. */
function renderSettlementReceiptHtml(token: string, payload: ReceiptPayload): string {
  const periodRow =
    payload.cycle_start_date && payload.cycle_end_date
      ? `
    <div>
      <dt>Période du cycle</dt>
      <dd>${escapeHtml(formatCycleDate(payload.cycle_start_date))} au ${escapeHtml(formatCycleDate(payload.cycle_end_date))}</dd>
    </div>`
      : "";

  const body = `
<main>
  <header>
    <h1>Cycle clôturé</h1>
    <p>${escapeHtml(payload.member_first_name)}</p>
  </header>

  <dl>
    <div>
      <dt>Montant reçu</dt>
      <dd>${formatAmount(payload.amount)} FCFA</dd>
    </div>
    <div>
      <dt>Cycle clôturé le</dt>
      <dd>${escapeHtml(formatDateTime(payload.created_at))}</dd>
    </div>${periodRow}
  </dl>

  <p class="settlement-closing">${SETTLEMENT_CLOSING_STATEMENT}</p>

  ${payload.anonymised_at ? "" : optOutSection(token)}

  <aside class="disclosure">${TRACKER_DISCLOSURE}</aside>
</main>
`.trim();

  return htmlShell("Cycle clôturé — SafariCash", body);
}

export function renderOptOutFormHtml(token: string): string {
  const body = `
<main>
  <header>
    <h1>SafariCash</h1>
  </header>
  <p>Confirmer l'arrêt des SMS de SafariCash sur ce numéro&nbsp;? Cette décision est traçable et peut être annulée via votre collecteur.</p>
  <form class="opt-out-form" method="POST" action="/r/${escapeHtml(token)}/opt-out">
    <button type="submit">Confirmer l'opt-out</button>
  </form>
  <p class="opt-out"><a href="/r/${escapeHtml(token)}">Retour au reçu</a></p>
  <aside class="disclosure">${TRACKER_DISCLOSURE}</aside>
</main>
`.trim();
  return htmlShell("Opt-out — SafariCash", body);
}

export function renderOptOutConfirmedHtml(): string {
  const body = `
<main>
  <header>
    <h1>SafariCash</h1>
  </header>
  <p class="opt-out-confirmed">Vous ne recevrez plus de SMS de SafariCash. Un SMS de confirmation vient de vous être envoyé. Cette décision est traçable et réversible — contactez votre collecteur pour reprendre les notifications.</p>
  <aside class="disclosure">${TRACKER_DISCLOSURE}</aside>
</main>
`.trim();
  return htmlShell("Opt-out confirmé — SafariCash", body);
}

export function renderNotFoundHtml(): string {
  const body = `
<main>
  <header>
    <h1>SafariCash</h1>
  </header>
  <p class="not-found">Reçu introuvable. Le lien que vous avez ouvert n'existe pas, ou la transaction a été annulée.</p>
  <aside class="disclosure">${TRACKER_DISCLOSURE}</aside>
</main>
`.trim();
  return htmlShell("Reçu introuvable — SafariCash", body);
}

/** Story 10.1 — GET /r/{token}/dispute. The dispute confirmation page:
 *  a no-JS server-rendered form (the UX "bottom-sheet"). "Signaler" POSTs;
 *  "Annuler" links back to the receipt. */
export function renderDisputeFormHtml(token: string): string {
  const body = `
<main>
  <header>
    <h1>SafariCash</h1>
    <p>Signaler une transaction</p>
  </header>
  <form class="dispute-form" method="post" action="/r/${escapeHtml(token)}/dispute">
    <p class="intro">${DISPUTE_FORM_INTRO}</p>
    <label for="dispute-notes">${DISPUTE_NOTES_LABEL}</label>
    <textarea id="dispute-notes" name="notes" maxlength="${DISPUTE_NOTES_MAXLENGTH}"></textarea>
    <div class="dispute-actions">
      <button type="submit">${DISPUTE_CONFIRM_LABEL}</button>
      <a class="cancel" href="/r/${escapeHtml(token)}">${DISPUTE_CANCEL_LABEL}</a>
    </div>
  </form>
  <aside class="disclosure">${TRACKER_DISCLOSURE}</aside>
</main>
`.trim();
  return htmlShell("Signaler une transaction — SafariCash", body);
}

/** Story 10.1 — the compassionate acknowledgment screen shown after a
 *  dispute is recorded. Trust/green palette — NOT red. */
export function renderDisputeAcknowledgedHtml(): string {
  const body = `
<main>
  <header>
    <h1>SafariCash</h1>
  </header>
  <p class="dispute-ack">${DISPUTE_ACK}</p>
  <aside class="disclosure">${TRACKER_DISCLOSURE}</aside>
</main>
`.trim();
  return htmlShell("Signalement reçu — SafariCash", body);
}

/** Story 10.1 — shown when an open dispute already exists for the
 *  transaction (idempotent re-submit). */
export function renderDisputeAlreadyFlaggedHtml(): string {
  const body = `
<main>
  <header>
    <h1>SafariCash</h1>
  </header>
  <p class="dispute-ack">${DISPUTE_ALREADY}</p>
  <aside class="disclosure">${TRACKER_DISCLOSURE}</aside>
</main>
`.trim();
  return htmlShell("Signalement déjà envoyé — SafariCash", body);
}
