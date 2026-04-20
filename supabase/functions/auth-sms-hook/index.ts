// Story 1.5 — Supabase Auth "Send SMS Hook" webhook.
// POST /functions/v1/auth-sms-hook
//
// Supabase Auth calls this webhook when signInWithOtp({ channel: 'sms', ... })
// fires. It follows the Standard Webhooks spec (https://standardwebhooks.com):
//
//   Headers (sent by Supabase Auth):
//     webhook-id         — unique per event (UUID-ish)
//     webhook-timestamp  — unix epoch seconds
//     webhook-signature  — one or more "v1,<base64-sig>" entries, space-separated
//                          during secret rotation
//
//   Signing input: f"{webhook-id}.{webhook-timestamp}.{rawBody}"
//   Signature:    base64(HMAC-SHA256(secret_bytes, signing_input))
//
//   Secret format: the operator stores AUTH_SMS_HOOK_SECRET as
//                  "v1,whsec_<base64>" (the same value the Supabase dashboard
//                  paste field accepts). We strip "v1," then "whsec_", then
//                  base64-decode to get the HMAC key bytes.
//
//   Replay window: reject any event whose webhook-timestamp is more than
//                  5 minutes off from our clock. Standard Webhooks recommends
//                  this to defeat replay attacks even when the signature is
//                  still cryptographically valid.
//
// Payload shape:
//   {
//     user: { id, phone, ... },
//     sms:  { otp, phone, ... }
//   }
//
// Security invariants:
//   - NEVER log the OTP. Termii's response body is scrubbed by the client.
//   - Signature verification happens BEFORE JSON parsing and BEFORE any
//     Termii dispatch — fail-closed on any uncertainty.

import { problem, problemResponse } from "../_shared/rfc7807.ts";
import { sendSms, TermiiError } from "../_shared/termii-client.ts";

// ---------------------------------------------------------------------------
// Types — mirror Supabase Auth's "Send SMS Hook" payload.
// ---------------------------------------------------------------------------

type SendSmsHookPayload = {
  user: { id: string; phone?: string } | null;
  sms: { otp: string; phone: string };
};

// ---------------------------------------------------------------------------
// Structured logging — never includes OTP.
// ---------------------------------------------------------------------------

type LogEvent =
  | "auth.sms.dispatched"
  | "auth.sms.failed"
  | "auth.sms.bad_signature"
  | "auth.sms.bad_timestamp"
  | "auth.sms.invalid_request"
  | "auth.config_missing"
  | "auth.config_invalid"
  | "auth.sms.unexpected";

function logJson(
  level: "info" | "warn" | "error",
  event: LogEvent,
  fields: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      level,
      event,
      ts: new Date().toISOString(),
      ...fields,
    }),
  );
}

