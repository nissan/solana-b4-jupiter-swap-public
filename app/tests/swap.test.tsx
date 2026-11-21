import {
  address,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from "@solana/kit";
import { useConnect, useWallets } from "@solana/kit-plugin-wallet/react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ClusterProvider } from "../app/components/cluster-context";
import { SwapCard } from "../app/components/swap/swap-card";
import { AppClientProvider, useAppClient } from "../app/lib/client-provider";
import type { ExecuteResult, JupiterOrder } from "../app/lib/jupiter";
import insufficientFunds from "./fixtures/order-insufficient-funds.json";
import solUsdc from "./fixtures/order-quote-sol-usdc.json";
import usdcJup from "./fixtures/order-quote-usdc-jup-auto.json";
import usdcJupRfq from "./fixtures/order-quote-usdc-jup-rfq.json";
import {
  mockWalletAddress,
  mockWalletBehaviour,
  registerMockWallet,
  resetMockWallet,
} from "./mock-wallet";

// order-*.json are real Jupiter responses captured on 21 November 2026.
// Everything about a signed swap is synthetic: an agent never signs on
// mainnet, so the transaction below is an empty one the mock wallet pays for,
// and the /execute answers are built from Jupiter's documented response shape.
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SIGNATURE =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

const unsignedTransaction = getBase64EncodedWireTransaction(
  compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) =>
        setTransactionMessageFeePayer(address(mockWalletAddress), message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash("11111111111111111111111111111111"),
            lastValidBlockHeight: 0n,
          },
          message
        )
    )
  )
);

const signableOrder = {
  ...solUsdc,
  taker: mockWalletAddress,
  transaction: unsignedTransaction,
} as unknown as JupiterOrder;

const success: ExecuteResult = {
  status: "Success",
  code: 0,
  signature: SIGNATURE,
  totalOutputAmount: "6869131",
  outputAmountResult: "6870506",
};

type Reply = { status?: number; body: unknown } | Error;

/** What the two app routes answer; each test sets these. */
let orderReply: (query: URLSearchParams) => Reply;
let executeReply: (body: {
  signedTransaction: string;
  requestId: string;
}) => Reply;
let orderQueries: URLSearchParams[];
let executeBodies: { signedTransaction: string; requestId: string }[];

function respond(reply: Reply): Response {
  if (reply instanceof Error) throw reply;
  return Response.json(reply.body, { status: reply.status ?? 200 });
}

beforeAll(() => {
  registerMockWallet();
});

beforeEach(() => {
  localStorage.clear();
  resetMockWallet();
  orderQueries = [];
  executeBodies = [];
  orderReply = (query) => ({
    body: query.has("taker") ? signableOrder : solUsdc,
  });
  executeReply = () => ({ body: success });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/jupiter/order") {
        orderQueries.push(url.searchParams);
        return respond(orderReply(url.searchParams));
      }
      if (url.pathname === "/api/jupiter/execute") {
        const body = JSON.parse(String(init?.body));
        executeBodies.push(body);
        return respond(executeReply(body));
      }
      throw new Error(`Unexpected request to ${url}`);
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ConnectMockWallet() {
  const client = useAppClient();
  const wallets = useWallets(client);
  const { dispatchAsync: connect } = useConnect(client);
  const wallet = wallets.find((candidate) => candidate.name === "Mock Wallet");
  return (
    <button onClick={() => wallet && void connect(wallet)}>
      Connect mock wallet
    </button>
  );
}

const FAST = { debounceMs: 0, refreshMs: 40, staleMs: 200 };

function renderSwap(timing = FAST) {
  render(
    <ClusterProvider>
      <AppClientProvider>
        <ConnectMockWallet />
        <SwapCard timing={timing} retryDelayMs={1} />
      </AppClientProvider>
    </ClusterProvider>
  );
}

function typeAmount(value: string) {
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value } });
}

async function quoteAndPressSwap() {
  renderSwap();
  fireEvent.click(screen.getByRole("button", { name: "Connect mock wallet" }));
  typeAmount("0.1");
  fireEvent.click(
    await screen.findByRole("button", { name: "Swap SOL for USDC" })
  );
}

function swapSection() {
  return screen.getByRole("region", { name: "Swap" });
}

/** The page has settled: nothing is marked busy and no progress line is left. */
function expectNoSpinner() {
  expect(swapSection().getAttribute("aria-busy")).toBe("false");
  expect(screen.queryByRole("status")).toBeNull();
}

// --- B4-002-S1: a live quote that refreshes before it goes stale ---

test("S1: entering an amount shows output, price impact and route", async () => {
  renderSwap();
  typeAmount("0.1");

  const quote = within(await screen.findByLabelText("Quote"));
  expect(quote.getByText("6.870506 USDC")).toBeTruthy();
  expect(quote.getByText("6.836153 USDC")).toBeTruthy();
  expect(quote.getByText("-0.06%")).toBeTruthy();
  expect(quote.getByText("BisonFi")).toBeTruthy();

  // 0.1 SOL in lamports, default slippage left to Jupiter, no wallet needed.
  expect(Object.fromEntries(orderQueries[0])).toEqual({
    inputMint: SOL,
    outputMint: USDC,
    amount: "100000000",
  });
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Connect a wallet to swap",
    }).disabled
  ).toBe(true);
});

