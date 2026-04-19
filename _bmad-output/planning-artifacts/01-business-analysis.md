# SafariCash — Business Analysis

**Author:** Mary (Business Analyst)
**Date:** 2026-04-18
**Source input:** `00-project-brief-source.md`
**Audience:** Product Manager (next owner), Founder, Architect
**Status:** Draft v1 — awaiting validation

---

## 1. Executive Summary

SafariCash is a **vertical SaaS for individual savings-collectors** in West Africa's informal sector — a niche that sits between traditional tontines (rotating group savings) and formal microfinance. The product digitizes a paper-based cash-collection workflow: a collector visits 50–150 savers daily, records a fixed daily contribution over a 30-day cycle, and settles the balance minus one day of commission and any advances granted.

The brief is **strong on workflow definition and UI vision** but has **material gaps on regulation, trust architecture, pricing, competitive moat, and field-operations reality** that must be closed before a PRD can commit scope. The MVP as scoped is technically achievable in 4–6 weeks; the commercial path to 500 collectors in 12 months is ambitious and depends on answers to the questions raised in Section 9.

**Recommendation:** proceed to PRD with scope-reducing guardrails around regulation and trust, and treat the "compliance & trust" layer as a first-class workstream, not a Phase 3 afterthought.

---

## 2. Strategic Context

### 2.1 The problem being solved

Individual cash-collectors ("collecteurs") operate a savings-discipline service for informal-sector merchants and artisans who cannot or will not use banks. Today the collector:
- Visits each saver daily for 30 days
- Records each contribution by hand in a notebook
- Grants informal advances against the expected end-of-cycle balance
- Settles the cycle manually, pocketing one day of contribution as commission

Pain points that the brief (explicitly or implicitly) targets:
- **Accounting errors** on end-of-cycle settlement — customer-trust killer
- **Scale ceiling** — a paper notebook tops out around 50 members
- **No traceability** — disputes are word-against-word
- **Unprofessional image** — paper receipts (or none) limit upward mobility for the collector

### 2.2 Why now?

