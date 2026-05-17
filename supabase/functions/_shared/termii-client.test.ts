// Story 6.8 — termii-client WhatsApp-channel unit test.
//
// In-process unit test (no Supabase stack): mocks globalThis.fetch to
// capture the Termii request body and asserts the channel / from fields.
// This covers the WhatsApp-specific client wiring — the worker-level
// provisioned-WhatsApp E2E is env-constrained (see the Story 6.8 review).

import { assert, assertEquals } from "jsr:@std/assert@1";

import { sendSmsNoRetry } from "./termii-client.ts";

const denoOpts = { sanitizeResources: false, sanitizeOps: false };

type Captured = { body?: Record<string, unknown> };

function installFetchMock(captured: Captured): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: RequestInit): Promise<Response> => {
    captured.body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return Promise.resolve(
      new Response(JSON.stringify({ message_id: "mock-msg-123" }), { status: 200 }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test({
  name: "termii-client — channel='whatsapp' → body.channel='whatsapp' + body.from=TERMII_WHATSAPP_SENDER_ID",
  ...denoOpts,
  fn: async () => {
    Deno.env.set("TERMII_API_KEY", "mock-key");
    Deno.env.set("TERMII_WHATSAPP_SENDER_ID", "SafariCash-WA");
    const captured: Captured = {};
    const restore = installFetchMock(captured);
    try {
      const res = await sendSmsNoRetry({
        to: "+221770000000",
        body: "receipt body",
        channel: "whatsapp",
      });
      assertEquals(res.message_id, "mock-msg-123");
      assertEquals(captured.body?.channel, "whatsapp");
      assertEquals(captured.body?.from, "SafariCash-WA");
      assertEquals(captured.body?.to, "+221770000000");
    } finally {
      restore();
      Deno.env.delete("TERMII_WHATSAPP_SENDER_ID");
    }
  },
});

Deno.test({
  name: "termii-client — channel='generic' → body.channel='generic' + body.from is the SMS sender (not the WhatsApp sender)",
  ...denoOpts,
  fn: async () => {
    Deno.env.set("TERMII_API_KEY", "mock-key");
    Deno.env.set("TERMII_WHATSAPP_SENDER_ID", "SafariCash-WA");
    const captured: Captured = {};
    const restore = installFetchMock(captured);
    try {
      await sendSmsNoRetry({ to: "+221770000000", body: "receipt body", channel: "generic" });
      assertEquals(captured.body?.channel, "generic");
      // The SMS sender — TERMII_SENDER_ID or its 'SafariCash' default —
      // NEVER the WhatsApp sender.
      assert(
        captured.body?.from !== "SafariCash-WA",
        "an SMS send must not use the WhatsApp sender",
      );
    } finally {
      restore();
      Deno.env.delete("TERMII_WHATSAPP_SENDER_ID");
    }
  },
});
