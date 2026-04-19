# SafariCash — Analyst → PM Handoff

**From:** Mary (Business Analyst)
**To:** John (Product Manager) — incoming
**Date:** 2026-04-18
**Next artifact to produce:** Product Requirements Document (PRD)
**Recommended skill chain:** `bmad-agent-pm` → `bmad-create-prd` → `bmad-validate-prd`

---

## 1. Handoff package contents

| # | Artifact | Location | Purpose |
|---|---|---|---|
| 1 | Source project brief | `_bmad-output/planning-artifacts/00-project-brief-source.md` | Founder's original intent, preserved verbatim |
| 2 | Business analysis | `_bmad-output/planning-artifacts/01-business-analysis.md` | SWOT, Porter, stakeholders, RAID, requirements synthesis |
| 3 | **This handoff** | `_bmad-output/planning-artifacts/02-pm-handoff.md` | What to focus on, what to resolve, what to park |

---

## 2. Elevator pitch (for your own alignment)

> SafariCash is a mobile-first SaaS that lets an individual savings-collector in West Africa digitize a 30-day fixed-cycle, daily-contribution workflow for up to 150 savers per route. The collector earns one day of contribution as commission per cycle. The product competes against paper notebooks today and, eventually, against whichever mobile-money operator ships a "collector mode" first.

---

## 3. What the PM should accept as settled

The following have been validated against the brief and should carry into the PRD unchanged unless field research contradicts:

- **Primary persona: the collector.** Single paying customer; 150+ members per collector is the workflow scale target.
- **30-day calendar cycle.** Commission = 1 × daily amount. Advances interest-free, deducted at settlement.
- **Mobile-first PWA on React 18 + TS + Supabase + Vercel** as the working stack assumption (architect to confirm).
- **Phased plan (MVP → Optimization → Scale)** with 4–6 week MVP window is the working roadmap.
- **Design system anchor:** Vert SafariCash #1D9E75, system-ui, emoji + SVG iconography, 44 px touch targets.

---

## 4. What the PM must resolve BEFORE PRD freeze

These are **blockers** — not opinions. Each has an owner recommendation and a proposed resolution path.

| # | Decision needed | Recommended owner | How to resolve | Blocker for |
|---|---|---|---|---|
| D1 | **Collector pricing model** (SaaS monthly / % of collection / freemium) | PM + Founder | Pricing sprint: 3 model hypotheses × 10 collector interviews | Monetization UI, subscription_plan field |
| D2 | **Saver-facing receipt: MVP or Phase 2?** | PM | Single decision memo, citing trust architecture | Notifications API selection, data model |
| D3 | **Legal structure at launch** (direct vs. IMF umbrella) | Founder + legal counsel | Engage WAEMU fintech counsel in week 1 | Entire go-to-market |
| D4 | **Offline conflict-resolution strategy** | Architect + PM | Architecture spike — event-sourced vs. state-replication | Data model, sync layer |
| D5 | **Saver identity model** (anonymous row vs. consented data subject) | PM + Legal | RGPD/UEMOA consent mapping | Member schema, onboarding UX |
| D6 | **Missed-day / partial-payment handling** | PM + Field research | Include in 10-collector interview script | Cycle engine logic (BR-6, BR-7) |
| D7 | **Device & OS baseline** (proposed: Android 8+ / iOS 13+) | PM | Field interview — ask each collector their device | PWA scope, testing matrix |
| D8 | **Multi-advance rules** (max advances, advance > projected balance) | PM | Interview-driven; add to BR list | Advance UX, validation |

---

## 5. What the PM should explicitly DEFER (and say so in the PRD)

Don't silently drop these — name them as deferred with a trigger condition:

- **Mobile-money payment integration** — defer to Phase 3, re-evaluate when pilot reaches 20 collectors.
- **Multi-collector / team tier** — defer to Phase 3, re-evaluate if field interviews show >30 % of collectors employ assistants.
- **Public API / white-label** — defer to Phase 3, re-evaluate on first inbound partnership request.
- **Advanced analytics dashboards** — defer; MVP ships with the 5 business-critical metrics only (active members, daily volume, completion rate, avg loan, commission).
- **Local-language UI** beyond French — defer unless field research shows French literacy floor blocks adoption.

