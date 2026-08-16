import { describe, it, expect } from "vitest";
import { normalizeCustomHeaders } from "@/lib/customHeaders.js";

describe("normalizeCustomHeaders", () => {
  it("passes valid headers through, trimming names", () => {
    const { headers, error } = normalizeCustomHeaders([{ name: " X-A ", value: "v" }]);
    expect(error).toBeNull();
    expect(headers).toEqual([{ name: "X-A", value: "v" }]);
  });
  it("drops empty-name rows", () => {
    const { headers } = normalizeCustomHeaders([{ name: "  ", value: "x" }, { name: "Keep", value: "y" }]);
    expect(headers).toEqual([{ name: "Keep", value: "y" }]);
  });
  it("defaults missing value to empty string", () => {
    const { headers } = normalizeCustomHeaders([{ name: "X" }]);
    expect(headers).toEqual([{ name: "X", value: "" }]);
  });
  it("dedupes case-insensitively, last wins", () => {
    const { headers } = normalizeCustomHeaders([{ name: "User-Agent", value: "a" }, { name: "user-agent", value: "b" }]);
    expect(headers).toEqual([{ name: "user-agent", value: "b" }]);
  });
  it("rejects invalid header name", () => {
    const { headers, error } = normalizeCustomHeaders([{ name: "Bad Header", value: "v" }]);
    expect(error).toBeTruthy();
    expect(headers).toEqual([]);
  });
  it("rejects CR/LF in header value", () => {
    const { headers, error } = normalizeCustomHeaders([{ name: "X", value: "foo\r\nX-Injected: bar" }]);
    expect(error).toBeTruthy();
    expect(headers).toEqual([]);
  });
  it("non-array input → none, no error", () => {
    expect(normalizeCustomHeaders(undefined)).toEqual({ headers: [], error: null });
    expect(normalizeCustomHeaders(null)).toEqual({ headers: [], error: null });
  });
});
