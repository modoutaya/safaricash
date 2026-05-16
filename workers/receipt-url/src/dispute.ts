// Story 10.1 — saver dispute-flag handlers for the receipt-URL Worker.
//
//   GET  /r/{token}/dispute → the dispute confirmation form (no-JS,
//                             server-rendered — the UX "bottom-sheet").
//   POST /r/{token}/dispute → records the dispute via the
//                             flag_transaction_dispute RPC, then renders
//                             the compassionate acknowledgment screen.
//
// The token is already format-validated by index.ts before dispatch.
// The Worker has no saver JWT — Supabase is reached with the service-role
// key; the SECURITY DEFINER RPC resolves collector_id from the token.

import type { Env } from "./index";
import {
  renderDisputeAcknowledgedHtml,
  renderDisputeAlreadyFlaggedHtml,
  renderDisputeFormHtml,
  renderNotFoundHtml,
} from "./render";

const HTML_HEADERS: HeadersInit = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

const TEXT_HEADERS: HeadersInit = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "private, no-store",
};

// Mirrors the textarea maxlength in render.ts — the Worker re-clamps server
// side so a hand-crafted POST body cannot bypass the client-side cap.
const NOTES_MAXLENGTH = 500;

/** RPC outcome from flag_transaction_dispute. `null` = the RPC could not
 *  be reached (service-role unset / network / non-2xx). */
type DisputeResult = "created" | "already_disputed" | "not_found";

export function disputeGet(token: string): Response {
  return new Response(renderDisputeFormHtml(token), { status: 200, headers: HTML_HEADERS });
}

export async function disputePost(token: string, request: Request, env: Env): Promise<Response> {
  // Parse the optional free-text from the urlencoded form body. Reading the
  // body as text + URLSearchParams parses it independent of the
  // Content-Type header. A missing/unparseable body is fine — notes is
  // optional.
  let notes = "";
  try {
    const params = new URLSearchParams(await request.text());
    notes = (params.get("notes") ?? "").slice(0, NOTES_MAXLENGTH);
  } catch {
    notes = "";
  }

  const result = await flagTransactionDispute(env, token, notes);

  if (result === null) {
    // RPC unreachable — surface a generic 500, never leak detail.
    return new Response("Service unavailable", { status: 500, headers: TEXT_HEADERS });
  }
  if (result === "created") {
    return new Response(renderDisputeAcknowledgedHtml(), { status: 200, headers: HTML_HEADERS });
  }
  if (result === "already_disputed") {
    return new Response(renderDisputeAlreadyFlaggedHtml(), { status: 200, headers: HTML_HEADERS });
  }
  // not_found — the token resolves to no non-undone transaction.
  return new Response(renderNotFoundHtml(), { status: 404, headers: HTML_HEADERS });
}

async function flagTransactionDispute(
  env: Env,
  token: string,
  notes: string,
): Promise<DisputeResult | null> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log(
      JSON.stringify({
        level: "error",
        event: "receipt_url.service_role_unset",
        rpc: "flag_transaction_dispute",
      }),
    );
    return null;
  }
  try {
    const url = `${env.SUPABASE_PROJECT_URL}/rest/v1/rpc/flag_transaction_dispute`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        p_receipt_token: token,
        p_notes: notes.length > 0 ? notes : null,
      }),
    });
    if (!res.ok) {
      console.log(
        JSON.stringify({
          level: "error",
          event: "receipt_url.rpc_failed",
          rpc: "flag_transaction_dispute",
          status: res.status,
        }),
      );
      return null;
    }
    return (await res.json()) as DisputeResult;
  } catch (err) {
    console.log(
      JSON.stringify({
        level: "error",
        event: "receipt_url.dispute_unhandled",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}
