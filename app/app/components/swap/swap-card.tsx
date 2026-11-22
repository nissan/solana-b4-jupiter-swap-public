"use client";

import { useId, useState } from "react";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { formatUnits, parseAmount } from "../../lib/amount";
import { useAppClient } from "../../lib/client-provider";
import {
  DEFAULT_QUOTE_TIMING,
  useQuote,
  type QuoteTiming,
} from "../../lib/hooks/use-quote";
import { useSwap } from "../../lib/hooks/use-swap";
import {
  priceImpactPercent,
  type JupiterOrder,
  type SwapOutcome,
} from "../../lib/jupiter";
import { findToken, TOKENS, type Token } from "../../lib/tokens";
import { useCluster } from "../cluster-context";

const SLIPPAGE_CHOICES = [
  { value: "auto", label: "Auto" },
  { value: "10", label: "0.1%" },
  { value: "50", label: "0.5%" },
  { value: "100", label: "1%" },
] as const;

type SlippageChoice = (typeof SLIPPAGE_CHOICES)[number]["value"];

const AMOUNT_ERRORS = {
  invalid: "Enter a number, like 0.5.",
  "too-many-decimals": "That has more decimal places than this token allows.",
  zero: "Enter an amount above zero.",
} as const;

const PROGRESS = {
  preparing: "Getting a fresh price and building the transaction…",
  signing: "Approve the swap in your wallet…",
  sending:
    "Sending the swap and waiting for it to confirm. Keep this page open…",
} as const;

const fieldClass =
  "flex w-full items-center justify-between rounded-lg border border-border-low bg-background px-3 py-2 text-sm outline-none focus:border-ring";
const itemClass =
  "cursor-pointer rounded px-2 py-1.5 data-[highlighted]:bg-background";

