// Story 6.4 — dispute-route 501 placeholder.
// Story 10.2 will replace these handlers with the saver dispute
// submission flow per UX-DR20 (form + dispute_ack SMS dispatch).

import { renderComingSoonDisputeHtml } from "./render";

export function disputeGet(token: string): Response {
  return new Response(renderComingSoonDisputeHtml(token), {
    status: 501,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    },
  });
}

export function disputePost(): Response {
  return new Response("Story 10.2 will land this endpoint.", {
    status: 501,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}
