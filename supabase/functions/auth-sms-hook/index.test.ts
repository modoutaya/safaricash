// Story 1.5 — auth-sms-hook handler tests.
//
// Follows the Standard Webhooks spec (https://standardwebhooks.com):
// signing input = "{webhook-id}.{webhook-timestamp}.{rawBody}", secret is
// "v1,whsec_<base64>" (or "whsec_<base64>"), signature header carries one
// or more "v1,<base64-sig>" entries space-separated.
//
// Run: deno test --allow-net --allow-env --allow-read --no-check \
//        supabase/functions/auth-sms-hook/index.test.ts

import { assertEquals, assertExists } from "jsr:@std/assert@1";

import { installFetchRecorder } from "../_shared/test-utils.ts";

// Test secret: 32 random bytes base64-encoded, with the Supabase-style prefix.
// (The bytes "safaricash-test-hmac-key-for-s15" UTF-8 encoded + base64'd.)
const TEST_SECRET_BYTES_BASE64 = "c2FmYXJpY2FzaC10ZXN0LWhtYWMta2V5LWZvci1zMTU=";
const TEST_SECRET = `v1,whsec_${TEST_SECRET_BYTES_BASE64}`;

Deno.env.set("AUTH_SMS_HOOK_SECRET", TEST_SECRET);
Deno.env.set("TERMII_API_KEY", "test-termii-key-not-reached");
Deno.env.set("TERMII_API_BASE_URL", "https://termii.test.local");

const { handler } = await import("./index.ts");

// ---------------------------------------------------------------------------
// Signing + request helpers
// ---------------------------------------------------------------------------

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function base64DecodeToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function signStandardWebhook(opts: {
  webhookId: string;
  webhookTimestamp: number;
  body: string;
  secretBase64: string;
}): Promise<string> {
  const keyBytes = base64DecodeToBytes(opts.secretBase64);
  const keyBuf = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyBuf).set(keyBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const toSign = `${opts.webhookId}.${opts.webhookTimestamp}.${opts.body}`;
  const dataBytes = new TextEncoder().encode(toSign);
  const dataBuf = new ArrayBuffer(dataBytes.byteLength);
  new Uint8Array(dataBuf).set(dataBytes);
  const sig = await crypto.subtle.sign("HMAC", key, dataBuf);
  return bytesToBase64(new Uint8Array(sig));
}

type HookHeaders = {
  webhookId?: string | null;
  webhookTimestamp?: number | null | string;
  webhookSignature?: string | null;
};

function buildHookReq(body: string, hdrs: HookHeaders = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hdrs.webhookId !== null && hdrs.webhookId !== undefined) {
    headers["webhook-id"] = hdrs.webhookId;
  }
  if (hdrs.webhookTimestamp !== null && hdrs.webhookTimestamp !== undefined) {
    headers["webhook-timestamp"] = String(hdrs.webhookTimestamp);
  }
  if (hdrs.webhookSignature !== null && hdrs.webhookSignature !== undefined) {
    headers["webhook-signature"] = hdrs.webhookSignature;
  }
  return new Request("https://safaricash-test.local/functions/v1/auth-sms-hook", {
    method: "POST",
    headers,
    body,
  });
}

function samplePayload(): string {
  return JSON.stringify({
    user: { id: crypto.randomUUID(), phone: "+221777915898" },
    sms: { otp: "123456", phone: "+221777915898" },
  });
}

