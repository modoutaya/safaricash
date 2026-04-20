// Minimal Termii Transactional SMS client for Edge Functions.
// architecture.md commits to Termii primary, Twilio fallback (NOT yet wired).
// Story 6.1 (sms-dispatch) will extend this client with retry/queue;
// Story 1.3 uses it for OTP fire-and-fail-fast.

import {
  TERMII_API_BASE_URL_DEFAULT,
  TERMII_MAX_RETRIES,
  TERMII_REQUEST_TIMEOUT_MS,
} from "./constants.ts";

export type TermiiSendArgs = {
  /** E.164 phone number, e.g. "+221770000000" */
  to: string;
  body: string;
  /** Termii channel: 'generic' (default) or 'dnd' (do-not-disturb-bypass). */
  channel?: "generic" | "dnd";
};

export type TermiiSendResult = {
  message_id: string;
};

export class TermiiError extends Error {
  override readonly name = "TermiiError";
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly bodyExcerpt: string,
  ) {
    super(message);
  }
}

function getBaseUrl(): string {
  return Deno.env.get("TERMII_API_BASE_URL") ?? TERMII_API_BASE_URL_DEFAULT;
}

function getApiKey(): string {
  const key = Deno.env.get("TERMII_API_KEY");
  if (!key) {
    throw new Error(
      "TERMII_API_KEY missing in Edge Function env. Set via Supabase project secrets.",
    );
  }
  return key;
}

function getSenderId(): string {
  // Termii requires an approved sender_id (or 'N-Alert' for sandbox).
  // Default to 'SafariCash' which must be approved on the Termii dashboard.
  return Deno.env.get("TERMII_SENDER_ID") ?? "SafariCash";
}

// CODE REVIEW H3 fix: Termii's error responses sometimes echo the request
// body (which contains the OTP). Strip any 4-10-digit numeric run before
// embedding in TermiiError.bodyExcerpt so the OTP cannot leak into logs
// via downstream `(err as Error).message/stack` capture.
//
// Story 1.5 review follow-up: width is 4-10 to cover all Supabase Auth OTP
// length configurations (Supabase supports 4-10; default is 6). The earlier
// strict `\d{6}` regex would have missed non-default configurations and
// allowed the OTP through to logs.
function scrubOtpDigits(text: string): string {
  return text.replace(/\b\d{4,10}\b/g, "******");
}

async function sendOnce(args: TermiiSendArgs): Promise<TermiiSendResult> {
  const apiKey = getApiKey();
  const url = `${getBaseUrl()}/api/sms/send`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TERMII_REQUEST_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: apiKey,
          to: args.to,
          from: getSenderId(),
          sms: args.body,
          type: "plain",
          channel: args.channel ?? "generic",
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // CODE REVIEW L6 fix: AbortController fires DOMException("AbortError"),
      // not a TermiiError. Translate so the caller's `instanceof TermiiError`
      // checks behave consistently. Treat timeout as 5xx-equivalent (retryable).
      if (err instanceof Error && err.name === "AbortError") {
        throw new TermiiError(
          `Termii SMS send timed out after ${TERMII_REQUEST_TIMEOUT_MS}ms`,
          504,
          "",
        );
      }
      throw err;
    }

    const rawText = await response.text();
    const text = scrubOtpDigits(rawText);
    if (!response.ok) {
      // 4xx → no retry (caller's fault).
      // 5xx → retry-eligible (handled by caller).
      throw new TermiiError(
        `Termii SMS send failed (${response.status})`,
        response.status,
        text.slice(0, 500),
      );
    }
    let parsed: { message_id?: string };
    try {
      parsed = JSON.parse(rawText); // parse the unscrubbed body for message_id
    } catch {
      throw new TermiiError(
        "Termii returned non-JSON success body",
        response.status,
        text.slice(0, 500),
      );
    }
    if (!parsed.message_id) {
      throw new TermiiError(
        "Termii success response missing message_id",
        response.status,
        text.slice(0, 500),
      );
    }
    return { message_id: parsed.message_id };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Sends an SMS via Termii with bounded retries on 5xx / network errors.
 * 4xx errors (bad request, bad credentials) fail immediately — no retry.
 *
 * NEVER log args.body — for OTP this is the secret. The caller must mask
 * the body in any log line referencing this call.
 */
export async function sendSms(args: TermiiSendArgs): Promise<TermiiSendResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TERMII_MAX_RETRIES; attempt++) {
    try {
      return await sendOnce(args);
    } catch (err) {
      lastError = err;
      if (err instanceof TermiiError && err.httpStatus >= 400 && err.httpStatus < 500) {
        // 4xx → fail-fast.
        throw err;
      }
      if (attempt < TERMII_MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("sendSms: unexpected retry exhaustion");
}
