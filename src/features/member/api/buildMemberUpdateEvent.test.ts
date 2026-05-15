// Story 8.6 — buildMemberUpdateEvent tests.

import { describe, expect, it } from "vitest";

import { offlineEventSchema } from "@/infrastructure/sync";

import { buildMemberUpdateEvent } from "./buildMemberUpdateEvent";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const COLLECTOR = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";

describe("buildMemberUpdateEvent", () => {
  it("produces a member.updated OfflineEvent with the member id as entityId", () => {
    const event = buildMemberUpdateEvent({
      eventId: EVENT_ID,
      collectorId: COLLECTOR,
      memberId: MEMBER,
      name: "Awa Diop",
      phoneNumber: "+221770000000",
      dailyAmount: 500,
    });
    expect(event.eventType).toBe("member.updated");
    expect(event.eventId).toBe(EVENT_ID);
    expect(event.entityId).toBe(MEMBER);
    expect(event.collectorId).toBe(COLLECTOR);
    expect(event.actor).toBe(COLLECTOR);
    expect(event.source).toBe("offline_reconciled");
  });

  it("serialises the payload in the update_member p_* RPC shape", () => {
    const event = buildMemberUpdateEvent({
      eventId: EVENT_ID,
      collectorId: COLLECTOR,
      memberId: MEMBER,
      name: "Bintou Fall",
      phoneNumber: "",
      dailyAmount: 1000,
    });
    expect(event.payload).toEqual({
      p_event_id: EVENT_ID,
      p_id: MEMBER,
      p_name: "Bintou Fall",
      p_phone_number: "",
      p_daily_amount: 1000,
    });
  });

  it("emits an event that passes the offlineEventSchema (appendEvent-ready)", () => {
    const event = buildMemberUpdateEvent({
      eventId: EVENT_ID,
      collectorId: COLLECTOR,
      memberId: MEMBER,
      name: "Cheikh Sow",
      phoneNumber: "+221760000000",
      dailyAmount: 250,
    });
    expect(offlineEventSchema.safeParse(event).success).toBe(true);
  });
});
