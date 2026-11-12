# Demo video: shot list

Target length: about 2.5 minutes. Record each scene as its own short clip; they get joined,
captioned and sped up where needed afterwards, so mistakes are cheap: just re-record that scene.

## Recording

- GNOME: press **Print Screen**, switch the toggle to **video** (camera icon → video icon), pick
  **Screen** or **Window**, press the record button. Stop with the red dot in the top bar.
  Clips land in `~/Videos/Screencasts/`.
- Browser at 100% zoom, window maximised, bookmarks bar hidden. Close MetaMask/HOT popups
  unless the scene needs them.
- Terminal: large font (Ctrl + `+` two or three times), dark theme, `clear` before each scene.
- No narration needed: captions are added in editing. Pause 2 seconds at the start and end of
  each clip.

Name the files `01.webm`, `02.webm`, ... in scene order (or just tell Claude which is which).

## Scenes

| # | Where | What to do | Caption (added in editing) |
|---|---|---|---|
| 01 | Browser: `localhost:3000` | Slowly scroll the landing page top to bottom. | An AI treasurer for merchants. The AI reads the books privately in a TEE. The contract decides what it may do. |
| 02 | Terminal, in `agent/` | `node scripts/testnet-v2-setup.mjs demo-invoice` | A vendor's agent bills the merchant on chain: invoice PKG-2310, 35 USDT, minted as an NFT. |
| 03 | Terminal, in `agent/` | `npm run propose` and let it finish. | The agent checks the model's Intel TDX attestation, reconciles bills against on-chain invoices, and asks Qwen3.6 running inside NEAR AI's TEE. |
| 04 | Same output, held on screen | Keep the last lines visible ~5 s ("Created proposals #11", "autonomy lane, executable after …"). | The contract verified the TEE signature on chain and created the payment from the signed output. Allowlisted vendor, under the caps: autonomy lane. |
| 05 | Browser: `/treasury` | Open the new proposal. Show the countdown and the **Veto** button. Open the on-chain proof drawer. | No signer approval needed, but any signer can veto for 5 minutes. The proof shows model, request hash and recovered TEE key. |
| 06 | Browser: `/treasury` after the 5 min window | Click **Execute payout** (or run `npm run execute-auto`). Show it turn **Executed** and the invoice **Paid**. | After the veto window anyone can execute. Caps, daily limit and reserve floor are checked again at payout. |
| 07 | Browser: `/treasury`, filter "All" | Scroll past #9 (Rejected) and #10 (Executed, 2 approvals). | A new supplier is never autonomous: its invoice needed 2-of-2 signers. An early raw payout that could double-pay was rejected. |
| 08 | Browser: `/invoices` | Show the invoice list (NFTs), open one, show "List for sale" / factoring fee. | Invoices are NEP-171 NFTs. Vendors can sell them for early cash; the treasury pays whoever holds the invoice. |
| 09 | Browser: `/checkout/demo` | Show the quote for USDC on BNB Chain (needs the Intents service up). | Customers pay with any token on any chain. NEAR Intents settles USDC to the merchant. |
| 10 | Browser: nearblocks link from the README's "Proven on mainnet" table, then bscscan | Show both transactions. | A real mainnet payment: 1.2 USDC on BNB Chain → 1.199876 USDC for diamonaz.near, about 30 seconds. |
| 11 | Browser: `/checkout/demo?preview=celebration` | Let the confetti play. | (labelled preview of the success screen) |
| 12 | — | Title card generated in editing. | Trust lives in the contract, not the UI. Ghost Store, NEAR HACKATHON 2026. |

## Before recording

1. Dev server running in `web/` (`npm run dev`).
2. Scene 02 must run **before** scene 03, and only once (`demo-invoice` refuses to make a second
   PKG-2310).
3. Scenes 05 and 06 are 5 minutes apart: record 05, wait, record 06.
4. Today's autonomy budget: 100 USDT; PKG-2310 uses 35 of it.
