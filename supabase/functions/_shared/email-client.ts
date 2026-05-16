// Story 10.2 — minimal Resend transactional-email client for Edge Functions.
//
// architecture.md commits communication services to plain HTTP from Edge
// Functions, no SDK (the Termii precedent). This is the email counterpart:
// a single POST to Resend's REST API.
//
// Best-effort by contract: a missing RESEND_API_KEY / RESEND_FROM, or any
// non-2xx / network / timeout error, returns a non-throwing EmailResult so
// the caller can treat email as one independent output among several.
// NEVER throws.

export type EmailResult = "sent" | "skipped" | "failed";

export type SendEmailArgs = {
  /** Recipient email address. */
  to: string;
  subject: string;
  /** Plain-text body. */
  text: string;
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 10_000;

function logJson(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  console.log(JSON.stringify({ level, event, ...fields }));
}

/** Sends a transactional email via Resend. Returns `skipped` when the
 *  function env is not provisioned, `failed` on any HTTP/network error,
 *  `sent` on a 2xx. Never throws. */
export async function sendEmail(args: SendEmailArgs): Promise<EmailResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM");
  if (!apiKey || !from) {
    logJson("warn", "email.skipped_unconfigured", {
      has_api_key: Boolean(apiKey),
      has_from: Boolean(from),
    });
    return "skipped";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from, to: args.to, subject: args.subject, text: args.text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logJson("error", "email.send_failed", { http_status: res.status });
      return "failed";
    }
    return "sent";
  } catch (err) {
    logJson("error", "email.send_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  } finally {
    clearTimeout(timeoutId);
  }
}
