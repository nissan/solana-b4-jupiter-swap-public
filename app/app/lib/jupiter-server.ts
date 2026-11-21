// Server-only: validates what the browser asks for and forwards it to Jupiter
// with the API key. The key is read from the environment on each call and is
// never put in a response.
import { isAddress } from "@solana/kit";
import { findToken } from "./tokens";

const JUPITER_SWAP_API = "https://api.jup.ag/swap/v2";

/** The largest slippage this page will ask for: 10%. */
export const MAX_SLIPPAGE_BPS = 1000;

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateOrderQuery(
  query: URLSearchParams
): Validated<URLSearchParams> {
  const inputMint = query.get("inputMint") ?? "";
  const outputMint = query.get("outputMint") ?? "";
  if (!findToken(inputMint) || !findToken(outputMint)) {
    return { ok: false, error: "That token is not on this page's list." };
  }
  if (inputMint === outputMint) {
    return { ok: false, error: "Choose two different tokens." };
  }
  const amount = query.get("amount") ?? "";
  if (!/^[1-9]\d{0,19}$/.test(amount)) {
    return { ok: false, error: "The amount must be a positive whole number." };
  }
  const upstream = new URLSearchParams({ inputMint, outputMint, amount });

  const slippageBps = query.get("slippageBps");
  if (slippageBps !== null) {
    if (
      !/^\d{1,4}$/.test(slippageBps) ||
      Number(slippageBps) < 1 ||
      Number(slippageBps) > MAX_SLIPPAGE_BPS
    ) {
      return {
        ok: false,
        error: `Slippage must be between 1 and ${MAX_SLIPPAGE_BPS} basis points.`,
      };
    }
    upstream.set("slippageBps", slippageBps);
  }

  const taker = query.get("taker");
  if (taker !== null) {
    if (!isAddress(taker)) {
      return { ok: false, error: "The wallet address is not valid." };
    }
    upstream.set("taker", taker);
  }
  return { ok: true, value: upstream };
}

export function validateExecuteBody(
  body: unknown
): Validated<{ signedTransaction: string; requestId: string }> {
  const { signedTransaction, requestId } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof signedTransaction !== "string" ||
    // A v1 transaction is at most 4096 bytes, 5464 characters in base64.
    signedTransaction.length > 5464 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signedTransaction)
  ) {
    return { ok: false, error: "The signed transaction is not valid base64." };
  }
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9-]{8,64}$/.test(requestId)
  ) {
    return { ok: false, error: "The request ID is not valid." };
  }
  return { ok: true, value: { signedTransaction, requestId } };
}

export function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Calls Jupiter and returns what the browser should see. Jupiter's own JSON
 * passes through for 200 and 400; auth, rate-limit and transport problems are
 * replaced with a plain message so nothing about the key leaks.
 */
export async function forwardToJupiter(
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    return json(
      { error: "The server has no JUPITER_API_KEY set, so it cannot quote." },
      503
    );
  }
  let upstream: Response;
  try {
    upstream = await fetch(JUPITER_SWAP_API + path, {
      ...init,
      headers: { ...init.headers, "x-api-key": apiKey },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    // Not `instanceof Error`: a DOMException from another realm fails it.
    const timedOut =
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "TimeoutError";
    return json(
      {
        error: timedOut
          ? "Jupiter did not answer in time."
          : "Could not reach Jupiter.",
      },
      timedOut ? 504 : 502
    );
  }
  if (upstream.status === 401 || upstream.status === 403) {
    return json({ error: "Jupiter did not accept the server's API key." }, 502);
  }
  if (upstream.status === 429) {
    return json(
      { error: "Jupiter's rate limit was reached. Try again in a moment." },
      429
    );
  }
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return json({ error: "Jupiter sent an unreadable response." }, 502);
  }
  return json(body, upstream.status >= 500 ? 502 : upstream.status);
}
