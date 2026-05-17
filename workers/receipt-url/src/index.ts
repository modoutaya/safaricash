// SafariCash Story 6.4 — receipt URL public Worker entry (FR30 / UX-DR19).
//
// Routes:
//   GET  /health                  → 200 "ok"  (CI readiness probe)
//   GET  /r/{32-hex token}        → 200 HTML (receipt page) or 404 HTML
//   GET  /r/{token}/dispute       → 200 HTML (dispute confirmation form)
//   POST /r/{token}/dispute       → records the dispute → 200 / 404 / 500
//   anything else                 → 404 plain text  /  405 for wrong method
//
// Auth: service-role-only — the saver doesn't have a JWT. The Worker
// reads SUPABASE_SERVICE_ROLE_KEY from env at request time. If the
// secret is unset, returns 500 with an opaque body (no detail leak).
//
// NEVER logs full token, member name, or amount. Token prefix only.

import { disputeGet, disputePost } from "./dispute";
import {
  renderNotFoundHtml,
  renderOptOutConfirmedHtml,
  renderOptOutFormHtml,
  renderReceiptHtml,
  type ReceiptPayload,
} from "./render";
import { tokenIsValid } from "./token";

export interface Env {
  SUPABASE_PROJECT_URL: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

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

type LogLevel = "info" | "warn" | "error";

function logJson(level: LogLevel, event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level, event, ...fields }));
}

function tokenPrefix(token: string): string {
  return token.length >= 4 ? token.slice(0, 4) : token;
}

function notFoundHtml(): Response {
  return new Response(renderNotFoundHtml(), { status: 404, headers: HTML_HEADERS });
}

function notFoundText(): Response {
  return new Response("Reçu introuvable.", { status: 404, headers: TEXT_HEADERS });
}

async function supabaseRpc<T>(
  env: Env,
  rpcName: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    logJson("error", "receipt_url.service_role_unset", { rpc: rpcName });
    return null;
  }
  const url = `${env.SUPABASE_PROJECT_URL}/rest/v1/rpc/${rpcName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    logJson("error", "receipt_url.rpc_failed", { rpc: rpcName, status: res.status });
    return null;
  }
  return (await res.json()) as T;
}

async function fetchReceiptPayload(env: Env, token: string): Promise<ReceiptPayload | null> {
  const rows = await supabaseRpc<ReceiptPayload[]>(env, "get_receipt_payload", { p_token: token });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0] ?? null;
}

type MemberFromToken = { memberId: string; anonymisedAt: string | null };

async function fetchMemberFromToken(env: Env, token: string): Promise<MemberFromToken | null> {
  // Story 10.5 — get_member_id_from_token now RETURNS TABLE(member_id,
  // anonymised_at); PostgREST surfaces it as a row array.
  const rows = await supabaseRpc<{ member_id: string; anonymised_at: string | null }[]>(
    env,
    "get_member_id_from_token",
    { p_token: token },
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (!row?.member_id) return null;
  return { memberId: row.member_id, anonymisedAt: row.anonymised_at ?? null };
}

async function setMemberSmsOptOut(env: Env, memberId: string): Promise<boolean> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const url = `${env.SUPABASE_PROJECT_URL}/rest/v1/rpc/set_member_sms_opt_out`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_member_id: memberId, p_via: "receipt_url" }),
  });
  if (!res.ok) {
    logJson("error", "receipt_url.opt_out_rpc_failed", { status: res.status });
    return false;
  }
  return true;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // Health probe (CI readiness, mirrors rate-limit pattern).
    if (path === "/health") {
      if (method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: TEXT_HEADERS });
      }
      return new Response("ok", { status: 200, headers: TEXT_HEADERS });
    }

    // Receipt page route: /r/{token} or /r/{token}/dispute or /r/{token}/opt-out
    const receiptMatch = path.match(/^\/r\/([^/]+)(?:\/(dispute|opt-out))?$/);
    if (receiptMatch) {
      const rawToken = receiptMatch[1] ?? "";
      const subroute = receiptMatch[2];

      if (subroute === "dispute") {
        if (!tokenIsValid(rawToken)) return notFoundHtml();
        if (method === "GET") return disputeGet(rawToken);
        if (method === "POST") return disputePost(rawToken, req, env);
        return new Response("Method Not Allowed", { status: 405, headers: TEXT_HEADERS });
      }

      if (subroute === "opt-out") {
        if (!tokenIsValid(rawToken)) return notFoundHtml();

        if (method === "GET") {
          try {
            const member = await fetchMemberFromToken(env, rawToken);
            // Story 10.5 — no opt-out surface for an unknown token or an
            // already-anonymised saver (their data is destroyed — FR48).
            if (!member || member.anonymisedAt) return notFoundHtml();
            return new Response(renderOptOutFormHtml(rawToken), {
              status: 200,
              headers: HTML_HEADERS,
            });
          } catch (err) {
            logJson("error", "receipt_url.opt_out_form_unhandled", {
              token_prefix: tokenPrefix(rawToken),
              error: err instanceof Error ? err.message : String(err),
            });
            return new Response("Service unavailable", { status: 500, headers: TEXT_HEADERS });
          }
        }
        if (method === "POST") {
          try {
            const member = await fetchMemberFromToken(env, rawToken);
            // Story 10.5 — 404 an unknown token or an anonymised saver.
            if (!member || member.anonymisedAt) {
              return notFoundHtml();
            }
            const ok = await setMemberSmsOptOut(env, member.memberId);
            if (!ok) {
              return new Response("Service unavailable", { status: 500, headers: TEXT_HEADERS });
            }
            logJson("info", "receipt_url.opted_out", {
              token_prefix: tokenPrefix(rawToken),
            });
            return new Response(renderOptOutConfirmedHtml(), {
              status: 200,
              headers: HTML_HEADERS,
            });
          } catch (err) {
            logJson("error", "receipt_url.opt_out_unhandled", {
              token_prefix: tokenPrefix(rawToken),
              error: err instanceof Error ? err.message : String(err),
            });
            return new Response("Service unavailable", { status: 500, headers: TEXT_HEADERS });
          }
        }
        return new Response("Method Not Allowed", { status: 405, headers: TEXT_HEADERS });
      }

      // Plain receipt route.
      if (method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: TEXT_HEADERS });
      }
      if (!tokenIsValid(rawToken)) {
        // Defence-in-depth: never round-trip a malformed token to Supabase.
        return notFoundText();
      }

      try {
        const payload = await fetchReceiptPayload(env, rawToken);
        if (!payload) {
          return notFoundHtml();
        }
        logJson("info", "receipt_url.rendered", {
          token_prefix: tokenPrefix(rawToken),
          kind: payload.kind,
        });
        return new Response(renderReceiptHtml(rawToken, payload), {
          status: 200,
          headers: HTML_HEADERS,
        });
      } catch (err) {
        logJson("error", "receipt_url.unhandled", {
          token_prefix: tokenPrefix(rawToken),
          error: err instanceof Error ? err.message : String(err),
        });
        return new Response("Service unavailable", { status: 500, headers: TEXT_HEADERS });
      }
    }

    return notFoundText();
  },
};
