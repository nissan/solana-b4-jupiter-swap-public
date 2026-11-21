"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchOrder, type JupiterOrder } from "../jupiter";

export type QuoteTiming = {
  /** Wait this long after the last keystroke before asking. */
  debounceMs: number;
  /** Ask again this often while the inputs stay the same. */
  refreshMs: number;
  /** A quote older than this is not offered for swapping. */
  staleMs: number;
};

export const DEFAULT_QUOTE_TIMING: QuoteTiming = {
  debounceMs: 400,
  refreshMs: 10_000,
  staleMs: 30_000,
};

type QuoteInputs = {
  inputMint: string;
  outputMint: string;
  /** null while there is no valid amount. */
  amount: bigint | null;
  slippageBps?: number;
  /** Stops asking, e.g. while a swap is in flight. */
  paused: boolean;
};

type Result = {
  key: string;
  order: JupiterOrder | null;
  fetchedAt: number;
  error: string | null;
};

const NO_RESULT: Result = { key: "", order: null, fetchedAt: 0, error: null };

/**
 * A live quote for the current inputs. It refreshes on a timer, and a quote
 * that could not be refreshed in time is reported as stale instead of being
 * left on screen as if it were current.
 */
export function useQuote(inputs: QuoteInputs, timing: QuoteTiming) {
  const { inputMint, outputMint, amount, slippageBps, paused } = inputs;
  const { debounceMs, refreshMs, staleMs } = timing;
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<Result>(NO_RESULT);
  const [now, setNow] = useState(0);

  const key =
    amount === null
      ? ""
      : [inputMint, outputMint, amount, slippageBps ?? "auto", nonce].join("|");

  useEffect(() => {
    if (key === "" || paused || amount === null) return;
    const controller = new AbortController();
    let interval: ReturnType<typeof setInterval> | undefined;

    async function ask() {
      try {
        const order = await fetchOrder(
          { inputMint, outputMint, amount: amount!, slippageBps },
          controller.signal
        );
        if (controller.signal.aborted) return;
        const fetchedAt = Date.now();
        setNow(fetchedAt);
        setResult({ key, order, fetchedAt, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message =
          error instanceof Error ? error.message : "Could not get a quote.";
        // Keep the last good quote for these inputs; it ages into "stale".
        setResult((previous) =>
          previous.key === key
            ? { ...previous, error: message }
            : { key, order: null, fetchedAt: 0, error: message }
        );
      }
    }

    const debounce = setTimeout(() => {
      void ask();
      interval = setInterval(() => {
        if (!document.hidden) void ask();
      }, refreshMs);
    }, debounceMs);

    return () => {
      controller.abort();
      clearTimeout(debounce);
      clearInterval(interval);
    };
  }, [
    key,
    paused,
    inputMint,
    outputMint,
    amount,
    slippageBps,
    debounceMs,
    refreshMs,
  ]);

  // A clock, so a quote goes stale even when nothing else re-renders.
  useEffect(() => {
    const clock = setInterval(
      () => setNow(Date.now()),
      Math.min(1000, refreshMs)
    );
    return () => clearInterval(clock);
  }, [refreshMs]);

  const current = result.key === key && key !== "" ? result : NO_RESULT;
  const order = current.order;
  const isStale = order !== null && now - current.fetchedAt > staleMs;

  /** Drops the current quote and asks again. */
  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  return {
    order,
    error: current.error,
    isLoading: key !== "" && !paused && order === null && !current.error,
    isStale,
    ageSeconds: order
      ? Math.max(0, Math.floor((now - current.fetchedAt) / 1000))
      : 0,
    refresh,
  };
}
