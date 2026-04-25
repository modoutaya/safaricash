// Story 4.3 — undoTransaction tests.
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteEqMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    from: () => ({
      delete: () => ({
        eq: (...args: unknown[]) => deleteEqMock(...args),
      }),
    }),
  },
}));

import { undoTransaction } from "./undoTransaction";

const TX_ID = "33333333-3333-4333-8333-333333333333";

describe("undoTransaction", () => {
  beforeEach(() => {
    deleteEqMock.mockReset();
  });

  it("happy path — calls supabase delete + invalidates the members list", async () => {
    deleteEqMock.mockResolvedValue({ error: null });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await undoTransaction(TX_ID, client);

    expect(deleteEqMock).toHaveBeenCalledWith("id", TX_ID);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["members", "list"] });
  });

  it("throws when the delete returns an error", async () => {
    deleteEqMock.mockResolvedValue({ error: { message: "RLS rejected" } });
    const client = new QueryClient();
    await expect(undoTransaction(TX_ID, client)).rejects.toThrow(/undoTransaction failed/);
  });
});
