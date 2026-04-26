// Story 4.5 — undoTransaction soft-undo helper tests (rewrite of 4.3 tests).

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import { undoTransaction } from "./undoTransaction";
import { UndoTransactionError } from "./undoTransactionError";

const TX_ID = "11111111-1111-4111-8111-111111111111";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe("undoTransaction", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — calls undo_transaction RPC + invalidates member queries", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    await undoTransaction(TX_ID, client);

    expect(rpcMock).toHaveBeenCalledWith("undo_transaction", { p_transaction_id: TX_ID });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["members", "list"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["members", "profile"] });
  });

  it("classifies sqlstate 22023 → window_expired", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "22023", message: "window_expired: undo window of 5 seconds elapsed" },
    });

    await expect(undoTransaction(TX_ID, makeClient())).rejects.toMatchObject({
      name: "UndoTransactionError",
      code: "window_expired",
    });
  });

  it("classifies sqlstate 0L000 → already_undone", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "0L000", message: "already_undone: transaction already undone" },
    });

    await expect(undoTransaction(TX_ID, makeClient())).rejects.toMatchObject({
      name: "UndoTransactionError",
      code: "already_undone",
    });
  });

  it("classifies sqlstate 28000 → unauthorized", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "28000", message: "unauthorized: foreign collector" },
    });

    await expect(undoTransaction(TX_ID, makeClient())).rejects.toMatchObject({
      name: "UndoTransactionError",
      code: "unauthorized",
    });
  });

  it("classifies sqlstate P0002 → not_found", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "not_found: transaction does not exist" },
    });

    await expect(undoTransaction(TX_ID, makeClient())).rejects.toMatchObject({
      name: "UndoTransactionError",
      code: "not_found",
    });
  });

  it("classifies network errors", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "Failed to fetch" },
    });

    await expect(undoTransaction(TX_ID, makeClient())).rejects.toMatchObject({
      name: "UndoTransactionError",
      code: "network",
    });
  });

  it("falls back to unknown for unrecognised errors", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "boom from outer space" },
    });

    await expect(undoTransaction(TX_ID, makeClient())).rejects.toMatchObject({
      name: "UndoTransactionError",
      code: "unknown",
    });
  });

  it("re-throws as UndoTransactionError instance (instanceof check)", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "22023", message: "window_expired" },
    });

    try {
      await undoTransaction(TX_ID, makeClient());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UndoTransactionError);
    }
  });
});
