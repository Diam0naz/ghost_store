# Merchant onboarding: the factory

`contracts/factory` lets any merchant create their own treasury in one transaction from
`/onboard`. Status: code and 15 unit tests in this repo; **not deployed yet**.

## How it works

1. **Create.** `create_treasury(name, signers, threshold, display_name)` with at least 0.5 NEAR
   attached creates `<name>.<factory>`, funds it with the deposit (minus a 0.01 NEAR directory
   fee), points it at the treasury code and calls the treasury's `new(signers, threshold,
   proposer)`. The caller must be a signer; the hosted agent's account is the proposer and can
   never be a signer. If the batch fails, the name is freed and the deposit refunded.
2. **Configure.** The wizard sends one transaction to the new treasury that proposes and approves
   `SetPolicy`, `SetModelSigner` (copied from the demo treasury, where signers registered it after
   checking its TDX attestation), `SetVendor` for each regular vendor and `SetAutonomy` (a preset).
   With threshold 1 it takes effect at once; otherwise co-signers approve on the Treasury page.
3. **Use.** The app shows the selected shop (`?shop=<treasury>`, remembered per browser). Only the
   demo treasury or `<name>.<factory>` accounts can be selected, so a crafted link cannot point a
   signer's wallet at another contract.

The treasury code is a NEAR **global contract referenced by code hash**: the 470 KB wasm is
stored once, each shop pays only for its own state, and nobody (the factory owner included) can
replace the code under an existing shop. `set_treasury_code_hash` only affects new shops.

## Deploy (testnet)

Run from the repo root, signing with your own keys (`sign-with-keychain` or
`sign-with-legacy-keychain`, whichever holds them). Check the cost the CLI shows before sending:
a global contract's storage is paid once and is priced higher than ordinary contract storage.

```sh
# 1. Build both contracts
RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp" cargo build \
  --manifest-path contracts/treasury/Cargo.toml --target wasm32-unknown-unknown --release
RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp" cargo build \
  --manifest-path contracts/factory/Cargo.toml --target wasm32-unknown-unknown --release
T=contracts/treasury/target/wasm32-unknown-unknown/release/treasury.wasm
F=contracts/factory/target/wasm32-unknown-unknown/release/factory.wasm

# 2. Publish the treasury code once, by hash (immutable)
near contract deploy-as-global use-file $T as-global-hash treasury-dev.testnet \
  network-config testnet sign-with-keychain send

# 3. The code hash the factory will reference (base58 sha256 of the wasm)
HASH=$(node -e 'const c=require("crypto"),f=require("fs");const h=c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest();const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=BigInt("0x"+h.toString("hex")),s="";while(n>0n){s=A[Number(n%58n)]+s;n/=58n}console.log(s)' $T)

# 4. Create the factory account and deploy it with its init call
near account create-account fund-myself ghoststore.testnet '3 NEAR' autogenerate-new-keypair \
  save-to-keychain sign-as treasury-dev.testnet network-config testnet sign-with-keychain send
near contract deploy ghoststore.testnet use-file $F with-init-call new \
  json-args "{\"owner\":\"treasury-dev.testnet\",\"treasury_code_hash\":\"$HASH\",\"default_proposer\":\"ai-proposer.treasury-dev.testnet\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# 5. Point the web app at it (web/.env.local and the Vercel project), then redeploy
NEXT_PUBLIC_FACTORY_CONTRACT_ID=ghoststore.testnet
```

The factory needs a small NEAR buffer of its own: when a creation fails, it refunds the creator
in its callback, possibly before the failed batch's funds have come back to it.

## Not covered yet

- **Books.** The hosted agent still reads one merchant's books file. Per-shop books need a design
  that keeps them private (encrypted in the browser, decrypted only inside private inference).
- **The agent per shop.** `propose`, `execute-auto` and `keeper` take one `TREASURY_CONTRACT_ID`;
  serving many shops means iterating `list_shops` with each shop's books.
- **Checkout per shop.** Checkout pays the configured merchant; per-shop payout accounts come with
  the mainnet treasury.
- **Attestation API.** `/api/attestation/[id]` reads the default treasury only.
- **Discovery.** `shops_signed_by` scans the directory; fine for thousands of shops, an indexer
  beyond that.
