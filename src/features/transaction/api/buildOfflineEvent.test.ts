// Story 8.3 — buildOfflineEvent unit tests.

import { describe, expect, it } from "vitest";

import { offlineEventSchema } from "@/infrastructure/sync";

import { buildOfflineEvent, type OfflineMutationInput } from "./buildOfflineEvent";

const COLLECTOR = "11111111-1111-4111-8111-111111111111";
const TX = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const CYCLE = "44444444-4444-4444-8444-444444444444";

describe("buildOfflineEvent", () => {
  it("builds a contribution event with the right shape", () => {
    const event = buildOfflineEvent({
      syntheticTxId: TX,
      collectorId: COLLECTOR,
      mutation: {
        kind: "contribution",
        input: { memberId: MEMBER, cycleId: CYCLE, amount: 1_000, cycleDay: 5 },
      },
    });

    expect(event.eventId).toBe(TX);
    expect(event.entityId).toBe(TX);
    expect(event.eventType).toBe("transaction.contribution_recorded");
    expect(event.collectorId).toBe(COLLECTOR);
    expect(event.actor).toBe(COLLECTOR);
    expect(event.source).toBe("offline_reconciled");
    expect(event.payload).toEqual({
      p_event_id: TX,
      p_member_id: MEMBER,
      p_cycle_id: CYCLE,
      p_amount: 1_000,
      p_cycle_day: 5,
    });
    // Timestamp matches the canonical regex (microsecond + Z).
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it("builds a rattrapage event with daily_amount + days_covered", () => {
    const event = buildOfflineEvent({
      syntheticTxId: TX,
      collectorId: COLLECTOR,
      mutation: {
        kind: "rattrapage",
        input: {
          memberId: MEMBER,
          cycleId: CYCLE,
          dailyAmount: 500,
          cycleDay: 10,
          daysCovered: 3,
        },
      },
    });

    expect(event.eventType).toBe("transaction.rattrapage_recorded");
    expect(event.payload).toEqual({
      p_event_id: TX,
      p_member_id: MEMBER,
      p_cycle_id: CYCLE,
      p_daily_amount: 500,
      p_cycle_day: 10,
      p_days_covered: 3,
    });
  });

  it("builds an advance event with motive + saver_acknowledged", () => {
    const event = buildOfflineEvent({
      syntheticTxId: TX,
      collectorId: COLLECTOR,
      mutation: {
        kind: "advance",
        input: {
          memberId: MEMBER,
          cycleId: CYCLE,
          amount: 50_000,
          cycleDay: 15,
          motive: "urgence familiale",
          saverAcknowledged: true,
        },
      },
    });

    expect(event.eventType).toBe("transaction.advance_recorded");
    expect(event.payload).toEqual({
      p_event_id: TX,
      p_member_id: MEMBER,
      p_cycle_id: CYCLE,
      p_amount: 50_000,
      p_cycle_day: 15,
      p_motive: "urgence familiale",
      p_saver_acknowledged: true,
    });
  });

  it("output passes the offlineEventSchema (Story 8.2 boundary)", () => {
    const event = buildOfflineEvent({
      syntheticTxId: TX,
      collectorId: COLLECTOR,
      mutation: {
        kind: "contribution",
        input: { memberId: MEMBER, cycleId: CYCLE, amount: 1_000, cycleDay: 5 },
      },
    });
    const result = offlineEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("each kind produces a distinct eventType", () => {
    const inputs: OfflineMutationInput[] = [
      {
        kind: "contribution",
        input: { memberId: MEMBER, cycleId: CYCLE, amount: 1, cycleDay: 1 },
      },
      {
        kind: "rattrapage",
        input: { memberId: MEMBER, cycleId: CYCLE, dailyAmount: 1, cycleDay: 1, daysCovered: 1 },
      },
      {
        kind: "advance",
        input: {
          memberId: MEMBER,
          cycleId: CYCLE,
          amount: 1,
          cycleDay: 1,
          motive: "x x x",
          saverAcknowledged: true,
        },
      },
    ];
    const eventTypes = inputs.map(
      (m) =>
        buildOfflineEvent({ syntheticTxId: TX, collectorId: COLLECTOR, mutation: m }).eventType,
    );
    expect(new Set(eventTypes).size).toBe(3);
  });
});
