import { SwapCard } from "./components/swap/swap-card";

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-3xl font-black tracking-tight">Jupiter swap</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
        Get a live price from Jupiter, sign once in your wallet, and see exactly
        what happened: completed, rejected, expired or failed.
      </p>
      <SwapCard />
    </main>
  );
}
