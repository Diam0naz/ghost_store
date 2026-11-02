// AI proposer stub. Reads treasury data, asks a confidential model for proposals,
// and submits them to the treasury contract. It can only call `propose`.
//
// TODO (day 1): confirm the NEAR AI Cloud API shape and attestation endpoint in https://docs.near.ai/
// Many private-inference APIs are OpenAI-compatible, but verify before relying on that.

type Proposal =
  | { Payout: { to: string; token: string | null; amount: string } }
  | { Allocate: { venue: string; token: string; amount: string } };

interface Draft {
  kind: Proposal;
  rationale: string;
}

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};

async function draftProposals(): Promise<Draft[]> {
  const baseUrl = env("NEAR_AI_BASE_URL");
  const apiKey = env("NEAR_AI_API_KEY");
  const model = env("NEAR_AI_MODEL");

  // TODO: load real inputs (sales, vendor bills, balances) from the treasury and checkout store.
  const context = { note: "replace with real merchant data" };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You draft treasury proposals as JSON: an array of {kind, rationale}. " +
            "kind is {Payout:{to,token,amount}} or {Allocate:{venue,token,amount}}. " +
            "Never include sensitive details in rationale. Output JSON only.",
        },
        { role: "user", content: JSON.stringify(context) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI request failed: ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content) as Draft[];
}

async function submit(drafts: Draft[]) {
  // TODO: call treasury.propose({kind, rationale}) with near-api-js using PROPOSER_* env vars.
  // Validate every draft here too; the contract enforces caps and whitelists regardless.
  for (const d of drafts) console.log("would propose:", JSON.stringify(d));
}

const drafts = await draftProposals();
await submit(drafts);
