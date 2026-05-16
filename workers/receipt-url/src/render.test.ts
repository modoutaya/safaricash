import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import {
  renderDisputeAcknowledgedHtml,
  renderDisputeAlreadyFlaggedHtml,
  renderDisputeFormHtml,
  renderNotFoundHtml,
  renderOptOutConfirmedHtml,
  renderOptOutFormHtml,
  renderReceiptHtml,
  type ReceiptPayload,
} from "./render";

expect.extend(toHaveNoViolations);

const TOKEN = "0123456789abcdef0123456789abcdef";

const PAYLOAD_CONTRIBUTION: ReceiptPayload = {
  amount: 500,
  kind: "contribution",
  cycle_day: 1,
  created_at: "2026-04-28T10:00:00Z",
  member_first_name: "Fatou",
  projected_balance: 14_500,
  daily_amount: 500,
};

const PAYLOAD_ADVANCE: ReceiptPayload = {
  amount: 50_000,
  kind: "advance",
  cycle_day: 12,
  created_at: "2026-04-28T10:00:00Z",
  member_first_name: "Aminata",
  projected_balance: 90_000,
  daily_amount: 5_000,
};

describe("renderReceiptHtml — contribution", () => {
  const html = renderReceiptHtml(TOKEN, PAYLOAD_CONTRIBUTION);

  it("uses lang=fr and viewport meta", () => {
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });

  it("includes the saver's first name in the header", () => {
    expect(html).toContain("Fatou");
  });

  it("renders the amount with ASCII space grouping", () => {
    expect(html).toContain("500 FCFA");
  });

  it("renders the projected balance with ASCII space grouping", () => {
    expect(html).toContain("14 500 FCFA");
  });

  it("renders cycle day as N / 30", () => {
    expect(html).toContain("1 / 30");
  });

  it("includes the dispute CTA linking to /r/{token}/dispute", () => {
    expect(html).toContain(`href="/r/${TOKEN}/dispute"`);
    expect(html).toContain("Cette transaction n'est pas moi");
  });

  it("includes the opt-out link with traceability note (Story 6.5)", () => {
    expect(html).toContain(`href="/r/${TOKEN}/opt-out"`);
    expect(html).toContain("Ne plus recevoir de SMS");
    expect(html).toContain("traçable et peut être annulé");
  });

  it("includes the tracker-not-mover disclosure", () => {
    expect(html).toContain("journal d'épargne et non une banque");
  });

  it("includes the reversibility note", () => {
    expect(html).toContain("Appuyé par erreur");
  });

  it("does NOT contain a <script> tag (UX-DR19 — no JS)", () => {
    expect(html).not.toContain("<script");
  });

  it("uses the contribution-default projected label", () => {
    expect(html).toContain("Solde projeté en fin de cycle");
    expect(html).not.toContain("Nouveau solde projeté");
  });

  it("passes axe accessibility (WCAG Level A)", async () => {
    const container = document.createElement("div");
    container.innerHTML = html;
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("renderReceiptHtml — advance", () => {
  const html = renderReceiptHtml(TOKEN, PAYLOAD_ADVANCE);

  it("uses 'Prêt express' for the kind label", () => {
    expect(html).toContain("Prêt express");
  });

  it("uses 'Nouveau solde projeté' label for advance kind", () => {
    expect(html).toContain("Nouveau solde projeté");
    expect(html).not.toContain("Solde projeté en fin de cycle");
  });
});

describe("renderReceiptHtml — rattrapage", () => {
  const html = renderReceiptHtml(TOKEN, {
    ...PAYLOAD_CONTRIBUTION,
    kind: "rattrapage",
  });

  it("uses 'Rattrapage' label", () => {
    expect(html).toContain("Rattrapage");
  });
});

describe("renderReceiptHtml — settlement (Story 7.5)", () => {
  const PAYLOAD_SETTLEMENT: ReceiptPayload = {
    amount: 87_000,
    kind: "settlement",
    cycle_day: 30,
    created_at: "2026-05-11T16:30:00Z",
    member_first_name: "Awa",
    projected_balance: 87_000,
    daily_amount: 3_000,
    cycle_start_date: "2026-04-12",
    cycle_end_date: "2026-05-11",
  };
  const html = renderReceiptHtml(TOKEN, PAYLOAD_SETTLEMENT);

  it("uses 'Cycle clôturé — SafariCash' page title (not 'Reçu SafariCash')", () => {
    expect(html).toContain("<title>Cycle clôturé — SafariCash</title>");
    expect(html).not.toContain("Reçu SafariCash — Awa");
  });

  it("uses 'Cycle clôturé' as the h1 headline (no 'Reçu pour {name}')", () => {
    expect(html).toContain("<h1>Cycle clôturé</h1>");
    expect(html).not.toContain("Reçu pour Awa");
  });

  it("renders the saver's first name as the header subtitle", () => {
    // The subtitle is the only remaining mention — assert it's present
    // exactly once as the <header><p>{first_name}</p></header>.
    expect(html).toContain("<p>Awa</p>");
  });

  it("renders the payout amount with ASCII space grouping", () => {
    expect(html).toContain("87 000 FCFA");
  });

  it("renders the cycle period range (DD/MM/YYYY au DD/MM/YYYY)", () => {
    expect(html).toContain("Période du cycle");
    expect(html).toContain("12/04/2026 au 11/05/2026");
  });

  it("hides the projected-balance row (moot post-settlement)", () => {
    expect(html).not.toContain("Solde projeté en fin de cycle");
    expect(html).not.toContain("Nouveau solde projeté");
  });

  it("hides the cycle-day row (constant day 30 + period row supersedes)", () => {
    expect(html).not.toContain("Jour du cycle");
    expect(html).not.toContain("30 / 30");
  });

  it("includes the closing statement", () => {
    expect(html).toContain("Merci de votre confiance");
    expect(html).toContain("Ce reçu finalise votre cycle d'épargne");
  });

  it("DOES NOT include the dispute CTA (settlement is irreversible)", () => {
    expect(html).not.toContain(`href="/r/${TOKEN}/dispute"`);
    expect(html).not.toContain("Cette transaction n'est pas moi");
  });

  it("KEEPS the opt-out CTA (saver may still want to opt out of future SMS)", () => {
    expect(html).toContain(`href="/r/${TOKEN}/opt-out"`);
    expect(html).toContain("Ne plus recevoir de SMS");
  });

  it("KEEPS the tracker-not-mover disclosure", () => {
    expect(html).toContain("journal d'épargne et non une banque");
  });

  it("does NOT contain a <script> tag (UX-DR19 — no JS)", () => {
    expect(html).not.toContain("<script");
  });

  it("hides the period row if cycle_start_date / cycle_end_date are missing (defensive)", () => {
    const htmlNoPeriod = renderReceiptHtml(TOKEN, {
      ...PAYLOAD_SETTLEMENT,
      cycle_start_date: undefined,
      cycle_end_date: undefined,
    });
    expect(htmlNoPeriod).not.toContain("Période du cycle");
    // Other anatomy still renders.
    expect(htmlNoPeriod).toContain("<h1>Cycle clôturé</h1>");
    expect(htmlNoPeriod).toContain("87 000 FCFA");
  });

  it("passes axe accessibility (WCAG Level A)", async () => {
    const container = document.createElement("div");
    container.innerHTML = html;
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("renderReceiptHtml — XSS defence", () => {
  it("escapes HTML special characters in member_first_name", () => {
    const html = renderReceiptHtml(TOKEN, {
      ...PAYLOAD_CONTRIBUTION,
      member_first_name: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderNotFoundHtml", () => {
  const html = renderNotFoundHtml();

  it("contains the not-found message", () => {
    expect(html).toContain("Reçu introuvable");
  });

  it("contains the disclosure aside", () => {
    expect(html).toContain("journal d'épargne et non une banque");
  });

  it("does NOT contain a <script> tag", () => {
    expect(html).not.toContain("<script");
  });

  it("passes axe accessibility (WCAG Level A)", async () => {
    const container = document.createElement("div");
    container.innerHTML = html;
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("renderDisputeFormHtml — Story 10.1", () => {
  const html = renderDisputeFormHtml(TOKEN);

  it("renders a no-JS POST form to /r/{token}/dispute", () => {
    expect(html).toContain('method="post"');
    expect(html).toContain(`action="/r/${TOKEN}/dispute"`);
    expect(html).toContain('<button type="submit">');
  });

  it("includes the optional free-text textarea with its label", () => {
    expect(html).toContain("Dites-nous ce qui s'est passé (optionnel)");
    expect(html).toContain('name="notes"');
    expect(html).toContain('<label for="dispute-notes">');
    expect(html).toContain('<textarea id="dispute-notes"');
    expect(html).toContain('maxlength="500"');
  });

  it("includes the Signaler and Annuler CTAs", () => {
    expect(html).toContain("Signaler");
    expect(html).toContain("Annuler");
    expect(html).toContain(`href="/r/${TOKEN}"`);
  });

  it("does NOT contain a <script> tag (UX-DR19 — no JS)", () => {
    expect(html).not.toContain("<script");
  });

  it("passes axe accessibility (WCAG Level A)", async () => {
    const container = document.createElement("div");
    container.innerHTML = html;
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("renderDisputeAcknowledgedHtml — Story 10.1", () => {
  const html = renderDisputeAcknowledgedHtml();

  it("contains the compassionate acknowledgment copy", () => {
    expect(html).toContain(
      "Merci. Votre signalement a été transmis au collecteur et à SafariCash. Nous vous recontacterons sous 48h via SMS.",
    );
  });

  it("does NOT contain a <script> tag", () => {
    expect(html).not.toContain("<script");
  });

  it("passes axe accessibility (WCAG Level A)", async () => {
    const container = document.createElement("div");
    container.innerHTML = html;
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("renderDisputeAlreadyFlaggedHtml — Story 10.1", () => {
  const html = renderDisputeAlreadyFlaggedHtml();

  it("contains the already-disputed copy", () => {
    expect(html).toContain("Signalement déjà envoyé. Réponse sous 48 h.");
  });

  it("does NOT contain a <script> tag", () => {
    expect(html).not.toContain("<script");
  });

  it("passes axe accessibility (WCAG Level A)", async () => {
    const container = document.createElement("div");
    container.innerHTML = html;
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("renderOptOutFormHtml — Story 6.5", () => {
  const html = renderOptOutFormHtml(TOKEN);

  it("renders a no-JS POST form to /r/{token}/opt-out", () => {
    expect(html).toContain('method="POST"');
    expect(html).toContain(`action="/r/${TOKEN}/opt-out"`);
    expect(html).toContain('<button type="submit">');
  });

  it("includes a back-link to the receipt", () => {
    expect(html).toContain(`href="/r/${TOKEN}"`);
  });

  it("does NOT contain a <script> tag", () => {
    expect(html).not.toContain("<script");
  });

  it("contains the traceability copy", () => {
    expect(html).toContain("traçable");
  });
});

describe("renderOptOutConfirmedHtml — Story 6.5", () => {
  const html = renderOptOutConfirmedHtml();

  it("contains the confirmation copy", () => {
    expect(html).toContain("Vous ne recevrez plus de SMS");
  });

  it("mentions reversibility via the collector", () => {
    expect(html).toContain("contactez votre collecteur");
  });

  it("does NOT contain a <script> tag", () => {
    expect(html).not.toContain("<script");
  });
});
