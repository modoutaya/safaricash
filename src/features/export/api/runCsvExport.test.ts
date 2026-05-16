// Story 9.3 — runCsvExport orchestration tests.
//
// Mocks `supabase` (the cycles/members/transactions reads + auth +
// audit RPC) and `triggerCsvDownload` (the only DOM touchpoint).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as BuildCsvModule from "./buildCsv";

const fromMock = vi.fn();
const rpcMock = vi.fn();
const getSessionMock = vi.fn();
const triggerCsvDownloadMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    from: (table: string) => fromMock(table),
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: { getSession: () => getSessionMock() },
  },
}));

vi.mock("./buildCsv", async (importOriginal) => ({
  ...(await importOriginal<typeof BuildCsvModule>()),
  triggerCsvDownload: (...args: unknown[]) => triggerCsvDownloadMock(...args),
}));

import { runCsvExport } from "./runCsvExport";

const COLLECTOR_ID = "c0000000-0000-4000-8000-000000000001";
const MEMBER_ID = "m0000000-0000-4000-8000-000000000001";
const CYCLE_ID = "cy000000-0000-4000-8000-000000000001";

interface TableResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

function stubTables(tables: Record<string, TableResult>) {
  fromMock.mockImplementation((table: string) => ({
    select: () => Promise.resolve(tables[table] ?? { data: [], error: null }),
  }));
}

const OK_TABLES: Record<string, TableResult> = {
  cycles: {
    data: [
      {
        id: CYCLE_ID,
        member_id: MEMBER_ID,
        start_date: "2026-04-01",
        end_date: "2026-04-30",
        status: "active",
      },
    ],
    error: null,
  },
  members_decrypted: {
    data: [{ id: MEMBER_ID, name: "Awa Diop", daily_amount: 500 }],
    error: null,
  },
  transactions_decrypted: {
    data: [
      {
        id: "tx000000-0000-4000-8000-000000000001",
        member_id: MEMBER_ID,
        cycle_id: CYCLE_ID,
        kind: "contribution",
        amount: 500,
        created_at: "2026-04-05T08:00:00Z",
      },
    ],
    error: null,
  },
};

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
  getSessionMock.mockReset();
  triggerCsvDownloadMock.mockReset();
  getSessionMock.mockResolvedValue({ data: { session: { user: { id: COLLECTOR_ID } } } });
  rpcMock.mockResolvedValue({ data: "evt-id", error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCsvExport", () => {
  it("fetches → derives → downloads two CSVs → records the audit event", async () => {
    stubTables(OK_TABLES);

    const result = await runCsvExport();

    expect(triggerCsvDownloadMock).toHaveBeenCalledTimes(2);
    const [cyclesCall, txCall] = triggerCsvDownloadMock.mock.calls;
    expect(cyclesCall![0]).toMatch(/^safaricash-cycles-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(txCall![0]).toMatch(/^safaricash-transactions-\d{4}-\d{2}-\d{2}\.csv$/);
    // The cycle CSV carries the header + the derived row.
    expect(cyclesCall![1]).toContain("cycle_id,member_name");
    expect(cyclesCall![1]).toContain("Awa Diop");

    expect(rpcMock).toHaveBeenCalledWith("audit_append_external", {
      p_event_type: "export.csv_generated",
      p_entity_id: COLLECTOR_ID,
      p_entity_table: "users",
      p_payload: { cycles_count: 1, transactions_count: 1 },
    });
    expect(result).toEqual({ cyclesCount: 1, transactionsCount: 1, auditFailed: false });
  });

  it("a failed audit RPC does not throw — auditFailed is true, downloads still happen", async () => {
    stubTables(OK_TABLES);
    rpcMock.mockResolvedValue({ data: null, error: { message: "network" } });

    const result = await runCsvExport();

    expect(triggerCsvDownloadMock).toHaveBeenCalledTimes(2);
    expect(result.auditFailed).toBe(true);
  });

  it("an audit RPC that throws does not throw out of runCsvExport", async () => {
    stubTables(OK_TABLES);
    rpcMock.mockRejectedValue(new Error("boom"));

    const result = await runCsvExport();

    expect(result.auditFailed).toBe(true);
    expect(triggerCsvDownloadMock).toHaveBeenCalledTimes(2);
  });

  it("a missing session marks the audit as failed without calling the RPC", async () => {
    stubTables(OK_TABLES);
    getSessionMock.mockResolvedValue({ data: { session: null } });

    const result = await runCsvExport();

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.auditFailed).toBe(true);
  });

  it("empty data still produces two downloads with zero counts", async () => {
    stubTables({
      cycles: { data: [], error: null },
      members_decrypted: { data: [], error: null },
      transactions_decrypted: { data: [], error: null },
    });

    const result = await runCsvExport();

    expect(triggerCsvDownloadMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ cyclesCount: 0, transactionsCount: 0 });
  });

  it("throws and downloads nothing when the transactions query errors", async () => {
    stubTables({
      ...OK_TABLES,
      transactions_decrypted: { data: null, error: { message: "RLS denied" } },
    });

    await expect(runCsvExport()).rejects.toThrow(/transactions query failed/);
    expect(triggerCsvDownloadMock).not.toHaveBeenCalled();
  });

  it("throws when the cycles query errors", async () => {
    stubTables({ ...OK_TABLES, cycles: { data: null, error: { message: "boom" } } });
    await expect(runCsvExport()).rejects.toThrow(/cycles query failed/);
    expect(triggerCsvDownloadMock).not.toHaveBeenCalled();
  });

  it("throws when the members query errors", async () => {
    stubTables({ ...OK_TABLES, members_decrypted: { data: null, error: { message: "boom" } } });
    await expect(runCsvExport()).rejects.toThrow(/members query failed/);
    expect(triggerCsvDownloadMock).not.toHaveBeenCalled();
  });
});
