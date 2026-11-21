import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { POST as execute } from "../app/api/jupiter/execute/route";
import { GET as order } from "../app/api/jupiter/order/route";
import quoteFixture from "./fixtures/order-quote-sol-usdc.json";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WALLET = "2za3S3W1c8NDvXs2zGpzgG9FZgHqbbsHxcZyfMgvn6t3";
const KEY = "test-key-not-a-real-one";

const upstream = vi.fn<typeof fetch>();

function orderRequest(params: Record<string, string>) {
  return new Request(
    "http://localhost/api/jupiter/order?" + new URLSearchParams(params)
  );
}

function executeRequest(body: unknown) {
  return new Request("http://localhost/api/jupiter/execute", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  upstream.mockReset();
  upstream.mockResolvedValue(Response.json(quoteFixture));
  vi.stubGlobal("fetch", upstream);
  vi.stubEnv("JUPITER_API_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("order: forwards a valid request with the key and returns Jupiter's quote", async () => {
  const response = await order(
    orderRequest({
      inputMint: SOL,
      outputMint: USDC,
      amount: "100000000",
      slippageBps: "50",
      taker: WALLET,
    })
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(quoteFixture);
  expect(response.headers.get("cache-control")).toBe("no-store");

  expect(upstream).toHaveBeenCalledTimes(1);
  const [url, init] = upstream.mock.calls[0];
  expect(String(url)).toBe(
    `https://api.jup.ag/swap/v2/order?inputMint=${SOL}&outputMint=${USDC}&amount=100000000&slippageBps=50&taker=${WALLET}`
  );
  expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
});

test("order: drops parameters this page does not offer", async () => {
  await order(
    orderRequest({
      inputMint: SOL,
      outputMint: USDC,
      amount: "1",
      referralAccount: WALLET,
      referralFee: "255",
      receiver: WALLET,
      payer: WALLET,
    })
  );
  expect(String(upstream.mock.calls[0][0])).toBe(
    `https://api.jup.ag/swap/v2/order?inputMint=${SOL}&outputMint=${USDC}&amount=1`
  );
});

test.each([
  ["a mint that is not on the list", { inputMint: WALLET }],
  ["the same token on both sides", { outputMint: SOL }],
  ["a zero amount", { amount: "0" }],
  ["a decimal amount", { amount: "1.5" }],
  ["a negative amount", { amount: "-5" }],
  ["an amount with trailing text", { amount: "5&taker=x" }],
  ["zero slippage", { slippageBps: "0" }],
  ["slippage above 10%", { slippageBps: "1001" }],
  ["non-numeric slippage", { slippageBps: "abc" }],
  ["a taker that is not an address", { taker: "not-an-address" }],
])("order: refuses %s without calling Jupiter", async (_name, change) => {
  const response = await order(
    orderRequest({
      inputMint: SOL,
      outputMint: USDC,
      amount: "100000000",
      ...change,
    })
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error).toEqual(expect.any(String));
  expect(upstream).not.toHaveBeenCalled();
});

test("order: without a key it says so and calls nothing", async () => {
  vi.stubEnv("JUPITER_API_KEY", "");
  const response = await order(
    orderRequest({ inputMint: SOL, outputMint: USDC, amount: "1" })
  );
  expect(response.status).toBe(503);
  expect((await response.json()).error).toContain("JUPITER_API_KEY");
  expect(upstream).not.toHaveBeenCalled();
});

test.each([
  [401, 502, "API key"],
  [403, 502, "API key"],
  [429, 429, "rate limit"],
])(
  "order: an upstream %i becomes %i with a plain message and no key",
  async (upstreamStatus, status, phrase) => {
    upstream.mockResolvedValue(
      Response.json({ message: `bad key ${KEY}` }, { status: upstreamStatus })
    );
    const response = await order(
      orderRequest({ inputMint: SOL, outputMint: USDC, amount: "1" })
    );
    const text = await response.text();
    expect(response.status).toBe(status);
    expect(text).toContain(phrase);
    expect(text).not.toContain(KEY);
  }
);

test("order: Jupiter's own 400 reason reaches the trader", async () => {
  upstream.mockResolvedValue(
    Response.json({ error: "No routes found" }, { status: 400 })
  );
  const response = await order(
    orderRequest({ inputMint: SOL, outputMint: USDC, amount: "1" })
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "No routes found" });
});

test("order: a network failure or a timeout is reported, not thrown", async () => {
  upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
  const unreachable = await order(
    orderRequest({ inputMint: SOL, outputMint: USDC, amount: "1" })
  );
  expect(unreachable.status).toBe(502);

  upstream.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
  const slow = await order(
    orderRequest({ inputMint: SOL, outputMint: USDC, amount: "1" })
  );
  expect(slow.status).toBe(504);

  upstream.mockResolvedValueOnce(new Response("<html>bad gateway</html>"));
  const garbled = await order(
    orderRequest({ inputMint: SOL, outputMint: USDC, amount: "1" })
  );
  expect(garbled.status).toBe(502);
});

test("execute: forwards only the signed transaction and request ID", async () => {
  const result = { status: "Success", code: 0, signature: "sig" };
  upstream.mockResolvedValue(Response.json(result));

  const response = await execute(
    executeRequest({
      signedTransaction: "AQID",
      requestId: "01a1fbc4-cddf-770d-84e1-c084b94179c6",
      extra: "ignored",
    })
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  const [url, init] = upstream.mock.calls[0];
  expect(String(url)).toBe("https://api.jup.ag/swap/v2/execute");
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
  expect(JSON.parse(String(init?.body))).toEqual({
    signedTransaction: "AQID",
    requestId: "01a1fbc4-cddf-770d-84e1-c084b94179c6",
  });
});

test.each([
  ["a body that is not JSON", "{nope"],
  ["no signed transaction", { requestId: "01a1fbc4-cddf" }],
  [
    "a transaction that is not base64",
    { signedTransaction: "<script>", requestId: "01a1fbc4-cddf" },
  ],
  [
    "an oversized transaction",
    { signedTransaction: "A".repeat(5465), requestId: "01a1fbc4-cddf" },
  ],
  ["no request ID", { signedTransaction: "AQID" }],
  [
    "a request ID with odd characters",
    { signedTransaction: "AQID", requestId: "../../order" },
  ],
])("execute: refuses %s without calling Jupiter", async (_name, body) => {
  const response = await execute(executeRequest(body));
  expect(response.status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
