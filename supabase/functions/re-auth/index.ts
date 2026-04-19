// Story 1.3 — Re-auth Edge Function
// POST /functions/v1/re-auth — issues + verifies SMS OTP for sensitive ops.
//
// Action discriminator on request body:
//   { action: 'issue', intended_op: ... }   → returns challenge_id + expires_at
//   { action: 'verify', challenge_id, otp } → returns confirmation_token (200) or RFC 7807 error
//
// Hard rules (do NOT relax without amending the spec):
//   - NEVER store, log, or echo the raw OTP
//   - NEVER mint/refresh the caller's session JWT (sensitive op = fresh re-auth, not session extension)
//   - Single-OTP-per-(collector, intended_op) until expiry/lockout
//   - 4xx/5xx responses ALWAYS RFC 7807 (Content-Type: application/problem+json)
//
// See: architecture.md § Authentication & Security; epics.md Story 1.3;
// _bmad-output/implementation-artifacts/1-3-reauth-edge-function.md.

import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

import { assertAuthenticated, buildAnonClient, buildServiceClient } from "../_shared/auth-check.ts";
import {
  CONFIRMATION_TOKEN_EXPIRY_MINUTES,
  OTP_EXPIRY_MINUTES,
  OTP_LENGTH,
  OTP_LOCKOUT_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
} from "../_shared/constants.ts";
import { problem, problemResponse } from "../_shared/rfc7807.ts";
import { sendSms, TermiiError } from "../_shared/termii-client.ts";

// ---------------------------------------------------------------------------
// Request schemas (Zod tagged union).
// ---------------------------------------------------------------------------

const IntendedOpSchema = z.enum(["cycle_settlement", "member_delete", "csv_export", "sms_resend"]);

const IssueSchema = z.object({
  action: z.literal("issue"),
  intended_op: IntendedOpSchema,
});

const VerifySchema = z.object({
  action: z.literal("verify"),
  challenge_id: z.string().uuid(),
  otp: z.string().regex(/^\d{6}$/, "OTP must be exactly 6 digits"),
});

const RequestSchema = z.discriminatedUnion("action", [IssueSchema, VerifySchema]);
type IssueRequest = z.infer<typeof IssueSchema>;
type VerifyRequest = z.infer<typeof VerifySchema>;

// ---------------------------------------------------------------------------
// OTP primitives.
// ---------------------------------------------------------------------------

function generateOtp(): string {
  // 6 cryptographically-random digits, leading-zero preserved.
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const view = new DataView(bytes.buffer);
  const n = view.getUint32(0) % 10 ** OTP_LENGTH;
  return n.toString().padStart(OTP_LENGTH, "0");
}

async function hashOtp(otp: string, hmacKeyHex: string): Promise<string> {
  // HMAC-SHA256(otp, key). hmacKeyHex is hex-encoded 32-byte key.
  const keyBytes = hexToBytes(hmacKeyHex);
  // crypto.subtle.importKey requires a BufferSource backed by ArrayBuffer
  // (not SharedArrayBuffer). Copy into a fresh, owning ArrayBuffer.
  const keyBuf = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyBuf).set(keyBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const otpBytes = new TextEncoder().encode(otp);
  const otpBuf = new ArrayBuffer(otpBytes.byteLength);
  new Uint8Array(otpBuf).set(otpBytes);
  const sig = await crypto.subtle.sign("HMAC", key, otpBuf);
  return bytesToHex(new Uint8Array(sig));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Simple in-memory cache for the HMAC key per warm function instance.
// Migration 0008 provisions the key in Vault and the
// public.get_reauth_otp_hmac_key() SECURITY DEFINER function (service-role only).
let cachedHmacKey: string | null = null;
async function getOtpHmacKey(service: ReturnType<typeof buildServiceClient>): Promise<string> {
  if (cachedHmacKey) return cachedHmacKey;
  const { data, error } = await service.rpc("get_reauth_otp_hmac_key");
  if (error || typeof data !== "string") {
    throw new Error(
      `reauth_otp_hmac_key fetch failed: ${error?.message ?? "rpc returned non-string"}`,
    );
  }
  cachedHmacKey = data;
  return cachedHmacKey;
}

// ---------------------------------------------------------------------------
// Logging — structured JSON, NEVER includes the raw OTP.
// ---------------------------------------------------------------------------

type LogEvent =
  | "reauth.issued"
  | "reauth.verified"
  | "reauth.failed"
  | "reauth.locked"
  | "reauth.delivery_failed"
  | "reauth.unauthenticated"
  | "reauth.invalid_request"
  | "reauth.unexpected";

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

// ---------------------------------------------------------------------------
// Phone lookup — collector phones live unencrypted in public.users.phone_number.
// ---------------------------------------------------------------------------

async function lookupCollectorPhone(
  service: ReturnType<typeof buildServiceClient>,
  collectorId: string,
): Promise<string> {
  const { data, error } = await service
    .from("users")
    .select("phone_number")
    .eq("id", collectorId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`lookupCollectorPhone(${collectorId}): ${error?.message ?? "not found"}`);
  }
  return data.phone_number as string;
}

