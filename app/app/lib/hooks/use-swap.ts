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
};

type Sent = { payload: ExecuteRequest; signature?: string };

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
  if (!signed.signatures[taker as Address]) {
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
  };
}

/**
 * The swap, one step at a time: fresh order, wallet signature, Jupiter's
 * managed execution. It always ends in a named outcome.
 */
export function useSwap(retryDelayMs = 1500) {
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
      setPhase({
        step: "done",
        outcome: { kind: "unconfirmed", signature: current.signature },
      });
    },
    [retryDelayMs]
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
