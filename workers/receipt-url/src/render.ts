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
  kind: "contribution" | "rattrapage" | "advance" | string;
  cycle_day: number;
  created_at: string; // ISO 8601
  member_first_name: string;
  projected_balance: number;
  daily_amount: number;
};

const KIND_LABELS: Record<string, string> = {
  contribution: "Contribution",
  rattrapage: "Rattrapage",
  advance: "Prêt express",
};

const TRACKER_DISCLOSURE =
  "SafariCash est un journal d'épargne et non une banque. Cette page documente votre transaction; aucune somme n'est mouvementée par SafariCash.";

const REVERSIBILITY_NOTE = "Appuyé par erreur ? Vous pourrez annuler dans les 24h.";

const DISPUTE_CTA_LABEL = "Cette transaction n'est pas moi";

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

export function renderReceiptHtml(token: string, payload: ReceiptPayload): string {
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

  <aside class="disclosure">${TRACKER_DISCLOSURE}</aside>
</main>
`.trim();

  return htmlShell(`Reçu SafariCash — ${payload.member_first_name}`, body);
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

export function renderComingSoonDisputeHtml(token: string): string {
  const body = `
<main>
  <header>
    <h1>SafariCash</h1>
  </header>
  <p>Cette fonctionnalité arrive bientôt. Vous pourrez signaler une transaction ici dans une prochaine mise à jour.</p>
  <p><a href="/r/${escapeHtml(token)}">Retour au reçu</a></p>
  <aside class="disclosure">${TRACKER_DISCLOSURE}</aside>
</main>
`.trim();
  return htmlShell("Bientôt disponible — SafariCash", body);
}