test("S1: a split route lists each venue with its share", async () => {
  orderReply = () => ({ body: usdcJup });
  renderSwap();
  typeAmount("250");

  const quote = within(await screen.findByLabelText("Quote"));
  expect(quote.getByText("Whirlpool 2.47% + ZeroFi 97.53%")).toBeTruthy();
  // This quote was taken with automatic slippage, so it has no minimum yet.
  expect(quote.getByText("Set by Jupiter when you swap")).toBeTruthy();
});

test("S1: a market-maker quote is shown as a fixed price", async () => {
  orderReply = () => ({ body: usdcJupRfq });
  renderSwap();
  typeAmount("250");

  const quote = within(await screen.findByLabelText("Quote"));
  expect(quote.getByText("Same as above (fixed-price quote)")).toBeTruthy();
  expect(quote.getByText("JupiterZ")).toBeTruthy();
});

test("S1: the quote is refreshed on a timer and the new price replaces the old", async () => {
  let asked = 0;
  orderReply = () => ({
    body: { ...solUsdc, outAmount: asked++ === 0 ? "6870506" : "6900000" },
  });
  renderSwap();
  typeAmount("0.1");

  await screen.findByText("6.870506 USDC");
  await screen.findByText("6.9 USDC");
  expect(screen.queryByText("6.870506 USDC")).toBeNull();
  expect(orderQueries.length).toBeGreaterThanOrEqual(2);
});

test("S1: a quote that cannot be refreshed expires instead of staying on offer", async () => {
  let asked = 0;
  orderReply = () =>
    asked++ === 0
      ? { body: solUsdc }
      : { status: 429, body: { error: "Jupiter's rate limit was reached." } };
  renderSwap();
  fireEvent.click(screen.getByRole("button", { name: "Connect mock wallet" }));
  typeAmount("0.1");
  await screen.findByRole("button", { name: "Swap SOL for USDC" });

  const refresh = await screen.findByRole("button", {
    name: "Quote expired. Get a fresh quote",
  });
  expect(
    screen.queryByRole("button", { name: "Swap SOL for USDC" })
  ).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("rate limit");

  // Asking again brings a live quote back.
  asked = 0;
  fireEvent.click(refresh);
  await screen.findByRole("button", { name: "Swap SOL for USDC" });
});

test("S1: the slippage setting and the chosen direction go into the request", async () => {
  renderSwap();
  typeAmount("2.5");
  await screen.findByLabelText("Quote");

  fireEvent.click(screen.getByText("0.5%"));
  await waitFor(() =>
    expect(orderQueries.at(-1)?.get("slippageBps")).toBe("50")
  );

  fireEvent.click(screen.getByRole("button", { name: "Switch tokens" }));
  await waitFor(() =>
    expect(Object.fromEntries(orderQueries.at(-1)!)).toEqual({
      inputMint: USDC,
      outputMint: SOL,
      // 2.5 USDC has six decimals, not nine.
      amount: "2500000",
      slippageBps: "50",
    })
  );
});

test("S1: an amount that cannot be sent is explained and never quoted", async () => {
  renderSwap();
  typeAmount("0.0000000001");
  expect(screen.getByRole("alert").textContent).toContain("decimal places");
  typeAmount("abc");
  expect(screen.getByRole("alert").textContent).toContain("Enter a number");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(orderQueries).toHaveLength(0);
});

// --- B4-002-S2: one transaction signed and sent, signature and amount shown ---

test("S2: confirming signs one transaction, sends it once and shows the result", async () => {
  await quoteAndPressSwap();

  const result = within(await screen.findByRole("alert"));
  expect(result.getByText("Swap complete")).toBeTruthy();
  // Found in the first real swap: the quote it started from stayed on screen
  // above the result and kept ageing. A finished swap shows only its result.
  expect(screen.queryByLabelText("Quote")).toBeNull();
  // What reached the wallet (totalOutputAmount), not the pre-fee route output.
  expect(result.getByText("You received 6.869131 USDC.")).toBeTruthy();
  const link = result.getByRole<HTMLAnchorElement>("link", { name: SIGNATURE });
  expect(link.href).toBe(`https://explorer.solana.com/tx/${SIGNATURE}`);
  expectNoSpinner();

  expect(mockWalletBehaviour.signed).toBe(1);
  expect(executeBodies).toHaveLength(1);
  expect(executeBodies[0].requestId).toBe(solUsdc.requestId);

  // The order was requested for this wallet, and what was sent is that
  // transaction carrying a signature this wallet's key really made.
  expect(orderQueries.at(-1)?.get("taker")).toBe(mockWalletAddress);
  const sent = getTransactionDecoder().decode(
    getBase64Encoder().encode(executeBodies[0].signedTransaction)
  );
  const signature = sent.signatures[address(mockWalletAddress)];
  expect(signature).toBeTruthy();
  expect(
    await verifySignature(
      await getPublicKeyFromAddress(address(mockWalletAddress)),
      signature!,
      sent.messageBytes
    )
  ).toBe(true);
});