/** Mask phone for logs: keep +221 prefix + last 2 digits, redact middle. */
function maskPhoneForLog(phone: string): string {
  if (phone.length < 4) return "****";
  return `${phone.slice(0, 4)}****${phone.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Standard Webhooks signature verification.
// ---------------------------------------------------------------------------

const REPLAY_TOLERANCE_SECONDS = 5 * 60; // ±5 min, per Standard Webhooks recommendation

/** Strip "v1," and/or "whsec_" prefixes, then base64-decode to bytes. */
function decodeSecret(raw: string): Uint8Array {
  let s = raw.trim();
  if (s.startsWith("v1,")) s = s.slice(3);
  if (s.startsWith("whsec_")) s = s.slice(6);
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Constant-time equality over two ASCII strings of the same length. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_headers" | "bad_timestamp" | "bad_signature";
      error?: string;
    };

async function verifySignature(opts: {
  rawBody: string;
  webhookId: string | null;
  webhookTimestamp: string | null;
  webhookSignature: string | null;
  secretBytes: Uint8Array;
  nowSec: number;
}): Promise<VerifyResult> {
  const { rawBody, webhookId, webhookTimestamp, webhookSignature, secretBytes, nowSec } = opts;
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, reason: "missing_headers" };
  }

  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > REPLAY_TOLERANCE_SECONDS) {
    return { ok: false, reason: "bad_timestamp" };
  }

  // Import HMAC key — need an owning ArrayBuffer (not a view on a shared one).
  const keyBuf = new ArrayBuffer(secretBytes.byteLength);
  new Uint8Array(keyBuf).set(secretBytes);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signingInput = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const dataBytes = new TextEncoder().encode(signingInput);
  const dataBuf = new ArrayBuffer(dataBytes.byteLength);
  new Uint8Array(dataBuf).set(dataBytes);
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, dataBuf);
  const expected = bytesToBase64(new Uint8Array(sigBuffer));

  // webhook-signature header format: "v1,<sig1> v1,<sig2>" during rotation.
  // Accept if ANY "v1,<sig>" token matches our computed expected value.
  const tokens = webhookSignature
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const token of tokens) {
    const commaIdx = token.indexOf(",");
    if (commaIdx === -1) continue;
    const version = token.slice(0, commaIdx);
    const provided = token.slice(commaIdx + 1);
    if (version === "v1" && constantTimeEqual(provided, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "bad_signature" };
}

// ---------------------------------------------------------------------------
// SMS body template — ≤160 chars plain text, no banking language (NFR-S10).
// ---------------------------------------------------------------------------

function composeOtpBody(otp: string): string {
  return `Votre code SafariCash : ${otp}. Valable 5 minutes. Ne le partagez avec personne.`;
}

// ---------------------------------------------------------------------------
// Payload shape guard — fail closed on drift.
// ---------------------------------------------------------------------------

function isSendSmsHookPayload(raw: unknown): raw is SendSmsHookPayload {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (!("sms" in r) || typeof r.sms !== "object" || r.sms === null) return false;
  const sms = r.sms as Record<string, unknown>;
  return (
    typeof sms.otp === "string" &&
    /^\d{4,8}$/.test(sms.otp) &&
    typeof sms.phone === "string" &&
    // Accept any E.164 phone (leading +, 8-15 digits). Guards against header
    // injection, premium-rate-prefix smuggling, and other arbitrary-string
    // drift from the Supabase Auth webhook payload.
    /^\+\d{8,15}$/.test(sms.phone)
  );
}

// ---------------------------------------------------------------------------
// HTTP entry point.
// ---------------------------------------------------------------------------

export async function handler(req: Request): Promise<Response> {
  const reqUrl = req.url;

  if (req.method !== "POST") {
    return problemResponse(
      problem("request_invalid", `Only POST is allowed; got ${req.method}`),
      reqUrl,
      { Allow: "POST" },
    );
  }

  const rawSecret = Deno.env.get("AUTH_SMS_HOOK_SECRET");
  if (!rawSecret) {
    logJson("error", "auth.config_missing", { missing: "AUTH_SMS_HOOK_SECRET" });
    return problemResponse(
      problem("internal_unexpected", "auth-sms-hook secret missing in env"),
      reqUrl,
    );
  }

  let secretBytes: Uint8Array;
  try {
    secretBytes = decodeSecret(rawSecret);
    if (secretBytes.length < 16) {
      throw new Error(`decoded secret too short: ${secretBytes.length} bytes`);
    }
  } catch (err) {
    logJson("error", "auth.config_invalid", {
      reason: "AUTH_SMS_HOOK_SECRET is not valid 'v1,whsec_<base64>' or 'whsec_<base64>'",
      error: (err as Error).message,
    });
    return problemResponse(
      problem("internal_unexpected", "auth-sms-hook secret is malformed"),
      reqUrl,
    );
  }

  // Read the raw body ONCE for signature verification; JSON.parse afterwards.
  const rawBody = await req.text();
  const nowSec = Math.floor(Date.now() / 1000);

  const verified = await verifySignature({
    rawBody,
    webhookId: req.headers.get("webhook-id"),
    webhookTimestamp: req.headers.get("webhook-timestamp"),
    webhookSignature: req.headers.get("webhook-signature"),
    secretBytes,
    nowSec,
  }).catch((err) => ({
    ok: false as const,
    reason: "bad_signature" as const,
    error: (err as Error)?.message ?? String(err),
  }));

  if (!verified.ok) {
    const event: LogEvent =
      verified.reason === "bad_timestamp" ? "auth.sms.bad_timestamp" : "auth.sms.bad_signature";
    // Log underlying error when present (e.g., crypto.subtle.importKey failure)
    // so an ops-surfaced signature incident is not indistinguishable from a
    // client-sprayed bad signature.
    logJson("warn", event, {
      reason: verified.reason,
      error: verified.error ?? null,
    });
    // Return a unified message for bad_timestamp + bad_signature — do not
    // let an attacker distinguish clock-skew probes from signature probes
    // (the clock-skew variant does NOT require a valid signature).
    return problemResponse(
      problem("auth_unauthenticated", "Invalid webhook signature or timestamp"),
      reqUrl,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    logJson("warn", "auth.sms.invalid_request", { reason: (err as Error).message });
    return problemResponse(problem("request_invalid", "Body must be valid JSON"), reqUrl);
  }

  if (!isSendSmsHookPayload(parsed)) {
    logJson("warn", "auth.sms.invalid_request", { reason: "shape mismatch" });
    return problemResponse(
      problem("request_invalid", "Payload does not match Supabase Send SMS Hook shape"),
      reqUrl,
    );
  }

  const { otp, phone } = parsed.sms;

  try {
    const result = await sendSms({ to: phone, body: composeOtpBody(otp) });
    logJson("info", "auth.sms.dispatched", {
      phone_masked: maskPhoneForLog(phone),
      message_id: result.message_id,
    });
    return new Response(JSON.stringify({ delivered: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const termiiStatus = err instanceof TermiiError ? err.httpStatus : null;
    const credBad = termiiStatus === 401 || termiiStatus === 403;
    logJson("error", "auth.sms.failed", {
      phone_masked: maskPhoneForLog(phone),
      termii_status: termiiStatus,
      ops_alert: credBad ? "termii_credentials_bad" : null,
      error: (err as Error).message,
    });
    return problemResponse(
      problem("otp_delivery_failed", "SMS dispatch failed; please retry."),
      reqUrl,
    );
  }
}

// Supabase Edge Functions runtime entry point — same guard pattern as re-auth.
type DenoGlobal = { serve?: (handler: (req: Request) => Promise<Response>) => unknown };
const denoMaybe: DenoGlobal | undefined = (globalThis as { Deno?: DenoGlobal }).Deno;
if (denoMaybe?.serve) {
  denoMaybe.serve(handler);
}
