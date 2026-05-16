// Story 10.1 — dispute handler tests.
//
// disputeGet renders the confirmation form; disputePost parses the form
// body, calls the flag_transaction_dispute RPC (the fetch boundary is
// mocked), and branches the rendered response on the RPC result.

import { afterEach, describe, expect, it, vi } from "vitest";

import { disputeGet, disputePost } from "./dispute";

const TOKEN = "0123456789abcdef0123456789abcdef";

const ENV = {
  SUPABASE_PROJECT_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

function postRequest(notes?: string): Request {
  const body = new URLSearchParams();
  if (notes !== undefined) body.set("notes", notes);
  return new Request(`https://worker.test/r/${TOKEN}/dispute`, {
    method: "POST",
    body,
  });
}

function mockFetch(result: "created" | "already_disputed" | "not_found", ok = true) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(result), {
        status: ok ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("disputeGet", () => {
  it("returns 200 with the confirmation form", () => {
    const res = disputeGet(TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("the form posts to /r/{token}/dispute, shows the 3 copy strings, and has no <script>", async () => {
    const html = await disputeGet(TOKEN).text();
    expect(html).toContain('method="post"');
    expect(html).toContain(`action="/r/${TOKEN}/dispute"`);
    expect(html).toContain("Dites-nous ce qui s'est passé");
    expect(html).toContain("Signaler");
    expect(html).toContain("Annuler");
    expect(html).not.toContain("<script");
  });
});

describe("disputePost", () => {
  it("on RPC 'created' → 200 + the compassionate acknowledgment", async () => {
    vi.stubGlobal("fetch", mockFetch("created"));
    const res = await disputePost(TOKEN, postRequest("Je n'ai jamais reçu cet argent"), ENV);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Votre signalement a été transmis");
    expect(html).not.toContain("<script");
  });

  it("on RPC 'already_disputed' → 200 + the already-sent copy", async () => {
    vi.stubGlobal("fetch", mockFetch("already_disputed"));
    const res = await disputePost(TOKEN, postRequest("encore"), ENV);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Signalement déjà envoyé");
  });

  it("on RPC 'not_found' → 404", async () => {
    vi.stubGlobal("fetch", mockFetch("not_found"));
    const res = await disputePost(TOKEN, postRequest(), ENV);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("introuvable");
  });

  it("on a non-2xx RPC response → 500", async () => {
    vi.stubGlobal("fetch", mockFetch("created", false));
    const res = await disputePost(TOKEN, postRequest(), ENV);
    expect(res.status).toBe(500);
  });

  it("on a thrown fetch (network error) → 500, no leak", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const res = await disputePost(TOKEN, postRequest(), ENV);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("network down");
  });

  it("forwards the token + notes to the flag_transaction_dispute RPC", async () => {
    const fetchMock = mockFetch("created");
    vi.stubGlobal("fetch", fetchMock);
    await disputePost(TOKEN, postRequest("le montant est faux"), ENV);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/rest/v1/rpc/flag_transaction_dispute");
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody).toEqual({ p_receipt_token: TOKEN, p_notes: "le montant est faux" });
  });

  it("clamps an over-long notes body to 500 chars", async () => {
    const fetchMock = mockFetch("created");
    vi.stubGlobal("fetch", fetchMock);
    await disputePost(TOKEN, postRequest("x".repeat(900)), ENV);

    const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect((sentBody.p_notes as string).length).toBe(500);
  });

  it("sends p_notes: null when the free-text is empty", async () => {
    const fetchMock = mockFetch("created");
    vi.stubGlobal("fetch", fetchMock);
    await disputePost(TOKEN, postRequest(""), ENV);

    const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody.p_notes).toBeNull();
  });

  it("returns 500 without calling fetch when the service-role key is unset", async () => {
    const fetchMock = mockFetch("created");
    vi.stubGlobal("fetch", fetchMock);
    const res = await disputePost(TOKEN, postRequest(), {
      SUPABASE_PROJECT_URL: "https://project.supabase.co",
    });
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
