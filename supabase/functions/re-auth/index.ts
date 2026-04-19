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
// CONFIRMATION_TOKEN_EXPIRY_MINUTES is no longer imported here — the
// confirmation_expires_at value is now set inside the SQL RPC
// reauth_mark_verified() (DB clock, code review H8 fix).
import {
  OTP_EXPIRY_MINUTES,
  OTP_LENGTH,
  OTP_LOCKOUT_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
} from "../_shared/constants.ts";
import { problem, problemResponse } from "../_shared/rfc7807.ts";
import { sendSms, TermiiError } from "../_shared/termii-client.ts";

// CODE REVIEW L5: lazy module-scope singletons. Each warm Edge Function
// instance constructs the SupabaseClient once and reuses across requests
// instead of allocating per-invocation.
let _anonClient: ReturnType<typeof buildAnonClient> | null = null;
let _serviceClient: ReturnType<typeof buildServiceClient> | null = null;
function getAnonClientLazy(): ReturnType<typeof buildAnonClient> {
  if (!_anonClient) _anonClient = buildAnonClient();
  return _anonClient;
}
function getServiceClientLazy(): ReturnType<typeof buildServiceClient> {
  if (!_serviceClient) _serviceClient = buildServiceClient();
  return _serviceClient;
}

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
  // CODE REVIEW L2 fix: rejection sample to eliminate the ~7.45 ppm modulo
  // bias toward low digits. Discard any uint32 >= max * (10^6) where max =
  // floor(2^32 / 10^6). Worst-case retry rate < 0.001% — negligible.
  const max = 10 ** OTP_LENGTH;
  const ceiling = Math.floor(0x1_0000_0000 / max) * max;
  const bytes = new Uint8Array(4);
  let n: number;
  do {
    crypto.getRandomValues(bytes);
    const view = new DataView(bytes.buffer);
    n = view.getUint32(0);
  } while (n >= ceiling);
  return (n % max).toString().padStart(OTP_LENGTH, "0");
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

// HMAC key cache with 5-minute TTL (CODE REVIEW H2 fix). Edge Function
// instances persist for hours when warm; without TTL, a Vault key rotation
// would not take effect on warm instances and would silently break OTP
// verify for affected users. 5min cap balances rotation latency vs RPC cost.
let cachedHmacKey: string | null = null;
let cachedHmacKeyAt = 0;
const HMAC_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

