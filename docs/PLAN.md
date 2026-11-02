# Two-week plan (Nov 1 to 14, 2026, deadline 23:59 UTC Nov 14)

| Days | Goal |
|---|---|
| 1-2 | Verify integrations: Intents quote and `dry: true`, NEAR AI Cloud key and TEE attestation, yield venue interface (check Rhea). Cut anything unreachable. |
| 3-5 | Treasury contract: proposals, approvals, limits, tests, testnet deploy. (Scaffolded in contracts/treasury.) |
| 6-7 | Checkout plus Intents settlement into the treasury (mainnet, tiny amounts). |
| 8-9 | AI proposals: payout batch and one yield allocation, wired to approvals. |
| 10-11 | Yield routing and flow view. |
| 12 | Feature freeze. README, "do X, see Y" steps, TEE protections section. |
| 13 | Record demo, draft X post, make repo public. |
| 14 | Buffer, then submit. |

Cut order if late: public flow page, yield routing, multi-chain breadth. Never cut checkout, approvals or AI proposals.

## Day 1 checklist

- [ ] NEAR AI Cloud API key (claim $10 at https://nearbuilders.org/join)
- [ ] Create mainnet payout account yourself (never generated for you)
- [ ] Read Intents docs, confirm quote endpoint and dry-run behavior
- [ ] Confirm whether Trezu or Sputnik DAO can replace the custom multisig
- [ ] Confirm the yield venue's deposit call