Three tailwinds converge in WAEMU in 2026:
1. **Smartphone saturation** among young urban entrepreneurs (collectors' profile)
2. **Mobile-money ubiquity** (Wave, Orange Money, MTN MoMo) making digital settlement plausible
3. **Regulatory appetite** for financial inclusion at BCEAO level, with increasing tolerance for fintech pilots under IMF partnerships

### 2.3 Market sizing — order of magnitude

The brief gives no TAM/SAM/SOM, but a rough sanity check:
- Senegal + Côte d'Ivoire + Mali urban informal sector: ~5–8 M merchants/artisans
- Typical savings-collector coverage: ~1 collector per 50–150 savers
- Implied collector population (target markets, urban): **30,000 – 100,000**

Capturing 500 collectors in 12 months is **<2% of the low-bound TAM** — plausible commercially, but nothing about the brief explains *how* the first 500 are acquired. This is a gap.

---

## 3. Stakeholder Map

| Stakeholder | Role | What they want | What they fear |
|---|---|---|---|
| **Collector** (paying customer) | Runs the daily collection business | Scale beyond 50 members, look professional, avoid calculation errors | App crashes during a visit; savers lose trust if digital is opaque |
| **Saver** (end-user, non-payer) | Contributes daily, receives balance | Transparency, proof of contribution, quick advance access | Losing savings if collector disappears or app fails |
| **Savers' family** | Secondary beneficiary | Know savings are safe | Collector fraud |
| **Mobile money operators** (Wave, OM, MTN) | Potential payment rail + potential competitor | Expand B2B distribution | — |
| **MFIs / IMFs** | Potential regulatory umbrella | Acquire digitally-native collector networks | Regulatory liability if SafariCash mis-operates |
| **BCEAO / regional regulators** | Licensing authority | Consumer protection, AML | Unregulated deposit-taking at scale |
| **Incubators / Impact investors** | Capital + network | Outsized social + financial return | Unit economics don't scale |
| **Competing apps** | Copycats / incumbents | Market share | — |

**Key insight:** the brief treats the **collector** as the customer and rightly so — but the **saver's trust** is what makes the collector's business work. A design that serves only the collector and opaquely manages the saver's data risks breaking the underlying trust relationship it digitizes. This must be reflected in the PRD (e.g., saver-facing receipt / SMS / WhatsApp summary is not a "nice-to-have").

---

## 4. SWOT Analysis

### Strengths
- **Sharp problem-market fit**: a specific, observed workflow, not an invented one
- **Low initial capital intensity**: SaaS on Supabase + Vercel is cheap to run at MVP scale
- **Clear monetization hook**: collector is already paid via commission — willingness-to-pay for a tool that lets them 3× their member count is high
- **Mobile-first, offline-ready** is the correct technical posture for this market

### Weaknesses
- **Brief has no collector-pricing model defined** — SaaS monthly? % of collection? Free freemium? This is a P0 gap
- **App tracks cash; it does not move cash** — the fraud surface (collector skims, mis-entry) is unresolved
- **Team is thin** (1 dev, 1 design, 1 PM, 1 QA) for a regulated-adjacent product operating in multiple languages/countries
- **Offline sync conflict resolution** is mentioned but not designed — this is where paper-to-digital projects usually fail
- **150 members × daily visit = ~150 transactions/day per collector** — the UX must be *ruthlessly* optimized for transaction speed; the brief says so but doesn't quantify the target (e.g., "≤ 5 seconds per transaction")

### Opportunities
- **Data moat**: 12 months of collection data per collector is a credit-scoring goldmine. A future pivot to collector-funded microloans is latent here.
- **White-label channel**: IMFs and banks without digital collection infra would pay for a SafariCash-branded instance (Phase 3 already anticipates this — validate earlier)
- **Cross-border expansion is commercially clean** — WAEMU shares the FCFA currency, legal harmonization, and similar collector workflows

### Threats
- **Incumbent fintech feature-add risk**: Wave or Orange Money could ship a "collector mode" in a sprint. SafariCash's moat must be *workflow depth + trust brand*, not *existence of the feature*.
- **Regulatory risk**: if BCEAO classifies SafariCash as facilitating unlicensed deposit-taking, the model collapses. The brief names this but underweights it.
- **Single point of failure on trust**: one viral story of "collector disappeared with money, app did nothing" damages the category, not just one collector.
- **FX / macro risk**: FCFA-denominated SaaS pricing in a market with thin margins = recurring churn risk on any price increase.

---

## 5. Porter's Five Forces (abbreviated)

| Force | Intensity | Rationale |
|---|---|---|
| Threat of new entrants | **Medium-High** | Tech barrier low; trust/network barrier high. A well-funded local fintech could clone in 8–12 weeks. |
| Bargaining power of buyers (collectors) | **Low individually, Medium collectively** | Single collector has no leverage; a WhatsApp group of 500 collectors does. |
| Bargaining power of suppliers | **Medium** | Supabase, Twilio/Termii, Vercel are swappable but migration cost is real; mobile-money APIs have strong negotiating position. |
| Threat of substitutes | **High** | Paper notebook (free), Excel (free), generic accounting apps, direct mobile-money P2P, traditional tontines. |
| Rivalry among existing competitors | **Low today, rising** | Few direct competitors today — but the "savings-discipline digital" space will attract entrants as mobile money matures. |

**Strategic implication:** defensibility must come from (a) collector community / network effects, (b) integration depth with payment rails, and (c) data-driven adjacent services (credit scoring, insurance). Feature parity alone is not a moat.

---

## 6. Competitive & Adjacent Landscape (what the brief should check)

The brief does not include a competitive scan. A PM-ready analysis must explicitly position against:

- **Direct**: any existing digital tontine or savings-collector apps in West Africa (e.g., Oyi, Djamo for savings, Susu apps in Ghana like Sikasso, BezoMoney). **Action for PM:** commission a market research deep-dive (`bmad-market-research`) before PRD freeze.
- **Indirect**: WhatsApp + Excel + manual mobile-money (the *real* incumbent)
- **Payment rails**: Wave, Orange Money, MTN MoMo, Free Money — are they partners, channels, or future competitors?
- **MFIs going digital**: Baobab, Microcred/Baobab+, CREDITINFO — do they have collector-facing tooling yet?

**Gap flagged:** no competitive positioning in brief. This must be closed before PRD.

---

## 7. Requirements Synthesis

### 7.1 Functional requirements (extracted from brief)

**F1. Collector identity & onboarding**
- SMS OTP or magic-link email authentication
- Subscription plan field (implies paid tiers — definition missing)

**F2. Member lifecycle**
- Create member: name, phone, daily amount, cycle start date
- Preview 30-day cycle, commission, projected final balance before save
- Edit member with impact alerts on in-flight cycle
- Delete member with double confirmation + typed "SUPPRIMER" gate
- Restart cycle action

**F3. Daily transaction capture**
- Record contribution (type: contribution)
- Record advance/loan (type: advance, interest-free)
- Suggested amount auto-fill (defaults to member's daily amount)
- Real-time preview of updated balance, commission, final balance

**F4. Cycle engine**
- Fixed 30 calendar-day cycle
- Commission = 1 × daily_amount
- Final balance = Σ contributions − commission − Σ advances
- Status transitions: actif → avance (if any outstanding) → terminé (day 30)

**F5. Receipt & notification**
- Generate PDF receipt per transaction
- Send via SMS (Twilio/Termii) or WhatsApp (Business API)
- Receipt persisted (`receipt_url` on transaction)

**F6. Dashboard & reporting**
- Real-time stats: active members, today's collection, commission earned
- Recent activity feed with timestamps
- Weekly auto-report: cycles ending, members behind schedule
- Monthly auto-report: performance, top members
- End-of-cycle recap per member and per collector

**F7. Search & navigation**
- Instant search across 150+ members
- Status badges (actif / terminé / avance)
- Member 360 view with full chronological history

**F8. PWA / offline (Phase 2)**
- Installable on iOS/Android
- Offline transaction capture with later sync
- Push notifications

**F9. Multi-collector & payments (Phase 3)**
- Team/organization tier (multi-user under one collector business)
- Integration with Wave / Orange Money
- Public API, white-label, advanced analytics

### 7.2 Non-functional requirements (inferred — must be confirmed)

| Category | Target (proposed) | Source in brief |
|---|---|---|
| Transaction entry latency | ≤ 5 sec from app-open to confirmation | Implied by "150+ members/day" |
| Offline tolerance | ≥ 24 h offline with zero data loss on sync | "offline-ready" mentioned |
| Sync conflict resolution | Last-write-wins is NOT acceptable — collector-side authoritative with server reconciliation | Not specified — **flag to PM** |
| Touch target size | ≥ 44 px | Stated |
| Data encryption | At-rest for amounts + phones; in-transit TLS 1.2+ | Stated in principle |
| Audit trail | Append-only log of all member & transaction mutations | Stated |
| Backup | Daily automated | Stated |
| Compliance | RGPD + UEMOA data protection | Stated |
| Availability | 99.5 % target (MVP), 99.9 % (scale) | **Not specified — flag** |
| Supported devices | Android 8+, iOS 13+ (PWA) | **Not specified — flag** |
| Localization | French primary; local-language phone flow? | **Not specified — flag** |

### 7.3 Business rules (explicit)

- BR-1: Cycle length is **30 calendar days**, not 30 contribution days.
- BR-2: Commission equals **exactly 1 day of daily contribution**, deducted at cycle settlement.
- BR-3: Advances are **interest-free** and deducted from final balance.
- BR-4: A member may not be deleted without typing "SUPPRIMER".
- BR-5: Daily amount is fixed per member per cycle; changes mid-cycle require restart.

### 7.4 Business rules (implicit — must be made explicit in PRD)

- BR-6: What if the collector **misses a day** of collection? Is it a late contribution, a skipped day, or does it break the cycle?
- BR-7: What if the member **cannot pay** on a given day — is there partial payment? Rescheduling?
- BR-8: Can a member have **more than one active advance**? Cap?
- BR-9: Can the advance amount **exceed expected final balance**? What then?
- BR-10: What happens to data on **subscription lapse** by the collector? (RGPD-sensitive)
- BR-11: Does the saver have any **digital identity** in the system, or are they purely a row in the collector's DB?
- BR-12: How are **commissions taxed** / reported for the collector?

All 7 items above are **PRD blockers**.

---

## 8. Risks, Assumptions & Dependencies (RAID)

### Risks

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | Regulator classifies the workflow as unlicensed deposit-taking | Kills the business | Medium | Engage BCEAO counsel early; pursue IMF partnership as umbrella |
| R2 | Collector commits fraud, blame attaches to SafariCash brand | Severe category-level trust damage | Medium-High | Saver-facing receipts & totals (cross-side transparency); dispute flow |
| R3 | Offline sync conflicts corrupt cycle state | Data integrity — trust killer | High if naively implemented | Design offline-first with event sourcing, not state replication |
| R4 | Incumbent mobile-money adds "collector mode" | Competitive displacement | Medium | Build community + data moat early |
| R5 | Acquisition cost per collector exceeds LTV | Unit economics break | Unknown (no pricing yet) | Finalize pricing model pre-MVP |
| R6 | Target collectors don't have compatible devices / data plans | Adoption floor | Medium | Field interviews must confirm device baseline |
| R7 | FCFA devaluation or macro shock | Pricing pressure | Low-Medium | Pricing review cadence |

### Assumptions (must be validated)

- A1: Collectors own an Android 8+ or iOS 13+ smartphone with reliable data access
- A2: Collectors will accept a SaaS fee (amount TBD)
- A3: Savers' trust is preserved *or enhanced* by digitization (not the opposite)
- A4: 150 members/day is a realistic upper bound for a single collector's physical route
- A5: Mobile-money integration is a *growth lever*, not an *MVP blocker*
- A6: SMS/WhatsApp receipt cost (est. 20–50 FCFA per send) is economically viable at scale
- A7: Supabase row-level security can isolate multi-tenant data safely for 500+ collectors

### Dependencies

- D1: Twilio / Termii SMS API
- D2: Supabase (single-vendor lock-in — consider exit strategy)
- D3: WhatsApp Business API approval (notoriously slow in Francophone Africa)
- D4: Payment provider partnership (Phase 3) — commercial negotiation cycle
- D5: Legal structure decision (direct vs. IMF partnership) gates go-to-market

---

## 9. Open Questions for the PM

These must be answered (or consciously deferred with owner + date) before PRD freeze.

### Business model
- Q1. **What does the collector pay?** SaaS per month? % of collection? Tiered by member count? Free beta first?
- Q2. What is the target **gross margin per collector-month**?
- Q3. Is there a **saver-facing revenue stream** (premium receipts, account summary)?

### Scope & prioritization
- Q4. Is **saver-side SMS/WhatsApp receipt** an MVP feature or Phase 2? (Analysis recommends MVP.)
- Q5. Is **multi-collector / team tier** really Phase 3, or do pilot collectors already employ assistants?
- Q6. Is the **30-day fixed cycle** a hard rule, or do collectors run 21-day or variable cycles that we must support?

### Field & UX
- Q7. What is the **target transaction entry time**? (Proposed: ≤ 5 sec.)
- Q8. What **local languages** must the app support at launch? (Wolof, Bambara, Dioula…)
- Q9. What is the **device baseline** we commit to? (Proposed: Android 8+, iOS 13+.)
- Q10. How does the workflow handle a **missed day** / **partial payment**?

### Regulatory & trust
- Q11. Legal structure at launch: **direct** or **under IMF umbrella**? Who owns legal counsel engagement?
- Q12. What **saver-facing disclosures** are required? (E.g., "your money is not insured by BCEAO.")
- Q13. How do we handle a **collector who stops using the app mid-cycle** — what happens to saver data?

### Data & privacy
- Q14. Is the **saver considered a data subject** under UEMOA rules? If yes, consent flow is needed.
- Q15. What is the **data retention policy** after cycle completion? After account closure?

### Go-to-market
- Q16. How do we acquire the **first 50 pilot collectors**? Specific channel commitment needed.
- Q17. What is the **collector-acquisition CAC budget** at seed?

---

## 10. Recommendations

### Scope recommendations for PM

1. **Promote saver-facing receipt (SMS/WhatsApp) to MVP.** The trust architecture of the product depends on it. Collector-only digitization reproduces the paper problem digitally.
2. **Treat offline sync as a core engineering challenge, not a checkbox.** Budget for event-sourced design in Phase 1 architecture — it is far cheaper than retrofitting in Phase 2.
3. **Defer PDF receipt generation until after SMS receipt.** PDFs are only read if printed or emailed; SMS is native to the saver's reality.
4. **Keep multi-collector / teams out of MVP but validate the assumption in field interviews** — if most collectors already have an assistant, the scope calculus flips.
5. **Add a "saver identity" decision to the PRD.** Either savers are anonymous rows (simplest) or have a minimal digital footprint (phone + name confirmed via SMS opt-in). Picking one shapes the data model.
6. **Close the pricing question before MVP code freeze.** UI affordances (paywall, plan picker) depend on it.

### Process recommendations

- Run `bmad-market-research` to close the competitive-landscape gap (Section 6).
- Run `bmad-domain-research` on WAEMU microfinance regulation — this is load-bearing.
- Schedule the 10+ collector field interviews *before* the PRD is finalized, not after, so that BR-6 through BR-11 can be answered by primary research, not guessed.
- Stand up a **RAID register** as a living artifact, not a one-time section.

---

## 11. What's solid in the brief (worth preserving in the PRD)

Not everything needs a challenge. These elements are well-reasoned and should transfer directly:

- **The vertical focus** (collector, not tontine) — sharper than most fintech ideation.
- **The 30-day cycle + 1-day commission model** — elegant and memorable.
- **Mobile-first, PWA-first** — right posture for the market.
- **The UI wireframe set** (8 screens) — comprehensive and workflow-driven.
- **The phased plan** — reasonable sequencing (with the scope adjustments above).

---

## 12. Appendix — data consistency check on demo dataset

Spot-check of the three demo members:

- **Fatou** (5 000 × 30 days, day 25, 0 advance): projected final = 150 000 − 5 000 = **145 000** ✅
- **Moussa** (10 000 × 30 days, day 18, 50 000 advance): projected final = 300 000 − 10 000 − 50 000 = **240 000** ✅
- **Aminata** (7 500 × 30 days, day 30, 0 advance): final = 225 000 − 7 500 = **217 500** ✅

All three figures reconcile against the stated business rules. The `solde_final` field for active cycles (Fatou, Moussa) is a **projection**, not a realized value — this ambiguity should be made explicit in the data model (e.g., `projected_final_balance` vs. `final_balance`).
