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

/** How many of the wallet's transactions one page of the search lists. */
const PAGE = 20;
/** The most pages one search reads, so a busy wallet cannot flood the RPC. */
const MAX_PAGES = 5;
/** Seconds of margin between this clock and the chain's. */
const CLOCK_MARGIN = 60;

/**
 * Finds a swap whose transaction ID the page never had. On a gasless order
 * the fee payer signs inside Jupiter's /execute, so the ID (the fee payer's
 * signature) is unknown here, but the wallet's own signature is in the
 * transaction. Search the wallet's transactions for it, newest first, paging
 * back until one is older than the send (`sentAt`, Unix seconds).
 *
 * Not found is only final when the search was complete and the chain is past
 * the order's last valid block height: after that it can no longer land.
 * "Complete" means every transaction since the send read cleanly and the
 * search reached back past the send within `MAX_PAGES`.
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
    const cutoff = sentAt - CLOCK_MARGIN;
    let complete = true;
    let reachesBack = false;
    let before: Signature | undefined;
    for (let page = 0; page < MAX_PAGES && !reachesBack; page++) {
      const entries = await rpc
        .getSignaturesForAddress(taker, {
          limit: PAGE,
          commitment: "confirmed",
          ...(before ? { before } : {}),
        })
        .send();
      for (const entry of entries) {
        // Older than the send: it cannot be this swap, and nothing older can.
        if (entry.blockTime != null && Number(entry.blockTime) < cutoff) {
          reachesBack = true;
          break;
        }
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
      // A short page is the end of the wallet's history.
      if (entries.length < PAGE) reachesBack = true;
      before = entries.at(-1)?.signature as Signature | undefined;
    }
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