function composeOtpBody(otp: string): string {
  return `Code SafariCash: ${otp} — valide ${OTP_EXPIRY_MINUTES} min. Ne le partagez avec personne.`;
}

// ---------------------------------------------------------------------------
// issue handler.
// ---------------------------------------------------------------------------

async function handleIssue(
  req: IssueRequest,
  collectorId: string,
  reqUrl: string,
  service: ReturnType<typeof buildServiceClient>,
): Promise<Response> {
  const now = new Date();

  // 1. Lockout pre-check: any active locked challenge for the same
  //    (collector, intended_op) within the lockout window?
  const { data: lockedRow, error: lockedErr } = await service
    .from("reauth_challenges")
    .select("id, lockout_until")
    .eq("collector_id", collectorId)
    .eq("intended_op", req.intended_op)
    .eq("status", "locked")
    .gt("lockout_until", now.toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lockedErr) {
    return problemResponse(
      problem("internal_unexpected", `lockout pre-check failed: ${lockedErr.message}`),
      reqUrl,
    );
  }
  if (lockedRow) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((new Date(lockedRow.lockout_until as string).getTime() - now.getTime()) / 1000),
    );
    logJson("warn", "reauth.locked", {
      collector_id: collectorId,
      intended_op: req.intended_op,
      retry_after_s: retryAfterSeconds,
    });
    return problemResponse(
      problem("otp_locked", `Too many failed attempts. Retry in ${retryAfterSeconds} seconds.`, {
        retry_after_seconds: retryAfterSeconds,
      }),
      reqUrl,
      { "Retry-After": String(retryAfterSeconds) },
    );
  }

  // 2. Resend cooldown: any pending challenge for the same (collector, intended_op)
  //    issued less than OTP_RESEND_COOLDOWN_SECONDS ago?
  const cooldownThreshold = new Date(now.getTime() - OTP_RESEND_COOLDOWN_SECONDS * 1000);
  const { data: recentRow, error: recentErr } = await service
    .from("reauth_challenges")
    .select("id, created_at")
    .eq("collector_id", collectorId)
    .eq("intended_op", req.intended_op)
    .eq("status", "pending")
    .gt("created_at", cooldownThreshold.toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recentErr) {
    return problemResponse(
      problem("internal_unexpected", `cooldown check failed: ${recentErr.message}`),
      reqUrl,
    );
  }
  if (recentRow) {
    const elapsedMs = now.getTime() - new Date(recentRow.created_at as string).getTime();
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000),
    );
    return problemResponse(
      problem("otp_resend_too_soon", `Resend available in ${retryAfterSeconds} seconds.`, {
        retry_after_seconds: retryAfterSeconds,
      }),
      reqUrl,
      { "Retry-After": String(retryAfterSeconds) },
    );
  }

  // 3. Generate OTP, hash it, INSERT row.
  const otp = generateOtp();
  const hmacKey = await getOtpHmacKey(service);
  const otpHash = await hashOtp(otp, hmacKey);

  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000);

  const { data: inserted, error: insertErr } = await service
    .from("reauth_challenges")
    .insert({
      collector_id: collectorId,
      intended_op: req.intended_op,
      otp_hash: otpHash,
      attempts: 0,
      status: "pending",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select("id, expires_at")
    .single();
  if (insertErr || !inserted) {
    return problemResponse(
      problem("internal_unexpected", `reauth_challenges insert failed: ${insertErr?.message}`),
      reqUrl,
    );
  }

  // 4. Dispatch SMS via Termii. On failure, ROLLBACK by deleting the row.
  let phone: string;
  try {
    phone = await lookupCollectorPhone(service, collectorId);
  } catch (err) {
    await service.from("reauth_challenges").delete().eq("id", inserted.id);
    logJson("error", "reauth.unexpected", {
      collector_id: collectorId,
      challenge_id: inserted.id,
      reason: "phone_lookup",
      error: (err as Error).message,
    });
    return problemResponse(
      problem("internal_unexpected", "Could not resolve collector phone"),
      reqUrl,
    );
  }

  try {
    await sendSms({ to: phone, body: composeOtpBody(otp) });
  } catch (err) {
    await service.from("reauth_challenges").delete().eq("id", inserted.id);
    logJson("error", "reauth.delivery_failed", {
      collector_id: collectorId,
      intended_op: req.intended_op,
      challenge_id: inserted.id,
      termii_status: err instanceof TermiiError ? err.httpStatus : null,
    });
    return problemResponse(
      problem("otp_delivery_failed", "SMS dispatch failed; please retry."),
      reqUrl,
    );
  }

  const resendAvailableAt = new Date(now.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000);

  logJson("info", "reauth.issued", {
    collector_id: collectorId,
    intended_op: req.intended_op,
    challenge_id: inserted.id,
    expires_at: inserted.expires_at,
  });

  return new Response(
    JSON.stringify({
      challenge_id: inserted.id,
      expires_at: inserted.expires_at,
      resend_available_at: resendAvailableAt.toISOString(),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// ---------------------------------------------------------------------------
// verify handler.
// ---------------------------------------------------------------------------

async function handleVerify(
  req: VerifyRequest,
  collectorId: string,
  reqUrl: string,
  service: ReturnType<typeof buildServiceClient>,
): Promise<Response> {
  const now = new Date();

  // 1. Look up the challenge — both id AND collector_id must match.
  //    404 (not 401) on mismatch to prevent enumeration.
  const { data: row, error: rowErr } = await service
    .from("reauth_challenges")
    .select("id, collector_id, intended_op, otp_hash, attempts, status, lockout_until, expires_at")
    .eq("id", req.challenge_id)
    .eq("collector_id", collectorId)
    .maybeSingle();
  if (rowErr) {
    return problemResponse(
      problem("internal_unexpected", `challenge lookup failed: ${rowErr.message}`),
      reqUrl,
    );
  }
  if (!row) {
    // Constant-time intent: do a dummy HMAC compare so timing matches the
    // wrong-OTP path. The actual result is discarded.
    const hmacKey = await getOtpHmacKey(service).catch(() => "00".repeat(32));
    await hashOtp(req.otp, hmacKey).catch(() => undefined);
    return problemResponse(
      problem("challenge_not_found", "Challenge not found for this collector"),
      reqUrl,
    );
  }

  // 2. Pre-flight precondition checks (in order).
  if (new Date(row.expires_at as string).getTime() <= now.getTime()) {
    return problemResponse(problem("otp_expired", "OTP challenge expired"), reqUrl);
  }
  if (
    row.status === "locked" &&
    row.lockout_until &&
    new Date(row.lockout_until as string).getTime() > now.getTime()
  ) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((new Date(row.lockout_until as string).getTime() - now.getTime()) / 1000),
    );
    return problemResponse(
      problem("otp_locked", `Too many failed attempts.`, {
        retry_after_seconds: retryAfterSeconds,
      }),
      reqUrl,
      { "Retry-After": String(retryAfterSeconds) },
    );
  }
  if (row.status !== "pending" && row.status !== "failed") {
    return problemResponse(
      problem("otp_already_used", `Challenge in terminal state (${row.status})`),
      reqUrl,
    );
  }

  // 3. HMAC compare.
  const hmacKey = await getOtpHmacKey(service);
  const submittedHash = await hashOtp(req.otp, hmacKey);
  const otpMatches = constantTimeEqualHex(submittedHash, row.otp_hash as string);

  if (otpMatches) {
    const confirmationToken = crypto.randomUUID();
    const confirmationExpiresAt = new Date(
      now.getTime() + CONFIRMATION_TOKEN_EXPIRY_MINUTES * 60 * 1000,
    );
    const { error: updateErr } = await service
      .from("reauth_challenges")
      .update({
        status: "verified",
        confirmation_token: confirmationToken,
        confirmation_expires_at: confirmationExpiresAt.toISOString(),
      })
      .eq("id", row.id);
    if (updateErr) {
      return problemResponse(
        problem("internal_unexpected", `verify update failed: ${updateErr.message}`),
        reqUrl,
      );
    }
    logJson("info", "reauth.verified", {
      collector_id: collectorId,
      intended_op: row.intended_op,
      challenge_id: row.id,
    });
    return new Response(
      JSON.stringify({
        confirmation_token: confirmationToken,
        confirmation_expires_at: confirmationExpiresAt.toISOString(),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // 4. Wrong OTP — increment attempts; if attempts == OTP_MAX_ATTEMPTS, lock.
  const nextAttempts = (row.attempts as number) + 1;
  if (nextAttempts >= OTP_MAX_ATTEMPTS) {
    const lockoutUntil = new Date(now.getTime() + OTP_LOCKOUT_MINUTES * 60 * 1000);
    const { error: lockErr } = await service
      .from("reauth_challenges")
      .update({
        attempts: nextAttempts,
        status: "locked",
        lockout_until: lockoutUntil.toISOString(),
      })
      .eq("id", row.id);
    if (lockErr) {
      return problemResponse(
        problem("internal_unexpected", `lockout update failed: ${lockErr.message}`),
        reqUrl,
      );
    }
    logJson("warn", "reauth.locked", {
      collector_id: collectorId,
      intended_op: row.intended_op,
      challenge_id: row.id,
    });
    const retryAfterSeconds = OTP_LOCKOUT_MINUTES * 60;
    return problemResponse(
      problem("otp_locked", `Too many failed attempts.`, {
        retry_after_seconds: retryAfterSeconds,
      }),
      reqUrl,
      { "Retry-After": String(retryAfterSeconds) },
    );
  }

  const { error: failErr } = await service
    .from("reauth_challenges")
    .update({ attempts: nextAttempts, status: "failed" })
    .eq("id", row.id);
  if (failErr) {
    return problemResponse(
      problem("internal_unexpected", `attempts update failed: ${failErr.message}`),
      reqUrl,
    );
  }
  const attemptsRemaining = OTP_MAX_ATTEMPTS - nextAttempts;
  logJson("warn", "reauth.failed", {
    collector_id: collectorId,
    intended_op: row.intended_op,
    challenge_id: row.id,
    attempts_remaining: attemptsRemaining,
  });
  return problemResponse(
    problem("otp_invalid", "Invalid OTP", { attempts_remaining: attemptsRemaining }),
    reqUrl,
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

  // Parse body.
  let parsed: z.infer<typeof RequestSchema>;
  try {
    const raw = await req.json();
    const result = RequestSchema.safeParse(raw);
    if (!result.success) {
      logJson("warn", "reauth.invalid_request", {
        issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return problemResponse(
        problem("request_invalid", result.error.issues.map((i) => i.message).join("; ")),
        reqUrl,
      );
    }
    parsed = result.data;
  } catch (err) {
    return problemResponse(
      problem("request_invalid", `Body must be valid JSON: ${(err as Error).message}`),
      reqUrl,
    );
  }

  // Auth.
  const anon = buildAnonClient();
  const service = buildServiceClient();
  const auth = await assertAuthenticated(req, anon, service);
  if ("problem" in auth) {
    logJson("warn", "reauth.unauthenticated", {});
    return problemResponse(auth.problem, reqUrl);
  }

  try {
    if (parsed.action === "issue") {
      return await handleIssue(parsed, auth.collectorId, reqUrl, service);
    } else {
      return await handleVerify(parsed, auth.collectorId, reqUrl, service);
    }
  } catch (err) {
    logJson("error", "reauth.unexpected", {
      collector_id: auth.collectorId,
      action: parsed.action,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return problemResponse(
      problem("internal_unexpected", "Unexpected error in re-auth handler"),
      reqUrl,
    );
  }
}

// Supabase Edge Functions runtime entry point.
// `Deno` is the Edge runtime global; in Vitest/Node contexts it is undefined
// and the Deno.serve registration short-circuits. The minimal interface
// keeps lint strict (no `any`) while staying compatible with both runtimes.
type DenoGlobal = { serve?: (handler: (req: Request) => Promise<Response>) => unknown };
const denoMaybe: DenoGlobal | undefined = (globalThis as { Deno?: DenoGlobal }).Deno;
if (denoMaybe?.serve) {
  denoMaybe.serve(handler);
}