// --- B4-002-S3: rejected, expired, slippage exceeded: each named, each retryable ---

test("S3: rejecting in the wallet is named, sends nothing and allows a retry", async () => {
  mockWalletBehaviour.rejectNextSignature = true;
  await quoteAndPressSwap();

  const result = within(await screen.findByRole("alert"));
  expect(result.getByText("You rejected the swap in your wallet")).toBeTruthy();
  expect(executeBodies).toHaveLength(0);
  expectNoSpinner();

  const before = orderQueries.length;
  fireEvent.click(result.getByRole("button", { name: "Get a fresh quote" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Swap SOL for USDC" })
  );
  expect(orderQueries.length).toBeGreaterThan(before);
  expect(await screen.findByText("Swap complete")).toBeTruthy();
  expect(executeBodies).toHaveLength(1);
});

test.each([
  [-1005, "transaction expired before it landed"],
  [-2003, "RFQ quote expired"],
  [-1, "missing cached order"],
])(
  "S3: an expired swap (code %i) is named and can be retried",
  async (code) => {
    executeReply = () => ({
      body: { status: "Failed", code, error: "expired" },
    });
    await quoteAndPressSwap();

    const result = within(await screen.findByRole("alert"));
    expect(result.getByText("The quote expired")).toBeTruthy();
    expectNoSpinner();
    fireEvent.click(result.getByRole("button", { name: "Get a fresh quote" }));
    await screen.findByRole("button", { name: "Swap SOL for USDC" });
  }
);

test("S3: slippage exceeded is named, links the failed transaction and can be retried", async () => {
  executeReply = () => ({
    body: {
      status: "Failed",
      code: 6001,
      signature: SIGNATURE,
      error: "custom program error: 0x1771",
    },
  });
  await quoteAndPressSwap();

  const result = within(await screen.findByRole("alert"));
  expect(result.getByText("Slippage exceeded")).toBeTruthy();
  expect(result.getByRole("link", { name: SIGNATURE })).toBeTruthy();
  expectNoSpinner();
  fireEvent.click(result.getByRole("button", { name: "Get a fresh quote" }));
  await screen.findByRole("button", { name: "Swap SOL for USDC" });
});

// --- Other failures the trader must not be left guessing about ---

test("a wallet without the funds is told so before anything is signed", async () => {
  orderReply = (query) => ({
    body: query.has("taker") ? insufficientFunds : solUsdc,
  });
  await quoteAndPressSwap();

  const result = within(await screen.findByRole("alert"));
  expect(result.getByText("The swap failed")).toBeTruthy();
  expect(
    result.getByText("Your wallet does not hold enough SOL for this swap.")
  ).toBeTruthy();
  expect(mockWalletBehaviour.signed).toBe(0);
  expect(executeBodies).toHaveLength(0);
  expectNoSpinner();
});

test("any other failure shows Jupiter's reason and code", async () => {
  executeReply = () => ({
    body: { status: "Failed", code: -1000, error: "Failed to land" },
  });
  await quoteAndPressSwap();

  const result = within(await screen.findByRole("alert"));
  expect(result.getByText("The swap failed")).toBeTruthy();
  expect(result.getByText("Failed to land (code -1000).")).toBeTruthy();
  expectNoSpinner();
});

test("a lost answer after sending is reported as unconfirmed, then resolved by checking the same transaction", async () => {
  executeReply = () => new TypeError("network down");
  await quoteAndPressSwap();

  const result = within(await screen.findByRole("alert"));
  expect(result.getByText("We could not confirm the result")).toBeTruthy();
  expectNoSpinner();
  // Three tries, all with the one signed transaction: nothing was re-signed.
  expect(executeBodies).toHaveLength(3);
  expect(
    new Set(executeBodies.map((body) => body.signedTransaction)).size
  ).toBe(1);
  expect(mockWalletBehaviour.signed).toBe(1);
  // The fee payer signed, so the transaction ID is known and linked.
  expect(result.getByRole("link")).toBeTruthy();

  // Jupiter no longer holding the order says nothing about whether it landed.
  executeReply = () => ({
    body: { status: "Failed", code: -1, error: "missing cached order" },
  });
  fireEvent.click(result.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(executeBodies).toHaveLength(4));
  expect(
    await screen.findByText("We could not confirm the result")
  ).toBeTruthy();
  expect(screen.queryByText("The quote expired")).toBeNull();

  executeReply = () => ({ body: success });
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText("Swap complete")).toBeTruthy();
  expect(executeBodies[4].signedTransaction).toBe(
    executeBodies[0].signedTransaction
  );
});
