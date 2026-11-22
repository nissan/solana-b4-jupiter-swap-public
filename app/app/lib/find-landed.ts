import type {
  Address,
  GetBlockHeightApi,
  GetSignaturesForAddressApi,
  GetTransactionApi,
  Rpc,
  Signature,
} from "@solana/kit";

export type LookupRpc = Rpc<
  GetSignaturesForAddressApi & GetTransactionApi & GetBlockHeightApi
>;

export type Lookup =
  /** `succeeded` is undefined when the RPC did not say how it ended. */
  | { kind: "landed"; signature: string; succeeded?: boolean }
  | { kind: "notLanded" }
  | { kind: "unknown" };

/** How many of the wallet's newest transactions are searched. */
const RECENT = 20;

/**
 * Finds a swap whose transaction ID the page never had. On a gasless order
 * the fee payer signs inside Jupiter's /execute, so the ID (the fee payer's
 * signature) is unknown here, but the wallet's own signature is in the
 * transaction. Search the wallet's newest transactions for it.
 *
 * Not found is only final when the search was complete and the chain is past
 * the order's last valid block height: after that it can no longer land.
 * "Complete" means every transaction read cleanly and the oldest one searched
 * is from before the swap was sent (`sentAt`, Unix seconds).
 */
export async function findLanded(
  rpc: LookupRpc,
  taker: Address,
  takerSignature: string,
  sentAt: number,
  lastValidBlockHeight?: bigint
): Promise<Lookup> {
  try {
    // Read the height first: a transaction that lands after this read is
    // still found by the search below, so "past the height" stays true.
    const height =
      lastValidBlockHeight === undefined
        ? undefined
        : await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    const recent = await rpc
      .getSignaturesForAddress(taker, {
        limit: RECENT,
        commitment: "confirmed",
      })
      .send();
    let complete = true;
    for (const entry of recent) {
      const transaction = await rpc
        .getTransaction(entry.signature as Signature, {
          commitment: "confirmed",
          encoding: "json",
          // A gasless order is never a version 1 transaction (Jupiter's spec).
          maxSupportedTransactionVersion: 0,
        })
        .send()
        .catch(() => null);
      if (!transaction) {
        complete = false;
        continue;
      }
      if (
        transaction.transaction.signatures.includes(takerSignature as never)
      ) {
        return {
          kind: "landed",
          signature: entry.signature,
          succeeded: transaction.meta
            ? transaction.meta.err === null
            : undefined,
        };
      }
    }
    const oldest = recent.at(-1);
    // A minute of margin for the difference between this clock and the chain's.
    const reachesBack =
      recent.length < RECENT ||
      (oldest?.blockTime != null && Number(oldest.blockTime) < sentAt - 60);
    if (
      complete &&
      reachesBack &&
      height !== undefined &&
      lastValidBlockHeight !== undefined &&
      height > lastValidBlockHeight
    ) {
      return { kind: "notLanded" };
    }
    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}
