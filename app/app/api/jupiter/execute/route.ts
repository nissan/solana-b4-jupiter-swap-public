import {
  forwardToJupiter,
  json,
  validateExecuteBody,
} from "../../../lib/jupiter-server";

export const dynamic = "force-dynamic";

// POST /api/jupiter/execute: hands a wallet-signed order to Jupiter, which
// lands it and reports the result. This server never signs anything.
export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "The request body is not JSON." }, 400);
  }
  const body = validateExecuteBody(payload);
  if (!body.ok) return json({ error: body.error }, 400);
  return forwardToJupiter(
    "/execute",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.value),
    },
    // Jupiter waits for the transaction to confirm before it answers.
    60_000
  );
}
