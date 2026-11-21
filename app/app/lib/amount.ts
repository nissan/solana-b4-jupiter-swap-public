export type ParsedAmount =
  | { ok: true; units: bigint }
  | { ok: false; reason: "empty" | "invalid" | "too-many-decimals" | "zero" };

/** Turns what the trader typed into the token's smallest unit, exactly. */
export function parseAmount(input: string, decimals: number): ParsedAmount {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text))
    return { ok: false, reason: "invalid" };
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    return { ok: false, reason: "too-many-decimals" };
  }
  const units = BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
  if (units === 0n) return { ok: false, reason: "zero" };
  return { ok: true, units };
}

/**
 * Smallest units as a decimal string. Extra digits are cut, never rounded up:
 * a received amount must not be shown as more than it is.
 */
export function formatUnits(
  units: bigint | string,
  decimals: number,
  maxFractionDigits = 6
): string {
  const value = BigInt(units);
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits
    .slice(digits.length - decimals)
    .slice(0, maxFractionDigits)
    .replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (negative ? "-" : "") + grouped + (fraction ? "." + fraction : "");
}
