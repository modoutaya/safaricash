---
workflowType: 'prd'
project_name: 'SafariCash'
stepsCompleted:
  - step-01-init
  - step-02-discovery
  - step-02b-vision
  - step-02c-executive-summary
  - step-03-success
  - step-04-journeys
  - step-05-domain
  - step-06-innovation-skipped
  - step-07-project-type
  - step-08-scoping
  - step-09-functional
  - step-10-nonfunctional
  - step-11-polish
  - step-12-complete
completedAt: '2026-04-18'
version: '1.3'
amendments:
  - date: '2026-04-18'
    version: '1.0 → 1.1'
    summary: 'Apply Top 3 Improvements from validation report 2026-04-18 — (1) promote saver fraud dispute path to MVP (add FR33b + MVP scope bullet + non-negotiable tier + J3 requirement + update Domain risks table + Journey Requirements Summary row); (2) add NFR-S12 (annual pentest + IR runbook reference); (3) add amendment process to Binding Notice + add OQ6 for IR runbook governance.'
  - date: '2026-04-19'
    version: '1.1 → 1.2'
    summary: 'Align PRD with UX spec — (1) FR1 reformulation: sign-in to pre-provisioned account, not sign-up; (2) FR2 removal: email magic-link path retired (number kept as placeholder); (3) FR3 simplification: phone-OTP exclusive; (4) Product Scope MVP bullet reformulation; (5) Add OQ7 for founder admin tool; (6) Add R-OP1 operational risk (collector phone number change mid-cycle).'
  - date: '2026-04-21'
    version: '1.2 → 1.3'
    summary: 'Switch collector auth from SMS-OTP to phone+password. Driver: Termii (primary SMS gateway) requires business KYC (letter of incorporation, RCCM, NINEA) which a solo founder cannot yet provide — blocking the MVP ship. Switching to Supabase-native `signInWithPassword` removes the SMS-gateway dependency from the auth critical path (Termii stays in scope for saver receipts — different risk profile). Changes: (1) FR1/FR3 — sign-in via phone number + password; (2) FR5 — password re-authentication (not SMS-OTP) on sensitive ops; (3) NFR-S4 — re-auth mechanism updated; (4) MVP scope bullet line 138; (5) J1 narrative line 180; (6) Journey requirements capability line 250; (7) Mobile biometric row line 366 (re-auth via password not OTP); (8) Collector-fraud / credential-theft mitigation line 336; (9) R-OP1 — password recovery path at MVP = manual reset by founder via Supabase dashboard + default password shared by WhatsApp/call; (10) FR→Epic mapping cross-references updated. OTP-specific retry/lockout semantics are retired (Supabase Auth server-side lockout handles password abuse).'
classification:
  projectType: mobile_app
  projectTypeNote: 'PWA at MVP (React 18 + Vite PWA Plugin); native/store transition targeted within 24 months'
  domain: fintech
  domainScope: 'tracker-not-mover — records savings/advances but does not move funds in MVP; reduced compliance surface vs full fintech (no PCI DSS, no AML transactional)'
  complexity: high
  projectContext: greenfield
documentCounts:
  briefs: 2
  research: 2
  brainstorming: 0
  projectDocs: 0
  mockups: 1
inputDocuments:
  - _bmad-output/planning-artifacts/00-project-brief-source.md
  - _bmad-output/planning-artifacts/01-business-analysis.md
  - _bmad-output/planning-artifacts/02-pm-handoff.md
  - _bmad-output/planning-artifacts/03-mockups.html
  - docs/project-brief.md
---

# Product Requirements Document - SafariCash

**Author:** Mamadou
**Date:** 2026-04-18

## Executive Summary

SafariCash is a mobile-first product (PWA at MVP, with a native transition targeted within 24 months) that equips individual savings-collectors in West Africa's informal sector (UEMOA) with institutional-grade precision, speed, and verifiable traceability for their daily cash-collection workflow.

The target user is the professional collector — an individual entrepreneur who serves 50 to 150+ informal merchants and artisans (commerçants, artisans) over fixed 30-day calendar cycles, earning one day of contribution as commission per cycle and granting interest-free advances against expected end-of-cycle balances. Today this workflow is run on paper notebooks. That medium caps scale at roughly 50 members, produces frequent settlement errors, offers no verifiable trail for disputes, and keeps the collector's professional image below the level their ambitions require.

SafariCash digitizes this workflow in a way that preserves the collector's relational, proximity-based mode of operation — the app augments the daily route, it does not replace it. Founder motivation is the repeated, unsolicited request of a collector friend, giving the product a direct founder/problem fit rather than a synthetic thesis.

### What Makes This Special

The core differentiator is **verifiable traceability**: every contribution, every advance, every commission is recorded with a durable, tamper-evident history and (collector- and saver-facing) receipts. Traceability is the value anchor — the reason a collector becomes credibly "professional" in the eyes of the savers whose money they safeguard. The adjacent capabilities — sub-5-second transaction entry, and real-time preview of the impact of any advance on the final balance — exist to make that traceability usable on 150+-member daily routes.

The founding bet is that **savings-collectors are an under-exploited fintech distribution channel**: a pre-deployed network of trust and proximity that incumbents (banks, MFIs, mobile-money operators) have never tooled properly. SafariCash stakes the claim with a tool-first posture — the MVP ships a polished, single-purpose collector tool. Broader channel plays (credit scoring adjacent to cotisation histories, B2B2C distribution for IMFs and banks, white-label deployments) remain **deliberately out of MVP scope** as optional future horizons, not promises baked into the current specification.

## Project Classification

- **Project Type:** mobile_app — delivered as an installable PWA at MVP (React 18 + TypeScript, Vite PWA Plugin), with a native iOS/Android transition targeted within 24 months.
- **Domain:** fintech, scoped as *tracker-not-mover*. SafariCash records savings, advances, and settlements; it does not move funds in the MVP. The compliance surface is therefore lighter than a payment application (no PCI DSS, no transactional AML) while retaining UEMOA data protection, full audit trail, and microfinance-adjacency obligations (potential BCEAO oversight, IMF partnership pathway).
- **Complexity:** high. Three drivers: (1) UEMOA regulatory adjacency, (2) correctness of financial calculations at cycle settlement (contributions, commission, advances, final balance), (3) offline-first sync on sensitive financial data across 150+ daily transactions per collector.
- **Project Context:** greenfield — no existing product, no legacy codebase, no pre-existing architecture constraints beyond the stack direction proposed in the project brief.

## Success Criteria

### User Success

The product succeeds for the collector when:

- **Daily-route execution is measurably faster than paper.** A collector records a routine contribution from an established member in ≤ 5 seconds (p95), from app-open to confirmation. This is the core "speed" promise that makes 150+-member routes viable.
- **No settlement surprises at day 30.** For any fully-paid cycle, the final balance computed by the app at settlement equals the projected final balance the collector showed the saver earlier in the cycle. Zero-tolerance: any deviation is a P0 bug.
- **Traceability on demand.** A collector can locate any historical transaction for any member in ≤ 3 taps from the home screen. A saver who asks "what did I pay on [date]?" gets an answer backed by a receipt, not by memory.
- **Trust-restoring proof for the saver.** Each transaction generates a receipt the saver can keep or consult (SMS or WhatsApp), delivered within 60 seconds of entry. This is the single most important "aha" moment the product creates — paper collection has never offered it.
- **Scale without UX degradation.** A collector managing 150 active members experiences no perceptible slowdown vs. a collector managing 50. Search across 150 members returns results in < 300 ms.

