import {
  forwardToJupiter,
  json,
  validateOrderQuery,
} from "../../../lib/jupiter-server";

export const dynamic = "force-dynamic";

// GET /api/jupiter/order: a quote, and with `taker` a transaction to sign.
export async function GET(request: Request): Promise<Response> {
  const query = validateOrderQuery(new URL(request.url).searchParams);
  if (!query.ok) return json({ error: query.error }, 400);
  return forwardToJupiter(`/order?${query.value}`, { method: "GET" }, 10_000);
}
