// Browser-side view of Jupiter Swap API v2, reached through this app's own
// /api/jupiter routes so the API key stays on the server.

export type RouteStep = {
  swapInfo: { label: string; inputMint: string; outputMint: string };
  percent: number;
};

export type JupiterOrder = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Minimum output after slippage. */
  otherAmountThreshold: string;
  slippageBps: number;
  /** True on market-maker (RFQ) quotes: the price is fixed, with no slippage. */
  guaranteedPrice?: boolean;
  /** Percentage points, e.g. -0.1 means -0.1%. Missing on some responses. */
  priceImpact?: number;
  /** Deprecated decimal ratio; the fallback when priceImpact is missing. */
  priceImpactPct?: string;
  routePlan: RouteStep[];
  router: string;
  feeBps?: number;
  requestId: string;
  /** null without a taker; "" when a price exists but no transaction could be built. */
  transaction: string | null;
  /** RFQ quotes only. */
  expireAt?: string | null;
  /** The last block height at which the order's transaction can land. */
  lastValidBlockHeight?: string;
  errorCode?: number;
  errorMessage?: string;
};

export type ExecuteResult = {
  status: "Success" | "Failed";
  signature?: string;
  code: number;
  error?: string;
  totalOutputAmount?: string;
  outputAmountResult?: string;
};

export type OrderRequest = {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  /** Omit to let Jupiter choose (its real-time slippage estimator). */
  slippageBps?: number;
  taker?: string;
};

export type ExecuteRequest = {
  signedTransaction: string;
  requestId: string;
};

export class JupiterApiError extends Error {
  constructor(
    message: string,
    /** HTTP status from this app's route; 0 when the request never completed. */
    readonly status: number
  ) {
    super(message);
    this.name = "JupiterApiError";
  }

  /** True when the request may or may not have reached Jupiter. */
  get outcomeUnknown(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

async function readJson<T>(request: Promise<Response>): Promise<T> {
  let response: Response;
  try {
    response = await request;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new JupiterApiError("Could not reach the server.", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new JupiterApiError(
      "The server sent an unreadable response.",
      response.ok ? 502 : response.status
    );
  }
  if (!response.ok) {
    const detail = body as { error?: unknown; message?: unknown };
    const message =
      typeof detail.error === "string"
        ? detail.error
        : typeof detail.message === "string"
          ? detail.message
          : `Request failed (HTTP ${response.status}).`;
    throw new JupiterApiError(message, response.status);
  }
  return body as T;
}

export function fetchOrder(
  request: OrderRequest,
  signal?: AbortSignal
): Promise<JupiterOrder> {
  const query = new URLSearchParams({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount.toString(),
  });
  if (request.slippageBps !== undefined) {
    query.set("slippageBps", String(request.slippageBps));
  }
  if (request.taker) query.set("taker", request.taker);
  return readJson(fetch(`/api/jupiter/order?${query}`, { signal }));
}

export function postExecute(request: ExecuteRequest): Promise<ExecuteResult> {
  return readJson(
    fetch("/api/jupiter/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
  );
}

/** Price impact in percentage points, or null when Jupiter did not say. */
export function priceImpactPercent(order: JupiterOrder): number | null {
  if (typeof order.priceImpact === "number") return order.priceImpact;
  const ratio = Number(order.priceImpactPct);
  return order.priceImpactPct !== undefined && Number.isFinite(ratio)
    ? ratio * 100
    : null;
}

/** Why an order with a price has no transaction to sign, in plain words. */
export function orderBlocker(order: JupiterOrder, inputSymbol: string): string {
  if (order.router === "jupiterz") {
    if (order.errorCode === 1) {
      return `Your wallet does not hold enough ${inputSymbol} for this swap.`;
    }
  } else {
    if (order.errorCode === 1) {
      return `Your wallet does not hold enough ${inputSymbol} for this swap.`;
    }
    if (order.errorCode === 2) {
      return "Your wallet does not hold enough SOL to pay the network fee.";
    }
    if (order.errorCode === 3) {
      return "This amount is too small to swap without SOL for the network fee.";
    }
  }
  return "Jupiter priced this swap but could not build a transaction for it.";
}

export type SwapOutcome =
  | { kind: "success"; signature: string; received: string }
  | { kind: "rejected" }
  | { kind: "expired"; signature?: string }
  | { kind: "slippage"; signature?: string }
  | { kind: "failed"; message: string; signature?: string }
  | { kind: "unconfirmed"; signature?: string }
  /** Found on-chain after the answer was lost; the amount was not read. */
  | { kind: "landed"; signature: string }
  /** Not on-chain, and past the point where it could still land. */
  | { kind: "notLanded" };

// /execute codes that mean the order or its transaction ran out of time:
// -1 cached order gone, -1004 invalid block height, -1005 blockhash expired
// before landing, -2003 RFQ quote expired.
const EXPIRED_CODES = new Set([-1, -1004, -1005, -2003]);
// Jupiter aggregator program error 6001 (0x1771): SlippageToleranceExceeded.
const SLIPPAGE_CODE = 6001;

export function classifyExecute(result: ExecuteResult): SwapOutcome {
  const signature = result.signature || undefined;
  if (result.status === "Success" && result.code === 0 && signature) {
    return {
      kind: "success",
      signature,
      // What reached the wallet, after any fee taken in the output token.
      received: result.totalOutputAmount ?? result.outputAmountResult ?? "0",
    };
  }
  if (EXPIRED_CODES.has(result.code)) return { kind: "expired", signature };
  if (
    result.code === SLIPPAGE_CODE ||
    /slippage|0x1771\b/i.test(result.error ?? "")
  ) {
    return { kind: "slippage", signature };
  }
  return {
    kind: "failed",
    message: `${result.error || "Jupiter could not complete the swap"} (code ${result.code}).`,
    signature,
  };
}

/** Wallets differ in how they report a refusal; these are the common shapes. */
export function isUserRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === 4001) return true;
  return (
    typeof message === "string" &&
    /reject|denied|declin|cancel|disapprov/i.test(message)
  );
}