---

## 6. Proposed PRD skeleton

Mirror this structure when you run `bmad-create-prd`:

1. **Problem statement & target user** (lift from Section 2 of analysis, tighten to 1 page)
2. **Success metrics** (6 / 12 / 18 / 24 month milestones from brief + 1 leading indicator per phase — add "time per transaction ≤ 5 sec" as an MVP leading metric)
3. **Scope**
   - In: functional requirements F1–F7 from analysis § 7.1
   - Out (Phase 2): F8 — PWA offline, push, advanced search, PDF export
   - Out (Phase 3): F9 — multi-collector, payments, API, white-label
   - **Deferred** (name them — see § 5 above)
4. **User journeys** (one per persona × critical path — collector onboarding, daily collection round, cycle settlement, advance request, saver receipt)
5. **Functional requirements** (F1–F9 from analysis; lift BR-1 through BR-11 into an explicit Business Rules section; resolve BR-6..BR-11 with field input)
6. **Non-functional requirements** (Section 7.2 table from analysis, with Section 4 blockers filled in)
7. **Data model** (high-level; hand off to architect with open question on `projected_final_balance` vs. `final_balance` split)
8. **Constraints & dependencies** (Section 8 RAID from analysis)
9. **Risks & mitigations** (R1–R7 from analysis — verbatim)
10. **Open questions / parking lot** (anything not resolved at PRD freeze)

---

## 7. Research I recommend the PM commission next

These are skills the PM can trigger directly from the BMad menu:

- `bmad-market-research` — **competitive landscape is missing.** Scope: direct savings-collector apps in Senegal / Côte d'Ivoire / Mali / Ghana; indirect incumbents (WhatsApp + Excel); payment-rail competitive posture.
- `bmad-domain-research` — **WAEMU microfinance regulation.** Scope: deposit-taking rules, IMF partnership templates, consumer protection, KYC/AML obligations for collector operators.
- `bmad-create-ux-design` — once PRD scope is locked, hand the 8-screen architecture to Sally (UX) for interaction-level spec; the brief's screen list is a good input, not a finished spec.
- `bmad-create-architecture` — Winston (architect) to pressure-test Supabase + PWA offline-sync choice, with specific focus on D4 (conflict resolution).

---

## 8. Two judgment calls I'd stake a reputation on

For fast decisions:

1. **Ship saver-facing SMS receipt in MVP.** It is the single change that most strengthens the trust moat. The cost (one Termii call per transaction ≈ 20–50 FCFA) is knowable and manageable; the alternative (digitize only the collector's side) reproduces the paper problem's trust deficit and invites a well-designed competitor to take the category with "receipts-to-savers" as their hook.

2. **Close the pricing question in week 1, not week 4.** Every UI decision (plan picker, usage limits, paywalls, subscription_plan field) cascades from this. A product with ambiguous pricing at MVP typically locks into freemium by accident.

---

## 9. What I'd love to see back from the PM

- A decision memo on each of D1–D8 (even if the decision is "defer with condition X").
- A prioritized PRD with explicit **"cut line"** — if the MVP is running long, which requirements fall off the list and in what order?
- A field-research script used with the 10+ collector interviews, so the answers can be traced back to primary sources in the PRD.

---

## 10. Parking lot — things I noticed but didn't pursue

Not worth PM time right now, but worth capturing:

- The brief's budget (~20 k€ MVP) is plausible at contractor rates but tight for full-time staffing. PM may want to separate contractor-build from in-house-build scenarios.
- The "commission collecteur" language in the example is economically identical to a fee, but framing matters for regulator conversations. Consider the language used in saver-facing comms.
- The 24-month expansion plan (3 countries) is ambitious — the PRD's scope assumptions (single currency, single language, single regulator) may need a Phase 2.5 for cross-border.
- The demo dataset has a minor ambiguity between projected and realized `solde_final`. Flag to the architect.

---

**Good hunting, John.** Call me back into the room any time a scope question needs first-principles reasoning — I'll bring the magnifying glass. 🔍
