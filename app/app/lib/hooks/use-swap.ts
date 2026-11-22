"use client";

import { useCallback, useRef, useState } from "react";
import {
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  isTransactionModifyingSigner,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  classifyExecute,
  fetchOrder,
  isUserRejection,
  JupiterApiError,
  orderBlocker,
  postExecute,
  type ExecuteRequest,
  type OrderRequest,
  type SwapOutcome,
} from "../jupiter";
import { findLanded, type LookupRpc } from "../find-landed";

export type SwapPhase =
  | { step: "idle" }
  | { step: "preparing" }
  | { step: "signing" }
  | { step: "sending" }
  | { step: "done"; outcome: SwapOutcome };

type StartArgs = {
  request: OrderRequest & { taker: string };
  signer: TransactionSigner;
  inputSymbol: string;
};

type Signed = {
  /** The signed transaction, base64. */
  transaction: string;
  /** The transaction ID, when the fee payer's signature is already present. */
  signature?: string;
  /** The wallet's own signature, base58: always present once signed. */
  takerSignature: string;
};

type Sent = {
  payload: ExecuteRequest;
  signature?: string;
  taker: Address;
  takerSignature: string;
  /** Unix seconds, just before the first send. */
  sentAt: number;
  lastValidBlockHeight?: bigint;
};

const SEND_ATTEMPTS = 3;

function failed(message: string): SwapPhase {
  return { step: "done", outcome: { kind: "failed", message } };
}

/** Has the wallet sign the order's transaction. Nothing is sent here. */
async function signOrder(
  transaction: string,
  signer: TransactionSigner,
  taker: string
): Promise<Signed> {
  if (!isTransactionModifyingSigner(signer)) {
    throw new Error(
      "This wallet can only sign and send in one step, which Jupiter's managed execution does not support."
    );
  }
  const unsigned = getTransactionDecoder().decode(
    getBase64Encoder().encode(transaction)
  );
  const [signed] = await signer.modifyAndSignTransactions([
    unsigned as Parameters<typeof signer.modifyAndSignTransactions>[0][number],
  ]);
  const own = signed.signatures[taker as Address];
  if (!own) {
    throw new Error(
      "The wallet returned the transaction without its signature."
    );
  }
  // The transaction's ID is its first signature, the fee payer's. On a
  // gasless order someone else pays and that slot is still empty here.
  const first = Object.values(signed.signatures)[0];
  return {
    transaction: getBase64Decoder().decode(
      getTransactionEncoder().encode(signed)
    ),
    signature: first ? getBase58Decoder().decode(first) : undefined,
    takerSignature: getBase58Decoder().decode(own),
  };
}

/**
 * When the answer is lost and the page never had the transaction ID (a
 * gasless order), look for the swap on-chain by the wallet's own signature.
 */
async function unconfirmedOutcome(
  current: Sent,
  rpc: LookupRpc
): Promise<SwapOutcome> {
  if (current.signature) {
    return { kind: "unconfirmed", signature: current.signature };
  }
  const found = await findLanded(
    rpc,
    current.taker,
    current.takerSignature,
    current.sentAt,
    current.lastValidBlockHeight
  );
  if (found.kind === "landed") {
    if (found.succeeded === undefined) {
      return { kind: "unconfirmed", signature: found.signature };
    }
    return found.succeeded
      ? { kind: "landed", signature: found.signature }
      : {
          kind: "failed",
          message:
            "The transaction reached the chain but failed there, so nothing was swapped.",
          signature: found.signature,
        };
  }
  if (found.kind === "notLanded") return { kind: "notLanded" };
  return { kind: "unconfirmed" };
}

/**
 * The swap, one step at a time: fresh order, wallet signature, Jupiter's
 * managed execution. It always ends in a named outcome.
 */
export function useSwap(rpc: LookupRpc, retryDelayMs = 1500) {
  const [phase, setPhase] = useState<SwapPhase>({ step: "idle" });
  const sent = useRef<Sent | null>(null);

  const submit = useCallback(
    async (attempts: number, firstTry: boolean) => {
      const current = sent.current;
      if (!current) return;
      setPhase({ step: "sending" });
      let mayHaveLanded = !firstTry;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const result = await postExecute(current.payload);
          // -1 means Jupiter no longer holds the order. After an earlier
          // attempt whose answer was lost, that says nothing about whether
          // the swap landed, so it must not be reported as "expired".
          if (mayHaveLanded && result.code === -1) break;
          setPhase({ step: "done", outcome: classifyExecute(result) });
          return;
        } catch (error) {
          if (!(error instanceof JupiterApiError) || !error.outcomeUnknown) {
            setPhase(
              failed(
                error instanceof Error
                  ? error.message
                  : "The swap was not sent."
              )
            );
            return;
          }
          mayHaveLanded = true;
          if (attempt < attempts) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      }
      const outcome = await unconfirmedOutcome(current, rpc);
      if (sent.current === current) setPhase({ step: "done", outcome });
    },
    [retryDelayMs, rpc]
  );

  const start = useCallback(
    async ({ request, signer, inputSymbol }: StartArgs) => {
      sent.current = null;
      setPhase({ step: "preparing" });
      let order;
      try {
        order = await fetchOrder(request);
      } catch (error) {
        setPhase(
          failed(
            error instanceof Error
              ? error.message
              : "Could not prepare the swap."
          )
        );
        return;
      }
      if (!order.transaction) {
        setPhase(failed(orderBlocker(order, inputSymbol)));
        return;
      }

      setPhase({ step: "signing" });
      let signed: Signed;
      try {
        signed = await signOrder(order.transaction, signer, request.taker);
      } catch (error) {
        setPhase(
          isUserRejection(error)
            ? { step: "done", outcome: { kind: "rejected" } }
            : failed(
                error instanceof Error
                  ? `Your wallet could not sign the swap: ${error.message}`
                  : "Your wallet could not sign the swap."
              )
        );
        return;
      }

      // A market-maker quote carries its own deadline. Past it, do not send.
      if (order.expireAt) {
        const raw = Number(order.expireAt);
        const deadline = raw < 1e12 ? raw * 1000 : raw;
        if (Number.isFinite(deadline) && Date.now() > deadline) {
          setPhase({ step: "done", outcome: { kind: "expired" } });
          return;
        }
      }

      sent.current = {
        payload: {
          signedTransaction: signed.transaction,
          requestId: order.requestId,
        },
        signature: signed.signature,
        taker: request.taker as Address,
        takerSignature: signed.takerSignature,
        sentAt: Math.floor(Date.now() / 1000),
        lastValidBlockHeight: /^\d+$/.test(order.lastValidBlockHeight ?? "")
          ? BigInt(order.lastValidBlockHeight!)
          : undefined,
      };
      await submit(SEND_ATTEMPTS, true);
    },
    [submit]
  );

  /** After an unconfirmed result: ask Jupiter again about the same transaction. */
  const checkAgain = useCallback(() => submit(1, false), [submit]);

  const reset = useCallback(() => {
    sent.current = null;
    setPhase({ step: "idle" });
  }, []);

  return { phase, start, checkAgain, reset };
}
