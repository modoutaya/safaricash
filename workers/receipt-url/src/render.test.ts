import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import {
  renderComingSoonDisputeHtml,
  renderNotFoundHtml,
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

describe("renderComingSoonDisputeHtml", () => {
  const html = renderComingSoonDisputeHtml(TOKEN);

  it("contains the coming-soon message", () => {
    expect(html).toContain("Cette fonctionnalité arrive bientôt");
  });

  it("includes a back-link to /r/{token}", () => {
    expect(html).toContain(`href="/r/${TOKEN}"`);
  });

  it("does NOT contain a <script> tag", () => {
    expect(html).not.toContain("<script");
  });
});