async function getOtpHmacKey(service: ReturnType<typeof buildServiceClient>): Promise<string> {
  const nowMs = Date.now();
  if (cachedHmacKey && nowMs - cachedHmacKeyAt < HMAC_KEY_CACHE_TTL_MS) {
    return cachedHmacKey;
  }
  const { data, error } = await service.rpc("get_reauth_otp_hmac_key");
  if (error || typeof data !== "string") {
    throw new Error(
      `reauth_otp_hmac_key fetch failed: ${error?.message ?? "rpc returned non-string"}`,
    );
  }
  // CODE REVIEW H1 fix: validate hex format before using as crypto bytes.
  // A non-hex value would silently produce an all-zero key (parseInt('NaN
  // char',16) = NaN; new Uint8Array fills NaN as 0), making HMAC trivially
  // forgeable. Reject loudly.
  if (!/^[0-9a-f]{64}$/i.test(data)) {
    throw new Error(
      "reauth_otp_hmac_key fetched from Vault is not a 64-char hex string (expected 32 bytes, hex-encoded)",
    );
  }
  cachedHmacKey = data;
  cachedHmacKeyAt = nowMs;
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

  // 2. Resend cooldown: any pending OR expired (Termii-failed) challenge
  //    for the same (collector, intended_op) issued less than
  //    OTP_RESEND_COOLDOWN_SECONDS ago? Including 'expired' is the C4 fix —
  //    a Termii failure marks the row 'expired' (not deleted), so the
  //    cooldown still triggers and an attacker cannot spam SMS by causing
  //    Termii errors.
  const cooldownThreshold = new Date(now.getTime() - OTP_RESEND_COOLDOWN_SECONDS * 1000);
  const { data: recentRow, error: recentErr } = await service
    .from("reauth_challenges")
    .select("id, created_at")
    .eq("collector_id", collectorId)
    .eq("intended_op", req.intended_op)
    .in("status", ["pending", "expired"])
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
    // CODE REVIEW C2 fix: a parallel issue in the same millisecond may
    // beat us to INSERT. The UNIQUE partial index on (collector_id,
    // intended_op) WHERE status='pending' (migration 0008) raises 23505
    // for the loser. Map to otp_resend_too_soon so the user retries
    // gracefully instead of seeing a 500.
    if (insertErr?.code === "23505") {
      return problemResponse(
        problem(
          "otp_resend_too_soon",
          `Another OTP request is already in flight; please retry in ${OTP_RESEND_COOLDOWN_SECONDS} seconds.`,
          { retry_after_seconds: OTP_RESEND_COOLDOWN_SECONDS },
        ),
        reqUrl,
        { "Retry-After": String(OTP_RESEND_COOLDOWN_SECONDS) },
      );
    }
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
    // CODE REVIEW C4 + M1 fix: Do NOT delete the row on Termii failure.
    // Deleting would let the next issue (within 30s) bypass the cooldown
    // — an attacker triggering Termii errors could spam SMS. Instead,
    // mark status='expired' so:
    //   - the cooldown query (which filters status IN ('pending','expired'))
    //     still catches it,
    //   - the audit chain emits reauth.expired (no orphan reauth.requested),
    //   - the user sees the same otp_delivery_failed response.
    await service.from("reauth_challenges").update({ status: "expired" }).eq("id", inserted.id);
    const termiiStatus = err instanceof TermiiError ? err.httpStatus : null;
    // Code review M7: distinguish bad-credentials (401/403) from generic
    // delivery failure for ops visibility — same user-facing problem,
    // different log signal.
    const credBad = termiiStatus === 401 || termiiStatus === 403;
    logJson("error", credBad ? "reauth.delivery_failed" : "reauth.delivery_failed", {
      collector_id: collectorId,
      intended_op: req.intended_op,
      challenge_id: inserted.id,
      termii_status: termiiStatus,
      ops_alert: credBad ? "termii_credentials_bad" : null,
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
    // Constant-time intent (CODE REVIEW H5 fix): the wrong-OTP path executes
    // a DB UPDATE via RPC (~5-50ms). The 404 path skips it entirely. Network
    // timing easily distinguishes "challenge not found" from "wrong OTP",
    // enabling cross-collector challenge enumeration. Pad with a dummy RPC
    // call (resolves the HMAC key, identical RPC overhead) plus a no-op DB
    // round-trip to match the wrong-OTP path's timing profile.
    await getOtpHmacKey(service).catch(() => undefined);
    await hashOtp(req.otp, "00".repeat(32)).catch(() => undefined);
    // Single SELECT round-trip approximates the wrong-OTP path's UPDATE-RETURNING.
    await service.from("reauth_challenges").select("id").eq("id", req.challenge_id).maybeSingle();
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
    // CODE REVIEW C3 fix: atomic CAS via SECURITY DEFINER RPC. The previous
    // read-modify-write let two parallel correct-OTP verifies both mint
    // different confirmation_tokens. The RPC's UPDATE WHERE status IN
    // ('pending','failed') AND expires_at > clock_timestamp() is atomic;
    // the loser gets NULL back and is reported as already_used.
    const { data: markedRaw, error: markedErr } = await service.rpc("reauth_mark_verified", {
      p_challenge_id: row.id,
      p_collector_id: collectorId,
    });
    if (markedErr) {
      return problemResponse(
        problem("internal_unexpected", `verify mark failed: ${markedErr.message}`),
        reqUrl,
      );
    }
    // RPC returns the composite row or null. Supabase JS unwraps it as an
    // object; null/undefined indicates lost race or terminal state.
    const marked = markedRaw as {
      confirmation_token: string;
      confirmation_expires_at: string;
    } | null;
    if (!marked) {
      return problemResponse(
        problem("otp_already_used", "Challenge already verified or terminal"),
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
        confirmation_token: marked.confirmation_token,
        confirmation_expires_at: marked.confirmation_expires_at,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // 4. Wrong OTP — atomic CAS via SECURITY DEFINER RPC (CODE REVIEW C1 fix).
  // The RPC increments attempts in a single UPDATE statement, so concurrent
  // wrong-OTP verifies cannot all read attempts=N and all write attempts=N+1.
  // It also performs the lockout transition atomically when attempts reaches
  // OTP_MAX_ATTEMPTS=3.
  const { data: outcomeRaw, error: outcomeErr } = await service.rpc("reauth_record_failed_verify", {
    p_challenge_id: row.id,
    p_collector_id: collectorId,
  });
  if (outcomeErr) {
    return problemResponse(
      problem("internal_unexpected", `failed-verify record failed: ${outcomeErr.message}`),
      reqUrl,
    );
  }
  const outcome = outcomeRaw as {
    attempts: number;
    status: string;
    lockout_until: string | null;
  } | null;
  if (!outcome) {
    // Lost the race or row already terminal/expired.
    return problemResponse(problem("otp_already_used", "Challenge already terminal"), reqUrl);
  }
  if (outcome.status === "locked") {
    logJson("warn", "reauth.locked", {
      collector_id: collectorId,
      intended_op: row.intended_op,
      challenge_id: row.id,
    });
    const retryAfterSeconds = outcome.lockout_until
      ? Math.max(1, Math.ceil((new Date(outcome.lockout_until).getTime() - now.getTime()) / 1000))
      : OTP_LOCKOUT_MINUTES * 60;
    return problemResponse(
      problem("otp_locked", `Too many failed attempts.`, {
        retry_after_seconds: retryAfterSeconds,
      }),
      reqUrl,
      { "Retry-After": String(retryAfterSeconds) },
    );
  }

  const attemptsRemaining = OTP_MAX_ATTEMPTS - outcome.attempts;
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

  // CODE REVIEW L5: clients are constructed once per warm Edge Function
  // instance and reused across requests (see module-scope vars below).
  const auth = await assertAuthenticated(req, getAnonClientLazy(), getServiceClientLazy());
  if ("problem" in auth) {
    logJson("warn", "reauth.unauthenticated", {});
    return problemResponse(auth.problem, reqUrl);
  }

  try {
    const service = getServiceClientLazy();
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
