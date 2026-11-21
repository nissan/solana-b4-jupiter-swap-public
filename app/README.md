# app

The Jupiter swap page: Next.js, `@solana/kit`, the Kit wallet plugin (Wallet Standard), `@solana/react` and Vercel UI SDK components. Setup, pinned versions, the flow diagram and known limitations are in the [repository README](../README.md).

## Where things are

| Path                                            | What it does                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `app/components/swap/swap-card.tsx`             | The page's one card: pair, amount, slippage, live quote, and the outcome of a swap |
| `app/lib/hooks/use-quote.ts`                    | Fetches a quote, refreshes it on a timer and marks it stale                        |
| `app/lib/hooks/use-swap.ts`                     | Fresh order, wallet signature, execute, and the retry when an answer is lost       |
| `app/lib/jupiter.ts`                            | Types for Jupiter's responses and the mapping from its codes to named outcomes     |
| `app/lib/jupiter-server.ts`, `app/api/jupiter/` | Server routes that validate requests and call Jupiter with `JUPITER_API_KEY`       |
| `app/lib/tokens.ts`, `app/lib/amount.ts`        | The token list, and exact conversion between typed amounts and smallest units      |

## Tests

`pnpm test` needs no API key, network or funds.

- `tests/swap.test.tsx` drives the card through each scenario with a mock Wallet Standard wallet (`tests/mock-wallet.ts`) and stubbed routes.
- `tests/jupiter-routes.test.ts` calls the two route handlers with Jupiter stubbed, including every request they must refuse.
- `tests/amount.test.ts` covers amount parsing and formatting.
- `tests/app.test.tsx` connects the mock wallet through the real wallet button against an offline in-process [Surfpool](https://www.npmjs.com/package/@solana/surfpool) runtime (Linux x64 and macOS).

`tests/fixtures/order-*.json` are real `/order` responses captured on 21 November 2026. No real `/execute` response exists yet: those in the tests are written from Jupiter's documentation.
