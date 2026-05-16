// Story 9.3 — buildCsv tests.

import { afterEach, describe, expect, it, vi } from "vitest";

import { toCsv, triggerCsvDownload } from "./buildCsv";

describe("toCsv", () => {
  it("serialises a header row only when there are no data rows", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b");
  });

  it("serialises header + rows with CRLF line endings", () => {
    expect(
      toCsv(
        ["x", "y"],
        [
          ["1", "2"],
          ["3", "4"],
        ],
      ),
    ).toBe("x,y\r\n1,2\r\n3,4");
  });

  it("stringifies numeric cells", () => {
    expect(toCsv(["n"], [[500], [1000]])).toBe("n\r\n500\r\n1000");
  });

  it("quotes a field containing a comma", () => {
    expect(toCsv(["name"], [["Diop, Awa"]])).toBe('name\r\n"Diop, Awa"');
  });

  it("quotes a field containing a double-quote and doubles the quote", () => {
    expect(toCsv(["name"], [['Awa "AD" Diop']])).toBe('name\r\n"Awa ""AD"" Diop"');
  });

  it("quotes a field containing a newline", () => {
    expect(toCsv(["name"], [["line1\nline2"]])).toBe('name\r\n"line1\nline2"');
  });

  it("quotes a field containing a carriage return", () => {
    expect(toCsv(["name"], [["a\rb"]])).toBe('name\r\n"a\rb"');
  });

  it("leaves an ordinary field unquoted", () => {
    expect(toCsv(["name"], [["Awa Diop"]])).toBe("name\r\nAwa Diop");
  });
});

describe("triggerCsvDownload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an object URL, clicks an anchor, and revokes the URL", () => {
    const createObjectURL = vi.fn(() => "blob:fake");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    triggerCsvDownload("safaricash-cycles-2026-05-16.csv", "a,b\r\n1,2");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    vi.unstubAllGlobals();
  });

  it("is a no-op when URL.createObjectURL is unavailable (non-DOM env)", () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: undefined });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    expect(() => triggerCsvDownload("x.csv", "a,b")).not.toThrow();
    expect(clickSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
