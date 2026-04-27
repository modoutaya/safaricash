// Story 5.2 / FR24 — UX preferences for the advance flow.
//
// ADVANCE_SUGGESTED_AMOUNTS lives at the feature layer (UX decision, not
// a domain math invariant). The 3 quick-tap chips on the AdvanceFlow
// screen display these in the displayed order. Future stories may
// parameterise per collector / per market — that's a feature-layer
// concern (UI strings, not cycle math).

export const ADVANCE_SUGGESTED_AMOUNTS = [50_000, 100_000, 150_000] as const;
