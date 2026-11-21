// Reproduces the reviewer-checkable parts of this build against a running
// copy of the app. Read-only: it asks for quotes, checks that bad requests
// are refused, and reads one already-finalized swap back from the chain.
// It never signs and never sends a transaction.
//
//   JUPITER_API_KEY=... pnpm start     # in one terminal
//   pnpm run reproduce                 # in another
//
// APP_URL         where the app is running (default http://localhost:3000)
// SOLANA_RPC_URL  a mainnet RPC for the read-back (default: the public one)

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// A public address with no mainnet SOL: the shared devnet payer of this series.
const EMPTY_WALLET = "2za3S3W1c8NDvXs2zGpzgG9FZgHqbbsHxcZyfMgvn6t3";
// The first real swap made through this page, by the owner, 21 November 2026.
const REAL_SWAP = {
  signature:
    "2YLqhcJaGArs3aGARqb7FFW4MouCr9UMq437cg3ouD41LM1FAmUoEC5181pkftqX9jiFg9iC5e2Lswzxxw9eh1Va",
  wallet: "Ejj2VMfsFXnAqTBYUkCtmGWMHDvhxyvJyoiwxCnNWBM1",
  receivedUsdcUnits: 684945n,
  swappedLamports: 10_000_000n,
};

let failures = 0;

function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`
  );
}

async function order(params) {
  const response = await fetch(
    `${APP_URL}/api/jupiter/order?${new URLSearchParams(params)}`
  );
  return { status: response.status, body: await response.json() };
}

function units(amount, decimals) {
  const text = amount.toString().padStart(decimals + 1, "0");
  const fraction = text.slice(-decimals).replace(/0+$/, "");
  return text.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}

async function liveQuote() {
  console.log("\n1. A live quote (scenario B4-002-S1)");
  const { status, body } = await order({
    inputMint: SOL,
    outputMint: USDC,
    amount: "100000000",
    slippageBps: "50",
  });
  if (status !== 200) {
    check(
      false,
      "the app returned a quote",
      `HTTP ${status} ${body.error ?? ""}`
    );
    return;
  }
  check(
    BigInt(body.outAmount) > 0n,
    "output amount",
    `0.1 SOL -> ${units(BigInt(body.outAmount), 6)} USDC`
  );
  check(
    BigInt(body.otherAmountThreshold) <= BigInt(body.outAmount),
    "minimum received at 0.5% slippage",
    `${units(BigInt(body.otherAmountThreshold), 6)} USDC`
  );
  const impact = body.priceImpact ?? Number(body.priceImpactPct) * 100;
  check(Number.isFinite(impact), "price impact", `${impact.toFixed(4)}%`);
  const route = body.routePlan.map((step) => step.swapInfo.label).join(" + ");
  check(route.length > 0, "route", `${route} (router: ${body.router})`);
  check(body.transaction === null, "no transaction without a wallet");
}

async function refusals() {
  console.log("\n2. Requests the server refuses without calling Jupiter");
  const cases = [
    [
      "a token that is not on the list",
      { inputMint: EMPTY_WALLET, outputMint: USDC, amount: "1" },
    ],
    [
      "the same token on both sides",
      { inputMint: SOL, outputMint: SOL, amount: "1" },
    ],
    ["a zero amount", { inputMint: SOL, outputMint: USDC, amount: "0" }],
    [
      "slippage above 10%",
      { inputMint: SOL, outputMint: USDC, amount: "1", slippageBps: "1001" },
    ],
    [
      "a wallet that is not an address",
      { inputMint: SOL, outputMint: USDC, amount: "1", taker: "nope" },
    ],
  ];
  for (const [label, params] of cases) {
    const { status, body } = await order(params);
    check(status === 400, label, `HTTP ${status} "${body.error}"`);
  }
  const response = await fetch(`${APP_URL}/api/jupiter/execute`, {
    method: "POST",
    body: JSON.stringify({ signedTransaction: "<not base64>", requestId: "x" }),
  });
  check(
    response.status === 400,
    "an execute body that is not a signed transaction",
    `HTTP ${response.status}`
  );
}

async function namedBlocker() {
  console.log(
    "\n3. A wallet without funds gets a named reason and nothing to sign"
  );
  const { status, body } = await order({
    inputMint: SOL,
    outputMint: USDC,
    amount: "100000000",
    taker: EMPTY_WALLET,
  });
  check(
    status === 200 && body.transaction === "",
    "no transaction was built",
    `HTTP ${status}`
  );
  check(
    body.errorCode === 1,
    "Jupiter's reason",
    `errorCode ${body.errorCode} "${body.errorMessage}"`
  );
}

async function realSwap() {
  console.log(
    "\n4. The real swap, read back from mainnet (scenario B4-002-S2)"
  );
  console.log(`  https://explorer.solana.com/tx/${REAL_SWAP.signature}`);
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        REAL_SWAP.signature,
        {
          commitment: "finalized",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 1,
        },
      ],
    }),
  });
  const { result, error } = await response.json();
  if (!result) {
    check(
      false,
      "the transaction was found",
      error?.message ?? "not returned by this RPC"
    );
    return;
  }
  const { meta, transaction, slot, blockTime } = result;
  const signers = transaction.message.accountKeys.filter((key) => key.signer);
  check(
    meta.err === null,
    "finalized with no error",
    `slot ${slot}, ${new Date(blockTime * 1000).toISOString()}`
  );
  check(
    signers.length === 1 && signers[0].pubkey === REAL_SWAP.wallet,
    "one signer, the trader's wallet",
    REAL_SWAP.wallet
  );
  const usdc = (balances) =>
    BigInt(
      balances.find((b) => b.mint === USDC && b.owner === REAL_SWAP.wallet)
        ?.uiTokenAmount.amount ?? 0
    );
  const received = usdc(meta.postTokenBalances) - usdc(meta.preTokenBalances);
  check(
    received === REAL_SWAP.receivedUsdcUnits,
    "USDC received equals what the page showed",
    `${units(received, 6)} USDC`
  );
  const paid = BigInt(meta.preBalances[0]) - BigInt(meta.postBalances[0]);
  check(
    paid === REAL_SWAP.swappedLamports + BigInt(meta.fee),
    "SOL paid is the swap amount plus the network fee",
    `${units(paid, 9)} SOL (fee ${units(BigInt(meta.fee), 9)})`
  );
}

console.log(`Jupiter swap page: reproduction against ${APP_URL}`);
try {
  await liveQuote();
  await refusals();
  await namedBlocker();
  await realSwap();
} catch (error) {
  failures += 1;
  console.log(`\nStopped: ${error instanceof Error ? error.message : error}`);
  console.log(`Is the app running at ${APP_URL} with JUPITER_API_KEY set?`);
}
console.log(
  failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