### Business Success

- **Pricing hypothesis:** 8 000 FCFA/month per collector (≈ €12). To be validated in pilot. At target scale (500 collectors × 12 months), gross ARR ≈ 48 M FCFA (~€73 k).
- **6 months post-launch:** 50 paying active collectors (beta-to-commercial conversion).
- **12 months:** 500 paying collectors, 25 000 enrolled savers. Mean: 50 savers per collector (below the 150-ceiling, reflecting real uptake).
- **18 months:** financial break-even on a unit-economics basis (collector LTV ≥ CAC). Achievability of this target at 8 000 FCFA/month ARPU requires CAC kept strictly below 20 000 FCFA per collector — a go-to-market constraint.
- **24 months:** commercial presence in ≥ 3 UEMOA countries (Senegal, Côte d'Ivoire, Mali baseline).

**Leading indicators during MVP (first 3 months):**

- 10 pilot collectors onboarded and active for ≥ 30 days.
- ≥ 90 % of cycles completed without a support contact from the collector.
- Saver-reported dispute rate < 1 % of cycles during pilot.
- ≥ 80 % of pilot collectors say "I would pay 8 000 FCFA/month to keep using this" in post-pilot interview.

### Technical Success

- **Transaction entry latency:** p95 ≤ 5 seconds app-open to confirmation (MVP).
- **Offline tolerance:** 24 hours of offline operation with zero transaction loss on reconnection; append-only local log reconciled deterministically with server state. Extension to ≥ 7 days is a Growth-phase target, not deferred to Vision.
- **Calculation correctness:** projected and settled final balance reconcile to the franc on all completed cycles. Regression suite with 100 % coverage of the cycle engine.
- **Audit trail:** every state-mutating operation on `members`, `transactions`, and `cycles` is captured immutably with user, timestamp, and pre/post diff. Preserved for ≥ 5 years per UEMOA microfinance guidance (to validate with counsel).
- **Availability:** 99.5 % target at MVP; 99.9 % at 500-collector scale.
- **Device baseline:** Android 8+, iOS 13+ (PWA-installable); degrades gracefully on older devices with explicit user notice.

### Compliance Minimums (MVP)

SafariCash is scoped as *tracker-not-mover*, but is still a fintech touching savings data. The following are MVP-gated, not deferred:

- UEMOA data-protection consent flow on saver-facing comms (first SMS receipt must carry an opt-out mechanism).
- Retention policy documented for saver and transaction data (beyond cycle completion).
- Legal structure decision (direct vs. IMF partnership umbrella) closed **before first paying collector** — blocks go-to-market, not MVP code.

### Measurable Outcomes

The following are the single numeric acceptance gates before declaring MVP success:

| Outcome | Target | Measured how |
|---|---|---|
| Pilot collector retention (≥ 30 days active) | ≥ 80 % of 10 pilots | App analytics |
| Cycle completion without support contact | ≥ 90 % | Support log vs. cycle count |
| Saver dispute rate | < 1 % of cycles | Support log / collector report |
| Willingness-to-pay at 8 000 FCFA/month | ≥ 80 % of pilots | Post-pilot interview |
| Transaction latency p95 | ≤ 5 s | App analytics |
| Cycle settlement discrepancy | 0 FCFA | Automated test + production audit |

## Product Scope

### MVP — Minimum Viable Product (target: 4–6 weeks build)

The MVP ships the complete collector daily workflow + the saver-side trust hook. All items below are in scope and non-negotiable:

- Collector sign-in (phone number + password) — accounts are pre-provisioned by the founder with a default password communicated over WhatsApp / call; no self-service sign-up at MVP. SMS-OTP was retired in v1.3 due to the business-KYC barrier on the SMS gateway (see v1.3 amendment summary).
- Member CRUD (create / edit / delete with impact alerts, typed-confirmation delete gate, cycle restart).
- Daily transaction capture (contribution / catch-up "rattrapage" / advance) with suggested-amount auto-fill and real-time balance preview.
- Cycle engine (30-day calendar cycle, 1-day commission, interest-free advances, deterministic settlement).
- **Non-negotiable MVP:** Saver-facing receipt via SMS or WhatsApp within 60 seconds of every transaction. This is the operational expression of the product's core traceability differentiator — cutting it degrades the product from MVP to prototype.
- Collector-facing receipt (downloadable / shareable; PDF deferred to Growth).
- Dashboard (real-time counts, commission, recent activity, cycles-ending alert).
- Member list with instant search (≥ 150 members) and status badges.
- Member 360 profile view with chronological transaction history.
- PWA-installable on Android 8+ / iOS 13+.
- 24-hour offline tolerance with deterministic sync on reconnection.
- Full audit trail on all state mutations.
- Saver-initiated dispute flag on the receipt URL page — minimum MVP version: saver taps *"Cette transaction n'est pas moi"* on the receipt page; the system logs the dispute in the audit trail and immediately notifies the collector and the founder (designated MVP support contact) by email and push.

### Growth Features (Post-MVP, Phase 2 — 2–3 weeks)

- Extended offline (≥ 7 days) and push notifications.
- Advanced search / filters across members and transactions.
- PDF export of receipts and cycle summaries.
- Collector-facing analytics (member retention, cycle-completion trends).
- Weekly and monthly auto-reports (in-app + email).

### Vision (Future, Phase 3+)

- Multi-collector / team mode (if field interviews confirm collector-with-assistant workflow is common).
- Mobile-money payment rails (Wave / Orange Money / MTN) — native fund movement, which would shift the product out of the tracker-not-mover classification.
- Public API and white-label deployments for MFIs / banks.
- Cotisation-history-driven micro-credit (would require regulatory re-positioning).

**Out of scope forever (unless product strategy changes):**

- Saver-side self-service app. SafariCash is a collector tool; the saver-side surface is intentionally limited to receipts and transparency, not a second app.
- Peer-to-peer money movement between collectors or between savers.

## User Journeys

### Journey 1 — Collector Happy Path: "Ibrahim's first cycle"

**Persona.** Ibrahim Sow, 34, collecteur in Grand-Dakar. Route of ~80 savers at Tilène market. Three years on a paper notebook. Motivated to grow but capped at ~80 members because the notebook cannot scale.

**Opening scene.** 6:45 a.m. Monday. Ibrahim opens his worn *cahier bleu*. Three cycles end this week — he already dreads two arguments about balances. He downloads SafariCash from a landing page an ami-collecteur shared on WhatsApp.

**Rising action.** He signs in with the phone number and the default password the founder sent him by WhatsApp — 20 seconds — then bulk-imports 80 members over his morning coffee (name + phone + daily amount each). He starts the route. First saver, Awa — he types her name, taps "Cotisation", confirms. **4 seconds, app-open to done**. Awa's Nokia buzzes before Ibrahim even leaves her stall: *"SafariCash: 3 000 FCFA reçu ce jour. Cycle 7/30. Solde prévu fin cycle: 84 000 FCFA. Reçu: sc.io/r/9k2"*. She reads it twice.

**Climax (day 15).** Moussa walks up agitated, insists he paid yesterday and Ibrahim "forgot" to mark it. On paper, this scene would cost 20 minutes of flipping, suspicion, and a reluctant concession from Ibrahim to keep the peace. On SafariCash, Ibrahim opens Moussa's profile, shows him the timestamped history: *yesterday, 0 FCFA, last payment Monday*. Moussa reads the screen, stops arguing, apologises. The entire exchange lasts under a minute.

**Resolution (day 30).** Settlement. Ibrahim doesn't touch a calculator. The app computes Awa's final balance — **identical to the projection she's been seeing on her SMS receipts for a month**. He counts out 87 000 FCFA, she signs, no dispute. Ibrahim realises his route can carry 120–150 members next cycle without breaking him.

**What this journey reveals requirements for:**

- Collector onboarding (phone + pre-provisioned password) and bulk-or-fast member import
- Sub-5-second transaction entry with auto-suggested amount
- Saver-facing SMS receipt delivered within 60 seconds of every transaction
- Tamper-evident transaction history with timestamp per member
- Deterministic cycle settlement with zero discrepancy vs. in-cycle projections
- Cycles-ending dashboard alert

### Journey 2 — Collector Edge Case: "The emergency advance"

**Persona.** Same Ibrahim. Cycle day 22. A saver, Aminata, asks for an urgent 75 000 FCFA advance (cousin's wedding in two days). Ibrahim wants to help but has been burned before — once he granted an advance on paper that turned the final settlement into a shouting match.

**Opening scene.** Aminata corners him between two stalls. Ibrahim opens her profile: 7 500 FCFA/day × 22 days = 165 000 FCFA already contributed. Zero existing advances. 8 days left in cycle.

**Rising action.** He taps *Prêt Express*. The app simulates impact in real time:

- Total cycle projected: 225 000 FCFA
- Commission: –7 500
- Requested advance: –75 000
- **Projected final balance: 142 500 FCFA**

He turns the phone to Aminata. For the first time in two years she sees exactly what she'll receive at day 30, before saying yes.

**Climax.** She hesitates, then confirms. Ibrahim taps to grant. The app prompts: *"Motif du prêt?"* — he types "Mariage cousin". Aminata taps the explicit acknowledgment checkbox ("J'ai compris que ce prêt réduit mon solde final"). Both receive receipts (Ibrahim in-app, Aminata SMS). The cash transaction between them takes another 10 seconds.

**Resolution (day 30).** Settlement. Aminata receives **142 500 FCFA exactly** — matching the projection she saw 8 days earlier. She is so pleased she refers her sister to Ibrahim the next week.

**What this journey reveals requirements for:**

- Advance flow with situation-in-context (current day, contributed, existing advances) rendered before the decision
- Real-time impact simulation (total → commission → advance → final) computed client-side
- Explicit saver acknowledgment of advance terms (checkbox or equivalent)
- Motive capture on advances (free-text)
- Settlement engine that treats projected and realised balances as a single source of truth — never a "recompute surprise"

### Journey 3 — Saver Trust Arc: "Fatou goes from trusting to verifying"

**Persona.** Fatou Diallo, 42, market vendor in Médina, Dakar. Cotise 5 000 FCFA/day with Ibrahim. Uses a paper carnet with stamps. Feature phone (Nokia) — **not a smartphone, not a WhatsApp user**. Trusts Ibrahim, but the trust is pure relational — she has no way to verify.

**Opening scene.** Monday morning of Ibrahim's first SafariCash cycle. He shows up as usual, asks for 5 000 FCFA, pockets it. Then, for the first time, her Nokia vibrates in her apron pocket before Ibrahim has walked two stalls away: *"SafariCash: 5000 FCFA reçu ce jour. Cycle 1/30. Solde prévu fin cycle: 145 000 FCFA. Reçu: sc.io/r/ff7"*. She stops, reads, shows her neighbour.

**Rising action.** Each day, the same experience. A confirmation SMS within a minute of paying. She begins informally comparing the cumulative total with her own mental count — the numbers match. Day by day, the SMS archive on her phone becomes her new *cahier*, readable by her literate niece.

**Climax (day 10).** Her child's school supplies bill comes due — 20 000 FCFA urgently needed. She asks Ibrahim for an advance. He shows her the simulation; she understands the trade-off. She accepts. Two receipts land on her Nokia: one for the contribution she also paid that day, one for the advance. The numbers are transparent and auditable.

**Resolution (day 30).** Settlement. She receives **122 500 FCFA** — the exact figure her day-10 SMS predicted. Her trust in Ibrahim quietly upgrades from *"he is honest"* to *"he is verifiable"*. Next cycle she steps her contribution up from 5 000 to 7 500 FCFA/day. She recommends Ibrahim to three friends.

**What this journey reveals requirements for:**

- **SMS receipt as primary channel, WhatsApp as secondary** — the target saver is often on a feature phone, and SMS is the only universal path
- Receipt content: amount received, date, cycle day, projected final balance, receipt URL (optional, only followed on smartphones)
- Receipt URL must render on any web browser without login (no app required)
- No saver-side authentication or account in the MVP — the phone number IS the identity
- Delivery SLA: 60 seconds p95 from transaction confirmation to SMS receipt
- Receipt archive must be reconstructible (support case: saver lost all SMS, calls support — collector must be able to resend cycle history)
- Saver-initiated dispute flag on the receipt URL page — minimum trust mechanism that routes a "not me" signal to collector + founder within minutes

### Journey Requirements Summary

Capabilities revealed by the three journeys, grouped by functional area:

| Capability area | Triggered by |
|---|---|
| Collector onboarding (phone + pre-provisioned password) | J1 |
| Bulk or fast member creation | J1 |
| Sub-5-second transaction entry | J1 |
| Real-time projection & impact simulation | J1, J2 |
| Saver SMS receipt (feature-phone grade) within 60 s | J1, J2, J3 |
| Receipt URL renderable without auth | J3 |
| Tamper-evident transaction history per member | J1, J2 |
| Advance flow with situation-in-context + motive + explicit saver acknowledgment | J2 |
| Deterministic cycle settlement equal to in-cycle projection | J1, J2, J3 |
| Cycles-ending dashboard alert | J1 |
| Resend cycle history to saver (support scenario) | J3 |
| Saver-initiated dispute flag on receipt URL | J3 (support path) |

## Domain-Specific Requirements

SafariCash sits in a scoped fintech position — *tracker-not-mover* — which narrows the compliance surface substantially vs. a payment application. This section calls out what applies, what does not, and what SafariCash specifically must do.

### Compliance & Regulatory

**In scope (MVP-gating or near-MVP):**

- **UEMOA data protection** (equivalent posture to GDPR, locally grounded):
  - Explicit saver consent at first SMS receipt (opt-out mechanism on the first receipt and on the receipt URL page).
  - Right to deletion honoured at the collector level and cascaded to the saver level via **anonymisation, not hard delete** (see retention tier below).
- **Data retention (tiered).** Two durations, by data type:

  | Data type | Retention | Rationale |
  |---|---|---|
  | Audit trail + transactions + cycle records (anonymisable) | **10 years** | OHADA accounting-record obligations on the collector; commercial dispute statute of limitations; traceability is the product's core differentiator and must survive long enough to be usable |
  | Saver PII (name, phone, direct link to identity) | **2 years post-cycle-end** or on explicit saver deletion request — whichever comes first | UEMOA data protection + data-minimisation principle; transaction record is preserved via anonymisation (`SAVER_<hash>`, salted phone hash) so the audit trail remains intact |

  **All durations above are hypotheses pending UEMOA counsel validation** — formally flagged in the *Risks, Assumptions & Open Questions* section of this PRD (R-R2).

- **BCEAO / microfinance adjacency.** Licensing is **not required** while the product remains tracker-not-mover. However:
  - Legal structure (direct SaaS vs. IMF umbrella partnership) must be chosen **before the first paying collector**. Go-to-market gate, not MVP code gate.
  - Saver-facing comms (SMS, receipt URL) must avoid language that implies deposit insurance or banking status (no use of *"compte bancaire"*, *"dépôt"*, *"garanti"*). The receipt URL page carries a plain disclosure that funds are held by the collector, not by SafariCash or a regulated institution.
  - Any pivot to fund movement (Vision phase) re-opens this entire question and requires a full regulatory re-evaluation.
- **Tax data for collectors.** Collector commissions are declared income in most UEMOA countries. SafariCash must not make tax claims or calculations, but must export cycle-level commission summaries in a format the collector's accountant can consume (CSV at MVP, PDF in Growth).

**Explicitly NOT in scope (thanks to tracker-not-mover positioning):**

- PCI DSS — no card data ever handled.
- Transactional AML / KYC per payment — no funds move through the platform. Lightweight collector KYC (name, phone verification) suffices for MVP.
- Open-banking / PSD2 equivalents — no account-to-account flows.
- Crypto / VASP regulation.

### Technical Constraints

- **Data encryption.**
  - At rest: phone numbers, amounts, and member names encrypted using column-level encryption (AES-256-GCM or Supabase-equivalent).
  - In transit: TLS 1.2+ enforced on all client-server and outbound SMS / WhatsApp calls.
  - Receipt URLs use short unguessable tokens (≥ 128-bit entropy); no sequential IDs exposed externally.
- **Access control.**
  - Supabase row-level security (RLS) policies enforce strict per-collector data isolation. No tenant can ever read another tenant's members, transactions, or cycles — testable as an automated security test.
  - Multi-collector teams (Vision) will require proper RBAC; out of MVP scope.
- **Audit log.**
  - Append-only, cryptographically immutable (sequential hash chain or equivalent DB-side protection against mutation).
  - Captures: actor (collector id), timestamp (server clock, UTC), action (create / update / delete on member / transaction / cycle), before/after state hash, source (online / offline-reconciled).
  - Retention **10 years** (aligned with OHADA commercial record obligations — to validate with counsel).
- **Fraud prevention (internal).**
  - Rate limits per collector on transaction write endpoints to reduce blast radius of credential compromise.
  - Server-side invariants enforced on every state mutation (a cycle cannot receive a new contribution after day 30; an advance cannot exceed projected available balance unless explicitly flagged as overdraft).
  - Anomaly detection (large retroactive transactions, end-of-cycle tampering) → Growth-phase, not MVP.
- **Saver privacy.**
  - Receipt content (SMS + URL) must not include saver's full address or any data beyond: amount, date/time, cycle day, projected final balance, short receipt token.
  - Receipt URL pages accessible without auth but single-resource — no listing, no enumeration, no saver-identity disclosure beyond what the saver already possesses.

### Integration Requirements

- **SMS gateway (primary channel): Termii.** Selection driven by cost (typically ~10× cheaper than Twilio on WAEMU routes) and WAEMU-native delivery rates. Twilio remains a fallback option if Termii SLA degrades.
- **WhatsApp Business API (secondary channel):** enhancement for smartphone savers, not a substitute for SMS. Feature phones remain a first-class saver target.
- **Receipt URL service.** Short-link page rendering receipt data. Publicly accessible by token, no auth, renders on any browser (including older Android WebViews).
- **Export.** CSV at MVP for commission summaries and transaction history (so a collector can hand data to an accountant). PDF in Growth.
- **Payment rails.** Wave / Orange Money / MTN MoMo — explicitly **out of MVP scope**. Noted here only to prevent leakage into MVP architecture.
- **Data residency.** No hard constraint from the product side. Architect to select Supabase region on performance/cost trade-off. Re-evaluate if UEMOA data-localisation rules evolve.

### Domain-Specific Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Collector fraud** — collector misreports or skims | Saver-facing SMS receipt at every transaction (tamper-evidence); **MVP-level receipt-URL dispute mechanism** (FR33b — saver taps *"Cette transaction n'est pas moi"* → collector + founder notified, audit-logged); manual adjudication at MVP, automated workflow in Growth |
| **Regulator reclassification** — BCEAO treats the product as deposit-taking | Proactive legal engagement pre-launch; unambiguous tracker-not-mover positioning in all comms; disclosures on saver-facing pages |
| **Retention durations not counsel-validated** | 10-year / 2-year tiered retention is a hypothesis; pre-launch counsel review must confirm or adjust. Storage cost is negligible, so over-retention is the safer bias until validated. |
| **Offline sync divergence** — same member or cycle mutated on two devices | Event-sourced append-only local log; server reconciliation based on monotonic event timestamps; explicit conflict UI for the rare cases needing human resolution (ideally never occurs in single-collector MVP) |
| **Saver phone number change** — collector updates number, receipt history already addressed to old number | Collector-triggered re-verification SMS to new number; audit log entry on phone change; old-number receipts remain readable via URL (tokens persist) |
| **SMS gateway outage** — receipts not delivered | Receipt delivery queued with exponential-backoff retry; receipt marked *"envoi en cours"* in the collector app until delivery confirmed; optional fallback to WhatsApp for opted-in savers |
| **Credential theft on collector side** — stolen phone, stolen session | Password re-auth on sensitive operations (cycle settlement, bulk delete); short session lifetime with refresh; remote session revocation (Growth). Note: password re-auth on a stolen unlocked phone is weaker than OTP-on-SIM would be — accepted MVP risk given the Termii KYC blocker (v1.3 amendment). Re-evaluate when business KYC clears and the SMS gateway becomes available. |

## Mobile App Specific Requirements

### Project-Type Overview

SafariCash is a mobile-first product delivered as an installable Progressive Web App (PWA) at MVP, with a transition to native mobile targeted within 24 months. The PWA choice reflects four product-level constraints: (1) no app-store review friction for early beta iteration, (2) immediate installability via URL on Android and iOS, (3) shared code path with any future web-admin surface, and (4) compatible with the React 18 + TypeScript skill baseline assumed for the team.

Native transition (likely via React Native or Capacitor — architect's call) is anticipated at 24 months, driven by: (a) deeper device integration (biometric, richer push), (b) store-distribution credibility for collectors evaluating the product, (c) offline performance ceiling of PWA on low-end Android.

### Platform Requirements (MVP — PWA)

- **Device baseline:**
  - Android 8.0+ (API 26) via Chrome / Samsung Internet
  - iOS 13.0+ via Safari (standalone PWA mode)
- **Browser installability:**
  - Android: "Add to Home Screen" prompt on first meaningful interaction
  - iOS: explicit onboarding card guiding user through "Add to Home Screen" (iOS does not expose a programmatic install prompt)
- **Degradation on unsupported browsers:** product displays a plain-language upgrade notice; does not attempt a degraded experience that could silently produce wrong numbers.
- **Screen size range:** 320 px (low-end Android) to 428 px (large smartphone). Tablet (≥ 600 px) supported but not primary. Desktop explicitly not optimised (and not expected — collectors work mobile).

### Device Permissions & Features

| Capability | MVP | Why / Why not |
|---|---|---|
| Network status (online/offline) | ✅ | Drives offline queueing and sync indicators |
| Local storage (IndexedDB) | ✅ | Offline transaction log, member cache |
| Vibration (feedback on confirm) | ✅ | Passive, no permission needed |
| Contacts | ✅ | Optional import path for fast onboarding; gated by explicit in-app consent screen explaining what is read (*"nous lisons vos contacts uniquement pour vous permettre d'en choisir — aucune donnée n'est envoyée à nos serveurs avant votre validation"*) |
| Camera | ❌ | No QR / ID scanning in MVP; deferred to Growth if scan-to-add-member materialises |
| Biometric (WebAuthn) | ❌ | MVP re-auth via password; biometric arrives in Growth |
| Push notifications | ❌ | MVP relies on saver-side SMS; collector-side push in Growth |
| Geolocation | ❌ | No location-based features planned; out of scope forever |
| Background sync | ⚠️ (best-effort) | Service worker attempts sync when connectivity returns; no guaranteed execution on iOS PWAs (iOS Safari limitation) |

### Offline Mode

- **Target tolerance at MVP:** 24 hours of offline operation with zero transaction loss on reconnection.
- **Local data model:** IndexedDB stores (a) a cached read-model of the collector's members and in-flight cycles, (b) an append-only local event log of every write operation performed offline.
- **Sync on reconnection:** the local event log is replayed to the server; server applies events in monotonic order, computing authoritative state. Conflicts in single-collector MVP are rare-to-impossible (the collector is the sole writer); any conflict surfaces a plain-language "review and confirm" UI rather than silent override.
- **Offline indicator:** a persistent, non-dismissable badge in the header shows offline status and pending-sync count so the collector always knows the state of the truth.
- **Growth-phase target:** ≥ 7 days offline tolerance, with compaction of the local event log and selective eviction of aged cached data.

### Push Notification Strategy

- **MVP:** no push. Saver trust is built via SMS (primary channel); collector is always in-app when working. Push adds engineering cost without a proportional MVP benefit.
- **Growth — collector-facing only:**
  - Cycles ending in next 24h (daily digest, morning)
  - Member cycle completion ready for settlement (per event)
  - Stalled sync warning (if a transaction has been pending > 15 min)
- **Transport:** Web Push (VAPID) on Android Chrome; transition to native push (APNs / FCM) coincides with native-app delivery at 24 months.
- **No push to savers** — savers remain on SMS / WhatsApp. This is a deliberate product choice: we do not push anything that requires a SafariCash-installed app to the saver side.

### Store Compliance

- **MVP (PWA phase):** no store presence required. Distribution is via shareable URL and Add-to-Home-Screen. No Apple or Google review cycle to plan.
- **Native transition (24 months):**
  - Google Play Store: requires developer account, signed APK / AAB, policy compliance (data-safety section — fintech data declaration required), target-API level ≤ 1 year old.
  - Apple App Store: requires developer account, signed IPA, App Review (finance apps receive extra scrutiny — disclose tracker-not-mover position clearly), App Tracking Transparency, finance-category metadata.
  - Tracker-not-mover positioning must be restated in the store listings to pre-empt reviewer confusion with full-stack fintech apps.

### Implementation Considerations

- **Member entry UX (two paths at MVP).**
  1. **Manual entry (default, recommended).** Three-field form (name, phone, daily amount), auto-focus flow, sub-15-second-per-member cadence. Target: 80-member initial import ≤ 25 minutes. Zero permissions required.
  2. **Contacts import (opt-in).** Collector grants Contacts permission via an explicit consent screen (plain-language explanation of what is accessed and why). App reads contact list **locally only**, presents a multi-select UI, collector picks contacts and assigns per-member daily amount in a second step. **Nothing leaves the device until the collector confirms the final list.** A single visible *"Révoquer l'accès"* action in settings lets the collector clear the permission any time.
  - Both paths write to the same member model; the entry path is recorded as metadata on member creation (`created_via: manual | contacts_import`) for future UX analytics.
- **Localisation at MVP.** French only. All user-facing strings extracted via i18n keys from day 1 to make Wolof / Bambara / Dioula additions in Phase 2 purely a translation exercise, not a re-architecture.
- **Performance budget.** First meaningful paint ≤ 2.5 s on a mid-range Android (Samsung A-series) on 3G; interaction-to-response ≤ 300 ms for list search at 150 members.
- **Service worker strategy.** App-shell precached; API responses cached with stale-while-revalidate; a new app version triggers a "new version available" toast with explicit reload control — never silent reload mid-transaction.
- **Accessibility.** WCAG 2.1 AA as a floor; special attention to 44 px touch targets (already in design system) and high-contrast mode support.

## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP Approach: Experience-led, with revenue validation.** SafariCash replaces a habit (the paper notebook) that has been reliable for collectors for decades. A low-fidelity MVP would be rejected at first friction — the product only wins if its polish beats paper from day one. The MVP therefore ships as a *complete* collector workflow (see Product Scope → MVP section for the feature list), not a thin vertical slice.

This is secondarily a **revenue MVP**: the 8 000 FCFA/month pricing hypothesis must be validated by ≥ 80 % of the 10 pilot collectors stating willingness to pay at the end of a full 30-day cycle. Anything that materially dilutes the "worth-paying" perception (silent failure modes, off-brand receipts, missing saver SMS) is out of scope — regardless of engineering cost.

**The fastest path to validated learning:** 10 pilot collectors running a full 30-day cycle end-to-end, instrumented and post-interviewed. Everything before this moment is output, not outcome.

### Resource Requirements (MVP, 4–6 weeks build)

Aligned with the brief's proposed team composition, with clear role definitions:

| Role | MVP allocation | Primary responsibility |
|---|---|---|
| Lead Developer | 1 FTE, full MVP | React 18 + TS PWA, Supabase integration, cycle engine, offline sync, SMS receipt service |
| UI / UX Designer | 0.5–1 FTE, weeks 1–3 | High-fidelity spec from existing mockups, interaction states, saver-receipt visual / SMS copy, onboarding flow |
| Product Manager | 0.5–1 FTE, full MVP | Pilot collector recruitment, user research cadence, PRD refinement, go-to-market groundwork |
| QA Engineer | 0.3–0.5 FTE, weeks 3–6 | Cycle-engine regression suite, offline-sync correctness tests, cross-device PWA verification |

**Founder coverage (if team is thinner than planned):** the founder takes PM + user research + pilot support, outsourcing only the dev and design. This is the minimum viable team.

### Risk-Based Scoping

**Technical risks and simplifications:**

- *Offline-sync correctness* is the single highest-risk technical area. The event-sourced design (see Mobile App Specific Requirements → Offline Mode) is the simplification: single-writer, append-only, deterministic replay. Any pattern more clever than this is out of MVP scope.
- *Cycle-engine correctness* risk is mitigated by an exhaustive regression suite with 100 % coverage of the cycle state machine (ship date gated on this suite passing).
- *SMS delivery reliability* risk is mitigated by queue + retry with exponential backoff, and by treating the receipt as a *durable commitment* (stored, retryable, auditable) rather than a fire-and-forget message.

**Market risks and validation approach:**

- *Pricing-model mis-hypothesis* (will a collector pay 8 000 FCFA/month?) → validated via explicit post-pilot WTP interview at day 30. If ≥ 80 % conversion threshold fails, the product re-enters pricing discovery **before** scaling, regardless of feature completeness.
- *Adoption inertia* (will collectors switch from paper?) → de-risked by founder-led recruitment of pilot collectors through the original ami-collecteur network; no cold acquisition at MVP.
- *Saver-side rejection of SMS receipts* (will feature-phone savers engage?) → instrumented in pilot via saver survey (sampled) at day 30; receipt open-rate (via receipt URL) as a leading quantitative proxy.

**Resource risks and contingency cut-line:**

The MVP feature set is intentionally tight. If the team ships slower than planned, features fall off in this order (last-first on the chopping block):

1. **First to cut:** contacts-import member onboarding (fallback: manual-only entry, which the journeys confirm is fast enough at 80 members).
2. **Second to cut:** WhatsApp delivery (fallback: SMS-only receipts — acceptable since SMS is the primary channel by design).
3. **Third to cut:** collector-facing CSV export (fallback: in-app read-only summaries; accountant must transcribe — tolerable for 30–50 pilot collectors).
4. **Do not cut under any circumstances:**
   - Saver-facing receipt (the product's core differentiator).
   - Cycle engine correctness.
   - Offline 24h tolerance.
   - Audit trail.
   - Typed-confirmation delete gate.
   - Saver-initiated dispute flag on receipt URL (minimum viable dispute path closes the product's sharpest reputational-risk gap — R-M1 / collector fraud).

Cutting items 1–3 reduces MVP scope by an estimated 7–10 person-days; attempting to cut any item in #4 is a product redefinition, not a scope decision.

## Functional Requirements

This section defines the **complete capability contract** of SafariCash for MVP and Growth phases. Vision-phase features (multi-collector, payment rails, public API, white-label, credit scoring) are described in *Product Scope → Vision* and are **not** part of this contract.

> **Binding notice.** Items absent from this list are out of the product. Any capability introduced later must be added here via an explicit PRD amendment.
>
> **Amendment process.** All PRD changes follow the `bmad-edit-prd` workflow. Each amendment (a) updates the frontmatter `amendments` changelog with date and summary, (b) bumps the frontmatter `version` following semantic versioning (`v1.0` → `v1.1` for additive changes; `v1.x` → `v2.0` for breaking scope changes), and (c) is reflected in the affected sections of this file. Silent edits that skip this process are explicitly forbidden.

### Collector Authentication & Account Session

- **FR1:** A collector can sign in to a pre-provisioned account by providing their registered mobile phone number and the password set by the founder at provisioning time. The default password is communicated to the collector out-of-band (WhatsApp / call) at onboarding.
- **FR2:** *(Removed in v1.2 — was previously email + magic-link sign-up, retired when the product moved to an invite-only / pre-provisioned model. Number reserved to preserve cross-references.)*
- **FR3:** A returning collector can sign in via phone number + password. Password reset (forgotten password, suspected compromise, changed phone) is handled manually at MVP via the SafariCash founder support line documented in R-OP1 — the founder resets the password in the Supabase dashboard and communicates the new default out-of-band.
- **FR4:** A collector can sign out of the app at any time.
- **FR5:** The system requires a fresh password re-authentication from the collector before each of the following sensitive operations: cycle settlement, bulk member delete, and data export.
- **FR6:** A collector's session expires after an idle duration specified in NFRs and requires re-authentication to resume.

### Member Lifecycle

- **FR7:** A collector can create a member by entering the member's name, phone number (optional), and daily contribution amount.
- **FR8:** A collector can create members in bulk by granting the app access to their device contacts and selecting multiple entries from a local picker; no contact data leaves the device until the collector confirms the final list.
- **FR9:** A collector can revoke the device-contacts permission at any time from a single action in settings.
- **FR10:** A collector can edit a member's name, phone number, and daily contribution amount; edits that affect an in-flight cycle display an impact warning and require explicit confirmation before taking effect.
- **FR11:** A collector can delete a member. Deletion requires a double confirmation step including typing the literal word *"SUPPRIMER"*.
- **FR12:** A collector can restart a member's cycle after completion.
- **FR13:** A collector can view a member's full profile showing contributed total, expected total, outstanding advances, projected final balance, and complete chronological transaction history.
- **FR14:** A collector can search and filter the member list by name and by status (active / completed / with-advance).

### Cycle Management

- **FR15:** The system initiates a 30-calendar-day cycle for each member at member creation or on cycle restart.
- **FR16:** The system tracks a member's position within the current cycle (day 1 through day 30) based on the cycle start date.
- **FR17:** The system computes, at any point in a cycle, the member's projected final balance as `(daily_amount × 30) − (1 × daily_amount) − Σ(outstanding advances)`.
- **FR18:** The system transitions a member's cycle status automatically between *active*, *with-advance*, and *completed* based on transactions recorded and days elapsed.
- **FR19:** The system prevents new contributions from being recorded against a cycle once it has completed (day 30 reached or status = completed).
- **FR20:** The system identifies cycles ending within a configurable upcoming window and surfaces them as dashboard alerts.
- **FR21:** A collector can initiate settlement of a completed cycle; the system computes and displays the final payout amount at that moment.

### Transaction Capture

- **FR22:** A collector can record a contribution transaction for a selected member, with the member's daily amount pre-suggested as the transaction amount.
- **FR23:** A collector can record a catch-up (*rattrapage*) transaction for a selected member that covers one or more missed days of the current cycle.
- **FR24:** A collector can record an advance (*prêt*) transaction for a selected member. Before committing, the system displays the member's current situation (day in cycle, contributed, existing advances) and simulates the impact of the advance on the projected final balance.
- **FR25:** Advance transactions require the collector to capture a free-text motive and require the saver's explicit acknowledgment of the terms before the transaction is recorded.
- **FR26:** A collector can record any transaction type (contribution, catch-up, advance) while offline; the system queues the transaction locally and synchronizes it to the server on reconnection.

### Saver Trust Communications

- **FR27:** The system automatically sends an SMS receipt to the saver (at the phone number on file) for each contribution, catch-up, or advance transaction recorded against the saver's account.
- **FR28:** Every SMS receipt contains: amount, date and time, cycle-day position, projected final balance, and a unique receipt URL token.
- **FR29:** Every receipt is additionally delivered via WhatsApp if the saver has opted in and the WhatsApp Business channel is provisioned.
- **FR30:** A saver can access a public, tokenized receipt page via the receipt URL on any browser, without authentication. The receipt page exposes no information beyond what was contained in the SMS.
- **FR31:** The system delivers a data-protection consent notice on the saver's first SMS receipt, with a plain-language opt-out mechanism.
- **FR32:** A saver who has opted out of receipts no longer receives SMS for subsequent transactions; the opt-out is recorded in the audit trail.
- **FR33:** A collector can resend a saver's full cycle history, on request, as individual SMS receipts or a summary SMS (support scenario).
- **FR33b:** A saver can flag a transaction as disputed via the receipt URL page. The system records the dispute immutably in the audit trail and immediately notifies the collector (in-app) and the founder (designated MVP support contact) by email and push. Dispute adjudication itself is handled manually at MVP; this FR guarantees the signal reaches the responsible parties within minutes of the saver's action.

### Visibility & Reporting

- **FR34:** A collector can view a real-time dashboard showing: count of active members, amount collected today, commission earned this cycle, and the most recent transaction activity.
- **FR35:** A collector can view and dismiss dashboard alerts for cycles ending in the upcoming window (see FR20).
- **FR36:** A collector can view, share via the OS share sheet, and re-deliver a per-transaction receipt from a member's transaction history.
- **FR37:** A collector can export their cycle-level commission summary and transaction history as CSV.
- **FR38:** A collector can view weekly and monthly auto-generated activity reports. *(Growth)*
- **FR39:** A collector can export their data as PDF. *(Growth)*

### Offline Operation

- **FR40:** A collector can perform all transaction capture, member lookup, and member edit operations while the device is offline, with no data loss. (Offline duration target defined in NFRs.)
- **FR41:** The system displays a persistent, non-dismissable indicator showing connectivity status and the count of pending-sync operations.
- **FR42:** The system deterministically reconciles offline-captured operations with the server on reconnection, preserving the ordering in which operations were recorded.
- **FR43:** The system alerts the collector when a pending transaction has not synchronized within the alert threshold defined in NFRs and offers a manual retry action.

### Security, Audit & Data Protection

- **FR44:** The system records every state-mutating operation on members, transactions, and cycles as an immutable audit-log entry containing actor, UTC timestamp, action, before-state hash, and after-state hash.
- **FR45:** The system retains audit-log and transactional records in accordance with the retention policy defined in NFRs and Domain-Specific Requirements.
- **FR46:** The system enforces strict per-collector data isolation: no collector can read, list, or enumerate members, transactions, or cycles belonging to any other collector.
- **FR47:** The system encrypts saver names, saver phone numbers, and transaction amounts at rest using column-level encryption; all client-server and outbound messaging traffic uses encrypted transport.
- **FR48:** The system honors a saver's right-to-deletion request by anonymizing the saver's PII (replacing name and phone with salted hashes) while preserving the audit trail and transactional records under the anonymized reference.
- **FR49:** The system enforces rate limits on transaction-write endpoints per collector to bound the blast radius of credential compromise.

## Non-Functional Requirements

NFRs define **how well** SafariCash must perform. They complement the Functional Requirements (*what* the product does) with measurable quality thresholds. Thresholds are MVP-binding unless tagged *(Growth)* or *(Scale)*.

### Performance

- **NFR-P1:** Transaction entry latency — from app-open to server-confirmed transaction — **p95 ≤ 5 s**, p99 ≤ 8 s, measured on mid-range Android (Samsung A-series or equivalent) on 3G.
- **NFR-P2:** Member-list search at 150 members — **p95 ≤ 300 ms** from keystroke to result render.
- **NFR-P3:** First Meaningful Paint on cold load — **≤ 2.5 s** on 3G mid-range Android.
- **NFR-P4:** SMS receipt delivery — **p95 ≤ 60 s** from transaction commit on server to SMS reported as delivered by gateway. p99 ≤ 5 min (degraded network or gateway backlog).
- **NFR-P5:** Real-time balance / advance simulation is computed client-side with zero server round-trip and completes within one animation frame (≤ 16 ms) from user input.
- **NFR-P6:** Offline→online sync throughput — the system drains a 24-hour backlog (≈ 150 transactions) in ≤ 90 s on typical WAEMU mobile uplink.
- **NFR-P7:** Stalled-sync alert threshold — **15 min** of unacknowledged pending-sync state before a manual-retry prompt is shown. *(Growth for the alert UI; MVP tracks the state but does not alert.)*

### Reliability & Availability

- **NFR-R1:** Availability target — **99.5 % monthly** at MVP; **99.9 % monthly** at ≥ 500 paying collectors *(Scale)*. Measured at the API edge, excluding planned-maintenance windows announced ≥ 48 h in advance.
- **NFR-R2:** Offline tolerance — **24 continuous hours** at MVP; **≥ 7 days** at Growth. Zero data loss on reconnection is non-negotiable at both phases.
- **NFR-R3:** Cycle-settlement numeric correctness — **zero-tolerance**. The settled final balance must equal the projected final balance (computed via FR17) at day 30 for every cycle with no new contributions or advances after settlement initiation.
- **NFR-R4:** SMS gateway failure handling — exponential backoff retry (initial 10 s, max 10 min, abandon after 24 h); failed sends surface as *"envoi en cours"* or *"envoi échoué — retenter"* in the collector UI and never silently succeed.
- **NFR-R5:** Recovery Point Objective (RPO) — **≤ 1 hour** (data loss window in worst-case infra failure) at MVP; ≤ 15 min at Scale.
- **NFR-R6:** Recovery Time Objective (RTO) — **≤ 4 hours** at MVP; ≤ 1 h at Scale.
- **NFR-R7:** Point-in-time restore available for **≥ 7 days** of history at MVP; ≥ 30 days at Scale.

### Security & Compliance

- **NFR-S1:** Encryption at rest — saver name, saver phone number, and transaction amount encrypted using **column-level AES-256-GCM** (or Supabase-equivalent). Other member metadata encrypted at storage-tier level minimum.
- **NFR-S2:** Encryption in transit — **TLS 1.2+** enforced on all client-server traffic and all outbound SMS / WhatsApp gateway calls. TLS 1.0 and 1.1 explicitly disabled.
- **NFR-S3:** Receipt URL token entropy — **≥ 128 bits**, unguessable, non-sequential. Tokens do not encode PII.
- **NFR-S4:** Collector session — idle timeout **30 min**; absolute session lifetime **30 days** with silent refresh if active. Password re-authentication required on sensitive operations (FR5) irrespective of session age. Supabase Auth handles brute-force defence server-side (per-IP + per-identifier rate limits on `signInWithPassword`); no client-side lockout needed.
- **NFR-S5:** Per-collector data isolation (FR46) is enforced at the database layer (Supabase RLS or equivalent) and validated by automated test suites that run on every deployment. A failing isolation test blocks the release.
- **NFR-S6:** Audit trail — append-only, cryptographically chained (sequential per-collector hash chain). Tamper-evidence verifiable offline from the audit-log export.
- **NFR-S7:** Audit log and transactional records retention — **10 years** (aligned with OHADA commercial-record obligations — pending counsel validation).
- **NFR-S8:** Saver PII retention — **2 years** post-cycle-end, or on explicit saver deletion request (honored via FR48 anonymization) — whichever occurs first.
- **NFR-S9:** Rate limit on transaction-write endpoints — **100 requests / minute per collector** at MVP; adjusted based on pilot observation.
- **NFR-S10:** Saver-facing comms (SMS body, receipt URL page) contain no banking language (*"compte bancaire"*, *"dépôt"*, *"garanti"*) and carry the prescribed tracker-not-mover disclosure on the receipt page.
- **NFR-S11:** Vulnerability management — dependency security scan on every build; critical CVEs patched within 7 days of availability; high CVEs within 30 days.
- **NFR-S12:** Penetration testing and incident response — annual third-party penetration test against the production environment; Critical-severity findings remediated within 14 days, High-severity within 30 days. An incident response plan is maintained as an operational runbook (location and ownership tracked in *Risks, Assumptions & Open Questions → OQ6*).

### Scalability

- **NFR-SC1:** MVP target — support **50 concurrent active collectors** (initial 6-month horizon) with stated NFR-P and NFR-R performance thresholds intact.
- **NFR-SC2:** Growth target — support **500 paying collectors × avg 50 active savers each = 25 000 savers** with stated thresholds intact.
- **NFR-SC3:** Scale ceiling (current architecture) — **~2 000 collectors** before a re-architecture (sharding, regional deployments) is triggered. This is a flag, not a commitment.
- **NFR-SC4:** Transaction volume — sustained **~75 000 transactions/day** at Growth target, with diurnal peaks (morning collection rounds 06:00–10:00) at ~3× the daily average. System must handle peak load with stated NFR-P thresholds.
- **NFR-SC5:** Audit log growth — ≈ 1 M events / month at Growth target; storage planning must accommodate **10-year retention × Growth volume ≈ 120 M events** without query-latency degradation on member-profile views (FR13).

### Accessibility

- **NFR-A1:** Baseline conformance — **WCAG 2.1 Level AA** across all collector-facing screens. Receipt URL page (saver-facing) targets Level A minimum (most savers use feature phones not served by this surface).
- **NFR-A2:** Touch targets — **≥ 44 × 44 CSS pixels** for all interactive elements (already expressed in the design system).
- **NFR-A3:** Color contrast — **≥ 4.5 : 1** for normal text, ≥ 3 : 1 for large text and UI components, per WCAG 1.4.3 / 1.4.11.
- **NFR-A4:** Operable without color — no information is conveyed by color alone (status badges combine color + text label).
- **NFR-A5:** Assistive technology — compatible with TalkBack (Android) and VoiceOver (iOS) at MVP; keyboard navigation fully supported.
- **NFR-A6:** SMS receipt — plain 7-bit ASCII where possible (broadest feature-phone compatibility); fall back to GSM-7 encoding; avoid emoji in receipt body.

### Localisation

- **NFR-L1:** MVP UI language — **French (fr-FR, tolerant of fr-SN variants)**. No other language at MVP.
- **NFR-L2:** All user-facing strings externalised via i18n keys from day 1. Adding a new language (Wolof, Bambara, Dioula) must be achievable as a translation-only delivery with no code changes.
- **NFR-L3:** Number and currency formatting — FCFA-aware throughout, with thousands separation using non-breaking space (French convention: *"150 000 FCFA"*).
- **NFR-L4:** Dates and times — French locale, 24-hour clock, West Africa Time (WAT, UTC±0) for user-facing display; all stored timestamps in UTC.
- **NFR-L5:** Receipt copy — reviewed by a French-native legal / compliance reader before MVP launch to ensure regulatory tone (see NFR-S10).

## Risks, Assumptions & Open Questions

This section consolidates the cross-cutting risks, validated assumptions, and open questions identified during PRD creation. Domain-specific risks (fintech) are detailed separately in *Domain-Specific Requirements → Domain-Specific Risks & Mitigations*.

### Risks

**Technical**

- **R-T1:** Offline-sync correctness. Highest-risk technical area. Mitigation: event-sourced append-only local log, single-writer replay (see *Mobile App → Offline Mode*).
- **R-T2:** Cycle-engine correctness. Any settlement discrepancy is a P0 bug (NFR-R3). Mitigation: 100 % regression coverage of the cycle state machine, gating the MVP ship date.
- **R-T3:** SMS delivery reliability via Termii. Mitigation: queue-and-retry (NFR-R4), receipt modelled as a durable commitment, fallback gateway path preserved.

**Market**

- **R-M1:** Pricing-model mis-hypothesis (8 000 FCFA/month may not clear willingness-to-pay). Mitigation: pilot-gated validation at day 30 of the first cycle; sub-80 % conversion re-opens pricing discovery before scaling.
- **R-M2:** Adoption inertia (collectors reluctant to switch from paper). Mitigation: founder-led recruitment via the originating ami-collecteur network; no cold acquisition at MVP.
- **R-M3:** Saver-side rejection of SMS receipts (feature-phone users ignore them). Mitigation: sampled saver survey at pilot day 30 + receipt-URL open-rate as leading quantitative signal.
- **R-M4:** Incumbent feature-add risk — a mobile-money operator (Wave, OM, MTN) ships a "collector mode". Mitigation: product moat must come from community, execution, and integration depth, not feature-existence (competitive dynamics to revisit at 6 months).

**Regulatory**

- **R-R1:** BCEAO reclassification of the product as unlicensed deposit-taking. Mitigation: proactive counsel engagement pre-launch, unambiguous tracker-not-mover positioning in all comms, saver-facing disclosures (NFR-S10).
- **R-R2:** Retention hypothesis (10 years audit, 2 years saver PII) not yet counsel-validated. Mitigation: pre-launch counsel review; over-retention is the safer bias given negligible storage cost.
- **R-R3:** UEMOA data-localisation rule changes forcing a region migration. Mitigation: architect chooses an initial region with migration feasibility in mind; revisit if rules evolve.

**Resource**

- **R-RS1:** Team thinner than planned. Mitigation: scope cut-line in *Project Scoping & Phased Development → Risk-Based Scoping* (ordered 1–3, with 4 as non-negotiable).
- **R-RS2:** CAC per collector exceeds ~20 000 FCFA, breaking the 18-month break-even math. Mitigation: restrict scaling until CAC is observed in the first 50 collectors (*Business Success*); consider price-point review before capital spending on acquisition.

**Operational**

- **R-OP1:** Collector changes phone number mid-cycle OR forgets / wants to rotate their password. Primary recovery path at MVP is manual via the SafariCash founder support line (+221 77 791 58 98). Mitigation: the phone-number-change and password-reset procedures are documented in onboarding materials and in the welcome message. For password reset, the founder updates the password via the Supabase dashboard (`auth.users` → update password) and communicates the new default password to the collector out-of-band (WhatsApp, call). For phone-number change, the founder updates `auth.users.phone` and `public.users.phone_number` in the same dashboard. Growth-phase: self-service password reset via email fallback once a secondary identifier is collected at onboarding (depends on future FR2 re-introduction scope).

### Assumptions (to be validated)

- **A1:** Target collectors own Android 8+ or iOS 13+ smartphones with reliable 3G+ connectivity during the daily route.
- **A2:** Collectors accept 8 000 FCFA/month pricing once exposed to the product for a full cycle (validated at pilot day 30).
- **A3:** Savers on feature phones engage meaningfully with SMS receipts (measured via receipt-URL open-rate on smartphones as a leading proxy + sampled qualitative survey).
- **A4:** A 150-member daily route is physically achievable on a collector's typical geographical footprint (validated via pilot route-audit).
- **A5:** Termii SMS delivery meets the NFR-P4 p95 ≤ 60 s threshold on WAEMU mobile routes (validated via pre-MVP load test).
- **A6:** OHADA commercial-record obligations, as interpreted for individual-entrepreneur collectors, align with a 10-year retention default (validated by UEMOA counsel).
- **A7:** Supabase row-level security scales to ≥ 500 concurrent collectors without query-latency degradation on the member-profile view (NFR-P2, NFR-SC2) (validated via architecture spike before MVP freeze).

### Open Questions (blocking go-to-market, not MVP code)

| # | Question | Owner | Deadline |
|---|---|---|---|
| **OQ1** | Legal structure at launch — direct SaaS vs. IMF umbrella partnership | Founder + UEMOA-native counsel | Before first paying collector |
| **OQ2** | Counsel-validated retention durations (A6 confirmation) | Founder + counsel | Pre-launch |
| **OQ3** | Acquisition channel and CAC budget for first 50 collectors | Founder / PM | Before beta-to-commercial conversion (~month 6) |
| **OQ4** | Supabase region selection for data residency | Architect | Pre-build (week 1 of MVP) |
| **OQ5** | Post-pilot next-step decision if pricing-model WTP conversion < 80 % | Founder + PM | Pilot day 30 |
| **OQ6** | Incident response plan — location, ownership, and review cadence of the operational runbook referenced by NFR-S12 | Founder (and future SRE / security lead) | Pre-first-paying-collector |
| **OQ7** | Admin tool / back-office for founder to pre-provision collectors — MVP scope, shape, delivery mode? | Founder | Before first pilot collector onboarded |

None of the open questions block MVP code delivery. They block commercial launch, not development.
