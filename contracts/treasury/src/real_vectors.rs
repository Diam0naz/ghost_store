// A real NEAR AI Cloud completion and its TEE response signature, captured on 2026-11-10 with
// `SAVE_EVIDENCE=... DRY_RUN=true npm run propose` (agent/). The signer's Intel TDX quote was
// checked with `npm run register-model`. The request (with the example books) is not included;
// only its hash, which is what the TEE signed.

pub const MODEL: &str = "Qwen/Qwen3.6-35B-A3B-FP8";
pub const SIGNER: &str = "0xfdbd7952498b333206f360d71d97a1e0961e8ddf";
pub const REQUEST_HASH: &str = "637f4dd3e793f93d01df14541a908a10980dc2ed9e8cb90937013c522d8e6471";
pub const SIGNATURE: &str = "0xfb3e463e7f5b5267f1524488ff78c0bb87b0f6ce588cad33409b179ba5d4c7c41170acb8fb51f5951849490098b9033a505ddbd9129a9fa1afafcf9820724b631c";
pub const CREATED_S: u64 = 1794345479;
pub const RESPONSE: &str = r##"{"id":"0a046331f5d04941a23539b22a606d49","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"[\n  {\"kind\": {\"Payout\": {\"to\": \"packaging.treasury-dev.testnet\", \"token\": \"usdt.fakes.testnet\", \"amount\": \"40000000\"}}, \"rationale\": \"Bill PKG-2291 due 2026-11-12, within 14-day window. Amount matches invoice.\"},\n  {\"kind\": {\"Payout\": {\"to\": \"courier.treasury-dev.testnet\", \"token\": \"usdt.fakes.testnet\", \"amount\": \"25000000\"}}, \"rationale\": \"Bill CR-7781 due 2026-11-15, within 14-day window. Amount matches invoice.\"},\n  {\"kind\": {\"Allocate\": {\"venue\": \"vault.treasury-dev.testnet\", \"token\": \"usdt.fakes.testnet\", \"amount\": \"100000000\"}}, \"rationale\": \"Allocate idle cash. Remaining liquid balance after payouts is 335M, well above reserve floor (100M) plus 30 days payroll (2.1M).\"}\n]"},"finish_reason":"stop","logprobs":null,"matched_stop":248046}],"model":"Qwen/Qwen3.6-35B-A3B-FP8","created":1794345479,"usage":{"prompt_tokens":847,"total_tokens":1110,"completion_tokens":263,"prompt_tokens_details":null,"reasoning_tokens":0,"completion_tokens_details":{"reasoning_tokens":0}}}"##;