async function signedHeadersFor(body: string, opts: { secretBase64?: string } = {}) {
  const webhookId = `msg_${crypto.randomUUID()}`;
  const webhookTimestamp = nowSec();
  const sig = await signStandardWebhook({
    webhookId,
    webhookTimestamp,
    body,
    secretBase64: opts.secretBase64 ?? TEST_SECRET_BYTES_BASE64,
  });
  return {
    webhookId,
    webhookTimestamp,
    webhookSignature: `v1,${sig}`,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "auth-sms-hook — valid Standard-Webhook signature + Termii 200 → 200 delivered",
  fn: async () => {
    const body = samplePayload();
    const h = await signedHeadersFor(body);

    const recorder = installFetchRecorder({
      matchUrl: (url) => url.includes("termii.test.local"),
      responder: () =>
        new Response(JSON.stringify({ message_id: "mock-msg-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    try {
      const res = await handler(buildHookReq(body, h));
      assertEquals(res.status, 200);
      const json = (await res.json()) as { delivered: boolean };
      assertEquals(json.delivered, true);
      assertEquals(recorder.calls.length, 1);
      const termiiBody = JSON.parse(recorder.calls[0]!.body ?? "{}") as {
        to: string;
        sms: string;
      };
      assertEquals(termiiBody.to, "+221777915898");
      assertExists(termiiBody.sms.match(/Votre code SafariCash : 123456/));
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "auth-sms-hook — missing webhook-* headers → 401",
  fn: async () => {
    const res = await handler(buildHookReq(samplePayload()));
    assertEquals(res.status, 401);
    const problem = (await res.json()) as { title: string };
    assertEquals(problem.title, "Unauthenticated");
  },
});

Deno.test({
  name: "auth-sms-hook — tampered body (signature no longer matches) → 401",
  fn: async () => {
    const originalBody = samplePayload();
    const h = await signedHeadersFor(originalBody);
    // Send a DIFFERENT body with the same headers → signature mismatch.
    const tampered = samplePayload();
    const res = await handler(buildHookReq(tampered, h));
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "auth-sms-hook — wrong version prefix (v2) → 401",
  fn: async () => {
    const body = samplePayload();
    const h = await signedHeadersFor(body);
    const res = await handler(
      buildHookReq(body, { ...h, webhookSignature: h.webhookSignature.replace("v1,", "v2,") }),
    );
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "auth-sms-hook — timestamp too old (>5 min) → 401 (replay window)",
  fn: async () => {
    const body = samplePayload();
    const webhookId = `msg_${crypto.randomUUID()}`;
    const oldTs = nowSec() - 10 * 60; // 10 minutes ago
    const sig = await signStandardWebhook({
      webhookId,
      webhookTimestamp: oldTs,
      body,
      secretBase64: TEST_SECRET_BYTES_BASE64,
    });
    const res = await handler(
      buildHookReq(body, {
        webhookId,
        webhookTimestamp: oldTs,
        webhookSignature: `v1,${sig}`,
      }),
    );
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "auth-sms-hook — non-numeric webhook-timestamp → 401",
  fn: async () => {
    const body = samplePayload();
    const h = await signedHeadersFor(body);
    const res = await handler(buildHookReq(body, { ...h, webhookTimestamp: "not-a-number" }));
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "auth-sms-hook — multi-signature rotation (v1,wrong v1,right) → 200",
  fn: async () => {
    const body = samplePayload();
    const h = await signedHeadersFor(body);
    // Prepend a bogus signature; the handler must still accept the valid one.
    const multi = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${h.webhookSignature}`;

    const recorder = installFetchRecorder({
      matchUrl: (url) => url.includes("termii.test.local"),
      responder: () =>
        new Response(JSON.stringify({ message_id: "mock-msg-multi" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    try {
      const res = await handler(buildHookReq(body, { ...h, webhookSignature: multi }));
      assertEquals(res.status, 200);
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "auth-sms-hook — malformed JSON body (signature valid) → 400",
  fn: async () => {
    const body = "{ this is not json";
    const h = await signedHeadersFor(body);
    const res = await handler(buildHookReq(body, h));
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "auth-sms-hook — payload missing sms.otp → 400",
  fn: async () => {
    const body = JSON.stringify({
      user: { id: "abc" },
      sms: { phone: "+221777915898" },
    });
    const h = await signedHeadersFor(body);
    const res = await handler(buildHookReq(body, h));
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "auth-sms-hook — Termii 5xx → 502 (otp_delivery_failed)",
  fn: async () => {
    const body = samplePayload();
    const h = await signedHeadersFor(body);

    const recorder = installFetchRecorder({
      matchUrl: (url) => url.includes("termii.test.local"),
      responder: () => new Response("upstream boom", { status: 502 }),
    });

    try {
      const res = await handler(buildHookReq(body, h));
      assertEquals(res.status, 502);
      const problem = (await res.json()) as { title: string };
      assertEquals(problem.title, "OTP delivery failed");
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "auth-sms-hook — non-POST method → 400 + Allow: POST",
  fn: async () => {
    const res = await handler(
      new Request("https://safaricash-test.local/functions/v1/auth-sms-hook", { method: "GET" }),
    );
    assertEquals(res.status, 400);
    assertEquals(res.headers.get("Allow"), "POST");
  },
});

Deno.test({
  name: "auth-sms-hook — missing AUTH_SMS_HOOK_SECRET env → 500",
  fn: async () => {
    Deno.env.delete("AUTH_SMS_HOOK_SECRET");
    try {
      const body = samplePayload();
      const res = await handler(
        buildHookReq(body, {
          webhookId: "x",
          webhookTimestamp: nowSec(),
          webhookSignature: "v1,deadbeef",
        }),
      );
      assertEquals(res.status, 500);
    } finally {
      Deno.env.set("AUTH_SMS_HOOK_SECRET", TEST_SECRET);
    }
  },
});

Deno.test({
  name: "auth-sms-hook — malformed AUTH_SMS_HOOK_SECRET → 500",
  fn: async () => {
    Deno.env.set("AUTH_SMS_HOOK_SECRET", "whsec_!!!not-base64!!!");
    try {
      const body = samplePayload();
      const res = await handler(
        buildHookReq(body, {
          webhookId: "x",
          webhookTimestamp: nowSec(),
          webhookSignature: "v1,deadbeef",
        }),
      );
      assertEquals(res.status, 500);
    } finally {
      Deno.env.set("AUTH_SMS_HOOK_SECRET", TEST_SECRET);
    }
  },
});

Deno.test({
  name: "auth-sms-hook — accepts plain 'whsec_<base64>' secret (no v1, prefix)",
  fn: async () => {
    const plain = `whsec_${TEST_SECRET_BYTES_BASE64}`;
    Deno.env.set("AUTH_SMS_HOOK_SECRET", plain);
    try {
      const body = samplePayload();
      const h = await signedHeadersFor(body);

      const recorder = installFetchRecorder({
        matchUrl: (url) => url.includes("termii.test.local"),
        responder: () =>
          new Response(JSON.stringify({ message_id: "mock-plain" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      });

      try {
        const res = await handler(buildHookReq(body, h));
        assertEquals(res.status, 200);
      } finally {
        recorder.uninstall();
      }
    } finally {
      Deno.env.set("AUTH_SMS_HOOK_SECRET", TEST_SECRET);
    }
  },
});
