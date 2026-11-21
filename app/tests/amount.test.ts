import { expect, test } from "vitest";
import { formatUnits, parseAmount } from "../app/lib/amount";

test("parses what a trader types into exact smallest units", () => {
  expect(parseAmount("0.1", 9)).toEqual({ ok: true, units: 100_000_000n });
  expect(parseAmount(" 12.5 ", 6)).toEqual({ ok: true, units: 12_500_000n });
  expect(parseAmount(".5", 6)).toEqual({ ok: true, units: 500_000n });
  expect(parseAmount("3.", 6)).toEqual({ ok: true, units: 3_000_000n });
  // Exact where floating point is not: 0.1 + 0.2 style inputs.
  expect(parseAmount("0.3", 9)).toEqual({ ok: true, units: 300_000_000n });
  expect(parseAmount("123456789012.123456789", 9)).toEqual({
    ok: true,
    units: 123_456_789_012_123_456_789n,
  });
});

test("refuses amounts it cannot send as typed", () => {
  expect(parseAmount("", 6)).toEqual({ ok: false, reason: "empty" });
  expect(parseAmount("0", 6)).toEqual({ ok: false, reason: "zero" });
  expect(parseAmount("0.000", 6)).toEqual({ ok: false, reason: "zero" });
  expect(parseAmount("1.0000001", 6)).toEqual({
    ok: false,
    reason: "too-many-decimals",
  });
  for (const bad of ["-1", "1e3", "1,5", "abc", ".", "1.2.3", "0x10"]) {
    expect(parseAmount(bad, 6)).toEqual({ ok: false, reason: "invalid" });
  }
});

test("formats smallest units without rounding up", () => {
  expect(formatUnits("6870506", 6)).toBe("6.870506");
  expect(formatUnits(1_095_558_459n, 6)).toBe("1,095.558459");
  expect(formatUnits(100_000_000n, 9)).toBe("0.1");
  expect(formatUnits(0n, 6)).toBe("0");
  // 0.9999999 SOL is shown as 0.999999, never as 1.
  expect(formatUnits(999_999_900n, 9)).toBe("0.999999");
  expect(formatUnits(999_999_900n, 9, 9)).toBe("0.9999999");
});