function TokenSelect({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (mint: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <Select
        value={value}
        onValueChange={(mint) => mint && onChange(mint)}
        disabled={disabled}
      >
        <SelectLabel className="block text-xs font-medium">{label}</SelectLabel>
        <SelectTrigger className={fieldClass}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="z-50 min-w-48 rounded-lg border border-border-low bg-card p-1 text-sm shadow-lg">
          {TOKENS.map((token) => (
            <SelectItem
              key={token.mint}
              value={token.mint}
              className={itemClass}
            >
              {token.symbol}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function QuoteDetails({
  order,
  output,
  ageSeconds,
  isStale,
  held,
}: {
  order: JupiterOrder;
  output: Token;
  ageSeconds: number;
  isStale: boolean;
  /** A swap is in flight: the quote is not being refreshed. */
  held: boolean;
}) {
  const impact = priceImpactPercent(order);
  return (
    <dl
      aria-label="Quote"
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-border-low bg-background p-3 text-xs"
    >
      <dt className="text-muted">You receive (estimated)</dt>
      <dd className="text-right text-sm font-semibold">
        {formatUnits(order.outAmount, output.decimals)} {output.symbol}
      </dd>
      <dt className="text-muted">Minimum received</dt>
      <dd className="text-right">
        {/* A market-maker quote is a fixed price. Otherwise, with automatic
            slippage, a quote carries no tolerance yet: Jupiter sets it when
            it builds the transaction. */}
        {order.slippageBps > 0
          ? `${formatUnits(order.otherAmountThreshold, output.decimals)} ${output.symbol}`
          : order.guaranteedPrice
            ? "Same as above (fixed-price quote)"
            : "Set by Jupiter when you swap"}
      </dd>
      <dt className="text-muted">Price impact</dt>
      <dd
        className={`text-right ${impact !== null && impact <= -1 ? "font-semibold text-red-600" : ""}`}
      >
        {impact === null
          ? "Not reported"
          : Math.abs(impact) < 0.005
            ? "Less than 0.01%"
            : `${impact.toFixed(2)}%`}
        {impact !== null && impact <= -1 && " (high)"}
      </dd>
      <dt className="text-muted">Route</dt>
      <dd className="text-right">
        {order.routePlan.length === 0
          ? order.router
          : order.routePlan
              .map((step) =>
                step.percent === 100
                  ? step.swapInfo.label
                  : `${step.swapInfo.label} ${step.percent}%`
              )
              .join(" + ")}
      </dd>
      <dt className="text-muted">Quote age</dt>
      <dd className="text-right">
        {held
          ? "Held while you swap"
          : isStale
            ? "Expired"
            : `${ageSeconds}s, refreshes automatically`}
      </dd>
    </dl>
  );
}

function OutcomePanel({
  outcome,
  output,
  explorerUrl,
  onFreshQuote,
  onCheckAgain,
}: {
  outcome: SwapOutcome;
  output: Token;
  explorerUrl: (path: string) => string;
  onFreshQuote: () => void;
  onCheckAgain: () => void;
}) {
  const signature = "signature" in outcome ? outcome.signature : undefined;
  const copy: Record<SwapOutcome["kind"], { title: string; body: string }> = {
    success: {
      title: "Swap complete",
      body:
        outcome.kind === "success"
          ? `You received ${formatUnits(outcome.received, output.decimals, output.decimals)} ${output.symbol}.`
          : "",
    },
    rejected: {
      title: "You rejected the swap in your wallet",
      body: "Nothing was signed or sent, and your tokens have not moved.",
    },
    expired: {
      title: "The quote expired",
      body: "The swap ran out of time before it could land. Your tokens have not moved.",
    },
    slippage: {
      title: "Slippage exceeded",
      body: "The price moved further than your slippage setting allows, so the swap was cancelled on-chain. Your tokens have not moved; a network fee may have been charged.",
    },
    failed: {
      title: "The swap failed",
      body: outcome.kind === "failed" ? outcome.message : "",
    },
    unconfirmed: {
      title: "We could not confirm the result",
      body: signature
        ? "The swap was signed and sent, but the answer did not come back. It may or may not have gone through. Check before you try again."
        : "The swap was signed and sent, but the answer did not come back, and it was not found on-chain yet. It may still land. Check again in a few seconds before you try again.",
    },
    landed: {
      title: "The swap went through",
      body: "Jupiter's answer was lost, but the transaction is on-chain and succeeded. Your wallet shows the amount received.",
    },
    notLanded: {
      title: "The swap did not go through",
      body: "It was not found on-chain, and it ran out of time to land. Your tokens have not moved.",
    },
  };
  const { title, body } = copy[outcome.kind];
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-border-low bg-background p-3 text-sm"
    >
      <h3 className="font-semibold">{title}</h3>
      <p className="text-xs leading-relaxed text-muted">{body}</p>
      {signature && (
        <p className="break-all text-xs">
          Transaction:{" "}
          <a
            href={explorerUrl(`/tx/${signature}`)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {signature}
          </a>
        </p>
      )}
      <div className="flex gap-2 pt-1">
        {outcome.kind === "unconfirmed" && (
          <button
            type="button"
            onClick={onCheckAgain}
            className="cursor-pointer rounded-lg border border-border-low px-3 py-1.5 text-xs font-medium"
          >
            Check again
          </button>
        )}
        <button
          type="button"
          onClick={onFreshQuote}
          className="cursor-pointer rounded-lg border border-border-low px-3 py-1.5 text-xs font-medium"
        >
          {outcome.kind === "success" || outcome.kind === "landed"
            ? "Swap again"
            : "Get a fresh quote"}
        </button>
      </div>
    </div>
  );
}

export function SwapCard({
  timing = DEFAULT_QUOTE_TIMING,
  retryDelayMs,
}: {
  timing?: QuoteTiming;
  retryDelayMs?: number;
}) {
  const client = useAppClient();
  const connected = useConnectedWallet(client);
  const { cluster, getExplorerUrl } = useCluster();
  const amountId = useId();

  const [inputMint, setInputMint] = useState(TOKENS[0].mint);
  const [outputMint, setOutputMint] = useState(TOKENS[1].mint);
  const [amountText, setAmountText] = useState("");
  const [slippage, setSlippage] = useState<SlippageChoice>("auto");

  const input = findToken(inputMint)!;
  const output = findToken(outputMint)!;
  const parsed = parseAmount(amountText, input.decimals);
  const amount = parsed.ok ? parsed.units : null;
  const slippageBps = slippage === "auto" ? undefined : Number(slippage);

  const { phase, start, checkAgain, reset } = useSwap(client.rpc, retryDelayMs);
  const busy = phase.step !== "idle" && phase.step !== "done";
  const quote = useQuote(
    {
      inputMint,
      outputMint,
      amount,
      slippageBps,
      paused: phase.step !== "idle",
    },
    timing
  );

  function choose(side: "input" | "output", mint: string) {
    // Picking the token already on the other side swaps the two.
    if (side === "input") {
      if (mint === outputMint) setOutputMint(inputMint);
      setInputMint(mint);
    } else {
      if (mint === inputMint) setInputMint(outputMint);
      setOutputMint(mint);
    }
  }

  function freshQuote() {
    reset();
    quote.refresh();
  }

  const signer = connected?.signer ?? null;
  const onMainnet = cluster === "mainnet";
  let blocker: string | null = null;
  if (!onMainnet) blocker = "Switch to mainnet to swap";
  else if (!connected) blocker = "Connect a wallet to swap";
  else if (!signer) blocker = "This wallet cannot sign";
  else if (amount === null) blocker = "Enter an amount";
  else if (quote.isStale) blocker = "Quote expired";
  else if (!quote.order) blocker = quote.error ? "No quote" : "Getting quote…";

  return (
    <section
      aria-label="Swap"
      aria-busy={busy}
      className="mt-8 max-w-md space-y-4 rounded-2xl border border-border-low bg-card p-6"
    >
      {!onMainnet && (
        <p className="rounded-lg border border-border-low bg-background px-3 py-2 text-xs text-muted">
          Jupiter swaps run on Solana mainnet. Prices shown are mainnet prices;
          switch the network in the header to mainnet to swap.
        </p>
      )}

      <div className="grid grid-cols-[7rem_1fr] items-end gap-3">
        <TokenSelect
          label="You pay"
          value={inputMint}
          onChange={(mint) => choose("input", mint)}
          disabled={phase.step !== "idle"}
        />
        <div>
          <label htmlFor={amountId} className="block text-xs font-medium">
            Amount
          </label>
          <input
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.0"
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            disabled={phase.step !== "idle"}
            aria-invalid={!parsed.ok && parsed.reason !== "empty"}
            className={fieldClass}
          />
        </div>
      </div>
      {!parsed.ok && parsed.reason !== "empty" && (
        <p role="alert" className="text-xs text-red-600">
          {AMOUNT_ERRORS[parsed.reason]}
        </p>
      )}

      <div className="grid grid-cols-[7rem_1fr] items-end gap-3">
        <TokenSelect
          label="You receive"
          value={outputMint}
          onChange={(mint) => choose("output", mint)}
          disabled={phase.step !== "idle"}
        />
        <button
          type="button"
          onClick={() => choose("input", outputMint)}
          disabled={phase.step !== "idle"}
          className="cursor-pointer justify-self-start rounded-lg border border-border-low px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
        >
          Switch tokens
        </button>
      </div>

      <div>
        <span id={`${amountId}-slippage`} className="block text-xs font-medium">
          Slippage tolerance
        </span>
        <SegmentedControl
          aria-labelledby={`${amountId}-slippage`}
          value={slippage}
          onValueChange={(value) => value && setSlippage(value)}
          disabled={phase.step !== "idle"}
          className="mt-1 inline-flex gap-1 rounded-lg border border-border-low bg-background p-1"
        >
          {SLIPPAGE_CHOICES.map((choice) => (
            <SegmentedControlItem
              key={choice.value}
              value={choice.value}
              className="cursor-pointer rounded px-2.5 py-1 text-xs font-medium data-[checked]:bg-card data-[checked]:shadow"
            >
              {choice.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <p className="mt-1 text-xs text-muted">
          {slippage === "auto"
            ? "Jupiter picks a tolerance for current conditions."
            : "The swap is cancelled if the price moves further than this."}
        </p>
      </div>

      {/* Once a swap has ended the quote it started from is history: the
          outcome below says what happened, and a retry fetches a new one. */}
      {quote.order && phase.step !== "done" && (
        <QuoteDetails
          order={quote.order}
          output={output}
          ageSeconds={quote.ageSeconds}
          isStale={quote.isStale}
          held={busy}
        />
      )}
      {quote.isLoading && (
        <p role="status" className="text-xs text-muted">
          Getting a quote…
        </p>
      )}
      {phase.step === "idle" &&
        quote.error &&
        (!quote.order || quote.isStale) && (
          <p role="alert" className="text-xs text-red-600">
            {quote.order ? "The quote could not be refreshed: " : ""}
            {quote.error}
          </p>
        )}

      {phase.step === "done" ? (
        <OutcomePanel
          outcome={phase.outcome}
          output={output}
          explorerUrl={getExplorerUrl}
          onFreshQuote={freshQuote}
          onCheckAgain={() => void checkAgain()}
        />
      ) : busy ? (
        <p role="status" className="text-sm">
          {PROGRESS[phase.step as keyof typeof PROGRESS]}
        </p>
      ) : quote.isStale || (quote.error && !quote.order && amount !== null) ? (
        <button
          type="button"
          onClick={quote.refresh}
          className="w-full cursor-pointer rounded-lg border border-border-low px-4 py-2.5 text-sm font-semibold"
        >
          {quote.isStale ? "Quote expired. Get a fresh quote" : "Try again"}
        </button>
      ) : (
        <button
          type="button"
          disabled={blocker !== null}
          onClick={() => {
            if (!connected || !signer || amount === null) return;
            void start({
              request: {
                inputMint,
                outputMint,
                amount,
                slippageBps,
                taker: connected.account.address,
              },
              signer,
              inputSymbol: input.symbol,
            });
          }}
          className="w-full cursor-pointer rounded-lg bg-foreground px-4 py-2.5 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          {blocker ?? `Swap ${input.symbol} for ${output.symbol}`}
        </button>
      )}
    </section>
  );
}
