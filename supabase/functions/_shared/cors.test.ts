// QA fix — withCors unit test.
//
// In-process unit test (no Supabase stack): asserts the OPTIONS preflight
// is answered with 204 + CORS headers, and that a wrapped handler's
// response carries the Access-Control-* headers regardless of its status.

import { assertEquals } from "jsr:@std/assert@1";

import { corsHeaders, withCors } from "./cors.ts";

const denoOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test("withCors answers the OPTIONS preflight with 204 + CORS headers", denoOpts, async () => {
  let handlerCalled = false;
  const wrapped = withCors(() => {
    handlerCalled = true;
    return Promise.resolve(new Response("ok"));
  });

  const res = await wrapped(new Request("https://x.test/re-auth", { method: "OPTIONS" }));

  assertEquals(res.status, 204);
  assertEquals(
    res.headers.get("Access-Control-Allow-Origin"),
    corsHeaders["Access-Control-Allow-Origin"],
  );
  assertEquals(handlerCalled, false);
});

Deno.test("withCors merges CORS headers into a success response", denoOpts, async () => {
  const wrapped = withCors(() =>
    Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  );

  const res = await wrapped(new Request("https://x.test/re-auth", { method: "POST" }));
  await res.body?.cancel();

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    res.headers.get("Access-Control-Allow-Headers"),
    corsHeaders["Access-Control-Allow-Headers"],
  );
});

Deno.test("withCors merges CORS headers into an error response", denoOpts, async () => {
  const wrapped = withCors(() => Promise.resolve(new Response("nope", { status: 401 })));

  const res = await wrapped(new Request("https://x.test/re-auth", { method: "POST" }));
  await res.body?.cancel();

  assertEquals(res.status, 401);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});
