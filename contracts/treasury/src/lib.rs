//! Merchant treasury: M-of-N signer approvals over proposals, with a policy-limited yield layer.
//!
//! Design rules (these are the security story, keep them in the contract, not in the AI):
//! - A restricted `proposer` (the AI service account) may only CREATE proposals.
//! - Only `signers` may approve or reject. The proposer can never approve or execute.
//! - Execution needs `threshold` approvals from CURRENT signers and happens at most once.
//! - Every transfer fires a callback; on failure the proposal is marked Failed, not Executed.
//! - Governance changes (signers, threshold, proposer, venue caps, policy) go through the same
//!   approval flow as payouts. No single-signer backdoor.
//! - Proposals not fully approved within PROPOSAL_TTL_MS expire.
//!
//! Yield layer (stablecoin only):
//! - `policy.stable_token` is the only token that can be allocated.
//! - Venue caps are CUMULATIVE: the principal supplied to a venue never exceeds its cap.
//! - `policy.max_total_allocated` caps principal across all venues.
//! - `policy.reserve_floor` is enforced against the live token balance at execution time
//!   (async `ft_balance_of` check), so an allocation can never drain the liquid reserve.
//! - Any single signer can `pause()` (a safe-direction action). Pausing stops allocations and the
//!   autonomy lane. Unpausing needs a proposal. Signer-approved payouts and withdrawals keep
//!   working while paused.
//! - `positions` records PRINCIPAL supplied per venue, not current value. Read the venue for value.
//! - Stablecoin outflows that have passed their balance check but not settled are tracked in
//!   `outflow_in_flight` and subtracted in later checks, so two allocations (or autonomous
//!   payouts) racing each other cannot both pass the reserve-floor check against one snapshot.
//!   Signer-approved payouts are not counted: signers approve those amounts explicitly.
//!
//! Attested AI proposals (`propose_attested`):
//! - The proposer submits the raw NEAR AI Cloud completion bytes, the request hash and the
//!   TEE's ECDSA response signature. The contract recomputes `sha256(response)`, rebuilds the
//!   signed text `"{model}:{request_hash}:{response_hash}"`, recovers the EIP-191 signer with
//!   `ecrecover` and requires it to be a model key registered by governance (`SetModelSigner`).
//! - The proposals are parsed from the signed model output itself, so the agent cannot alter an
//!   amount, recipient or rationale after inference. Each signed response can be used once and
//!   must be fresh (`MAX_RESPONSE_AGE_S`).
//! - The request (the merchant's private books) is never revealed on chain; only its hash is.
//!   A valid signature proves WHICH model wrote the output, not that the prompt was benign, so
//!   attested proposals get no extra power except the bounded autonomy lane below.
//!
//! Autonomy lane (`SetAutonomy`, `SetVendor`):
//! - An attested stablecoin payout to an allowlisted vendor, within `max_per_payout` and the
//!   UTC-day `daily_cap`, can be executed by anyone after `veto_window_ms` without approvals.
//! - Any single signer can veto it during the window with `reject` (one veto is enough).
//! - The reserve floor is checked against the live balance before an autonomous payout is sent.
//! - Everything else (new recipients, larger amounts, allocations, governance) needs M-of-N.
//! - With `invoices_only`, raw `Payout`s never enter the lane: only `PayInvoice` does.
//!
//! Invoices (`submit_invoice`, `PayInvoice`):
//! - Anyone (a vendor or its agent) can submit an invoice, with a small NEAR deposit for storage.
//! - `PayInvoice { invoice_id }` pays the invoice's CURRENT HOLDER the invoiced amount. The AI
//!   names an invoice, never a payee. An invoice can back one pending proposal at a time.
//! - In the autonomy lane, the invoice's ISSUER must be on the vendor allowlist.
//!
//! Invoice NFTs and factoring (NEP-171 core + NEP-177 metadata):
//! - Every invoice is an NFT owned by its holder (`token_id` = invoice id).
//! - A holder can `nft_transfer` it, or list it with `set_invoice_price`; a buyer pays with
//!   `ft_transfer_call` on the invoice token (msg `{"buy_invoice":<id>}`) and the sale settles
//!   atomically: the NFT moves, the seller gets the price minus the governance-set fee.
//! - When the treasury pays the invoice, the money goes to whoever holds it at that moment.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet, LookupSet};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

// ---- constants ---------------------------------------------------------------

/// Gas for a plain ft_transfer.
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(20);
/// Gas for ft_transfer_call. Standard FT contracts require more than ~35 Tgas to be attached.
const FT_TRANSFER_CALL_GAS: Gas = Gas::from_tgas(60);
/// Gas for ft_balance_of.
const FT_BALANCE_GAS: Gas = Gas::from_tgas(5);
/// Gas for a venue `withdraw` call.
const WITHDRAW_GAS: Gas = Gas::from_tgas(40);
/// Gas reserved for simple callbacks.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Gas for the balance-check callback, which itself schedules ft_transfer_call + a callback.
const ALLOCATE_CHECK_CALLBACK_GAS: Gas = Gas::from_tgas(90);
/// 1 yoctoNEAR attached to NEP-141 transfers.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// NEAR kept free on top of storage staking when paying out native NEAR (0.5 NEAR).
const STORAGE_RESERVE: NearToken = NearToken::from_millinear(500);
/// Proposals older than this are considered expired (7 days in ms).
const PROPOSAL_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
/// Length of one autonomy budget bucket (a UTC day).
const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
/// Shortest veto window governance may configure (1 minute).
const MIN_VETO_WINDOW_MS: u64 = 60 * 1_000;
/// A signed completion older than this (by its `created` field) is refused.
const MAX_RESPONSE_AGE_S: u64 = 60 * 60;
/// Tolerated clock skew for a completion `created` in the future.
const MAX_RESPONSE_SKEW_S: u64 = 5 * 60;
/// Upper bound on the raw completion size accepted by `propose_attested`.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// Upper bound on drafts accepted from one completion.
const MAX_DRAFTS_PER_RESPONSE: usize = 5;
/// Gas for the callback after an autonomous payout's balance check (it schedules ft_transfer).
const AUTO_PAYOUT_CHECK_CALLBACK_GAS: Gas = Gas::from_tgas(50);
/// NEAR attached to `submit_invoice`, covering the invoice's storage (and deterring spam).
const INVOICE_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Longest invoice reference (e.g. an invoice number).
const MAX_INVOICE_REFERENCE: usize = 64;
/// Highest factoring fee governance may set (10%).
const MAX_FACTORING_FEE_BPS: u16 = 1_000;

// ---- types -------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub struct Policy {
    /// The only token the yield layer may touch (the treasury's stablecoin).
    pub stable_token: AccountId,
    /// Maximum total principal allocated across all venues, in `stable_token` units.
    pub max_total_allocated: U128,
    /// Liquid `stable_token` balance that must remain after an allocation.
    pub reserve_floor: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum ProposalKind {
    /// Pay a vendor or contributor. `token = None` means native NEAR.
    Payout {
        to: AccountId,
        token: Option<AccountId>,
        amount: U128,
    },
    /// Supply idle stablecoin to a whitelisted yield venue via ft_transfer_call.
    Allocate {
        venue: AccountId,
        token: AccountId,
        amount: U128,
    },
    /// Pull funds back from a venue by calling its `withdraw(token_id, amount)`.
    Withdraw { venue: AccountId, amount: U128 },
    /// Governance: set the cumulative principal cap for a venue (0 removes it from the whitelist).
    SetVenueCap { venue: AccountId, cap: U128 },
    /// Governance: set the yield policy (stable token, total cap, reserve floor).
    SetPolicy {
        stable_token: AccountId,
        max_total_allocated: U128,
        reserve_floor: U128,
    },
    /// Governance: pause or unpause allocations.
    SetPaused { paused: bool },
    /// Governance: add a new signer.
    AddSigner { account_id: AccountId },
    /// Governance: remove an existing signer.
    RemoveSigner { account_id: AccountId },
    /// Governance: change the approval threshold.
    SetThreshold { threshold: u32 },
    /// Governance: rotate the AI proposer account.
    SetProposer { account_id: AccountId },
    /// Governance: add (`enabled = true`) or remove a vendor from the autonomy allowlist.
    SetVendor { account_id: AccountId, enabled: bool },
    /// Governance: configure the autonomy lane, or turn it off with `None`.
    SetAutonomy { policy: Option<AutonomyPolicy> },
    /// Governance: register a TEE model signing address (0x-prefixed, 20-byte hex) for `model`,
    /// after checking its attestation report. An empty `model` removes the address.
    SetModelSigner { address: String, model: String },
    /// Pay an open invoice: its current holder receives `amount` of its `token`.
    PayInvoice { invoice_id: u64 },
    /// Governance: fee on invoice sales (basis points, max 1000) and who receives it.
    SetFactoringFee { fee_bps: u16, recipient: Option<AccountId> },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum InvoiceStatus {
    Open,
    Paid,
    Cancelled,
}

/// A vendor invoice. Also an NFT: `holder` owns it and is who gets paid.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub struct Invoice {
    pub id: u64,
    /// Who submitted it. Must be on the vendor allowlist for autonomous payment.
    pub issuer: AccountId,
    /// Current NFT owner; receives the payment.
    pub holder: AccountId,
    /// NEP-141 token the invoice is payable in.
    pub token: AccountId,
    pub amount: U128,
    /// Due date (ms since epoch). Informational; the AI and signers decide when to pay.
    pub due_ms: u64,
    /// Invoice number or other reference, at most 64 bytes.
    pub reference: String,
    /// Optional sha256 hex of the full invoice document kept off chain.
    pub document_hash: Option<String>,
    pub status: InvoiceStatus,
    pub created_at_ms: u64,
    /// The pending proposal that would pay it, if any (one at a time).
    pub pending_proposal: Option<u64>,
    pub paid_by_proposal: Option<u64>,
    /// Asking price while listed for sale, in `token`.
    pub sale_price: Option<U128>,
}

/// NEP-171 token view of an invoice.
#[near(serializers = [json])]
pub struct JsonToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
}

/// NEP-177 token metadata (unused optional fields omitted as null).
#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub issued_at: Option<String>,
    pub extra: Option<String>,
}

/// NEP-177 contract metadata.
#[near(serializers = [json])]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// Limits on what attested AI payouts may do without signer approval.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub struct AutonomyPolicy {
    /// The only token autonomous payouts may send.
    pub token: AccountId,
    /// Largest single autonomous payout.
    pub max_per_payout: U128,
    /// Largest total of autonomous payouts per UTC day (executed plus waiting in a veto window).
    pub daily_cap: U128,
    /// How long signers have to veto before anyone may execute.
    pub veto_window_ms: u64,
    /// When true, only `PayInvoice` proposals can enter the lane, never raw `Payout`s.
    pub invoices_only: bool,
}

/// What the contract verified about an attested AI proposal.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub struct AiAttestation {
    pub model: String,
    /// Recovered TEE signing address, lowercase 0x hex.
    pub signer: String,
    /// sha256 of the private request body (hex). The body itself never goes on chain.
    pub request_hash: String,
    /// sha256 of the completion bytes (hex), recomputed by the contract.
    pub response_hash: String,
    /// The completion's `created` timestamp (seconds).
    pub created_s: u64,
}

/// Autonomy budget usage for the current UTC day.
#[near(serializers = [json])]
pub struct AutonomyStatus {
    pub policy: Option<AutonomyPolicy>,
    pub day: u64,
    /// Autonomous payouts executed today.
    pub spent: U128,
    /// Autonomous payouts waiting in a veto window.
    pub committed: U128,
    /// What is left of today's cap.
    pub remaining: U128,
}

/// The parts of a non-streaming chat.completion the contract reads. Other fields are ignored.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Completion {
    model: String,
    created: u64,
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChoiceMessage {
    content: Option<String>,
}

/// One draft inside the signed model output.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct Draft {
    kind: ProposalKind,
    rationale: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    Pending,
    /// The threshold was reached and execution was started. For async kinds a later callback
    /// may flip this to Failed.
    Executed,
    /// The threshold was reached but the on-chain call failed or was refused.
    Failed,
    Rejected,
    /// The proposal was not approved within PROPOSAL_TTL_MS.
    Expired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub kind: ProposalKind,
    pub proposer: AccountId,
    /// Free text from the AI or a human explaining why. Keep it free of sensitive data.
    pub rationale: String,
    pub approvals: Vec<AccountId>,
    pub status: Status,
    pub created_at_ms: u64,
    /// Set when the proposal came from `propose_attested` and the TEE signature checked out.
    pub attestation: Option<AiAttestation>,
    /// Set when the proposal is in the autonomy lane: anyone may execute it after this time
    /// unless a signer rejects it first.
    pub auto_execute_after_ms: Option<u64>,
}

// ---- contract state ----------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    signers: Vec<AccountId>,
    threshold: u32,
    proposer: AccountId,
    /// venue -> max cumulative principal that may be supplied to it
    venue_caps: IterableMap<AccountId, U128>,
    proposals: IterableMap<u64, Proposal>,
    next_id: u64,
    policy: Option<Policy>,
    paused: bool,
    /// venue -> principal currently supplied (not including interest)
    positions: IterableMap<AccountId, U128>,
    total_allocated: u128,
    /// Stablecoin sent or about to be sent but not yet settled (allocations + autonomous payouts).
    outflow_in_flight: u128,
    /// Vendors autonomous payouts may go to.
    vendors: IterableSet<AccountId>,
    /// TEE signing address (lowercase 0x hex) -> model it is registered for.
    model_signers: IterableMap<String, String>,
    /// Response hashes already turned into proposals (replay protection).
    used_responses: LookupSet<String>,
    autonomy: Option<AutonomyPolicy>,
    /// UTC day index of the autonomy bucket below.
    autonomy_day: u64,
    /// Autonomous payouts executed in `autonomy_day`.
    autonomy_spent: u128,
    /// Autonomous payouts waiting in a veto window.
    autonomy_committed: u128,
    invoices: IterableMap<u64, Invoice>,
    next_invoice_id: u64,
    factoring_fee_bps: u16,
    fee_recipient: Option<AccountId>,
    /// "account|token" -> amount owed after a failed sale payout; withdraw with `claim`.
    claims: IterableMap<String, U128>,
}

/// Proposals moved from prefix b"p" to b"q" when the Proposal struct gained fields (v2).
const PROPOSALS_PREFIX: &[u8] = b"q";

// ---- v1 state, for `migrate` ---------------------------------------------------

#[near(serializers = [borsh])]
pub struct ProposalV1 {
    pub id: u64,
    pub kind: ProposalKind,
    pub proposer: AccountId,
    pub rationale: String,
    pub approvals: Vec<AccountId>,
    pub status: Status,
    pub created_at_ms: u64,
}

#[near(serializers = [borsh])]
pub struct TreasuryV1 {
    signers: Vec<AccountId>,
    threshold: u32,
    proposer: AccountId,
    venue_caps: IterableMap<AccountId, U128>,
    proposals: IterableMap<u64, ProposalV1>,
    next_id: u64,
    policy: Option<Policy>,
    paused: bool,
    positions: IterableMap<AccountId, U128>,
    total_allocated: u128,
}

// ---- implementation ----------------------------------------------------------

#[near]
impl Treasury {
    #[init]
    pub fn new(signers: Vec<AccountId>, threshold: u32, proposer: AccountId) -> Self {
        require!(!signers.is_empty(), "need at least one signer");
        require!(
            threshold >= 1 && (threshold as usize) <= signers.len(),
            "threshold must be between 1 and the number of signers"
        );
        let mut deduped: Vec<AccountId> = Vec::new();
        for s in signers {
            if !deduped.contains(&s) {
                deduped.push(s);
            }
        }
        require!(
            threshold as usize <= deduped.len(),
            "threshold exceeds unique signer count"
        );
        Self {
            signers: deduped,
            threshold,
            proposer,
            venue_caps: IterableMap::new(b"v"),
            proposals: IterableMap::new(PROPOSALS_PREFIX),
            next_id: 0,
            policy: None,
            paused: false,
            positions: IterableMap::new(b"x"),
            total_allocated: 0,
            outflow_in_flight: 0,
            vendors: IterableSet::new(b"d"),
            model_signers: IterableMap::new(b"m"),
            used_responses: LookupSet::new(b"r"),
            autonomy: None,
            autonomy_day: 0,
            autonomy_spent: 0,
            autonomy_committed: 0,
            invoices: IterableMap::new(b"i"),
            next_invoice_id: 0,
            factoring_fee_bps: 0,
            fee_recipient: None,
            claims: IterableMap::new(b"c"),
        }
    }

    /// Upgrade v1 state (deployed before attested proposals) to v2. Run once, in the same
    /// transaction as the code deploy. Proposals keep their ids, kinds and statuses.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let mut old: TreasuryV1 = env::state_read().expect("no v1 state to migrate");
        let mut proposals = IterableMap::new(PROPOSALS_PREFIX);
        for (id, p) in old.proposals.iter() {
            proposals.insert(
                *id,
                Proposal {
                    id: p.id,
                    kind: p.kind.clone(),
                    proposer: p.proposer.clone(),
                    rationale: p.rationale.clone(),
                    approvals: p.approvals.clone(),
                    status: p.status.clone(),
                    created_at_ms: p.created_at_ms,
                    attestation: None,
                    auto_execute_after_ms: None,
                },
            );
        }
        old.proposals.clear();
        old.proposals.flush();
        proposals.flush();
        Self {
            signers: old.signers,
            threshold: old.threshold,
            proposer: old.proposer,
            venue_caps: old.venue_caps,
            proposals,
            next_id: old.next_id,
            policy: old.policy,
            paused: old.paused,
            positions: old.positions,
            total_allocated: old.total_allocated,
            outflow_in_flight: 0,
            vendors: IterableSet::new(b"d"),
            model_signers: IterableMap::new(b"m"),
            used_responses: LookupSet::new(b"r"),
            autonomy: None,
            autonomy_day: 0,
            autonomy_spent: 0,
            autonomy_committed: 0,
            invoices: IterableMap::new(b"i"),
            next_invoice_id: 0,
            factoring_fee_bps: 0,
            fee_recipient: None,
            claims: IterableMap::new(b"c"),
        }
    }

    // ---- views ---------------------------------------------------------------

    pub fn get_config(&self) -> (Vec<AccountId>, u32, AccountId) {
        (self.signers.clone(), self.threshold, self.proposer.clone())
    }

    pub fn get_proposal(&self, id: u64) -> Option<Proposal> {
        self.proposals.get(&id).cloned()
    }

    pub fn list_proposals(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Proposal> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_id)
            .take(limit as usize)
            .filter_map(|i| self.proposals.get(&i).cloned())
            .collect()
    }

    pub fn get_venue_cap(&self, venue: AccountId) -> Option<U128> {
        self.venue_caps.get(&venue).copied()
    }

    pub fn get_policy(&self) -> Option<Policy> {
        self.policy.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Principal supplied per venue. This is what we put in, not what it is worth now.
    pub fn get_positions(&self) -> Vec<(AccountId, U128)> {
        self.positions.iter().map(|(k, v)| (k.clone(), *v)).collect()
    }

    pub fn get_total_allocated(&self) -> U128 {
        U128(self.total_allocated)
    }

    pub fn get_outflow_in_flight(&self) -> U128 {
        U128(self.outflow_in_flight)
    }

    pub fn list_vendors(&self) -> Vec<AccountId> {
        self.vendors.iter().cloned().collect()
    }

    /// Registered TEE signing addresses and the model each is registered for.
    pub fn list_model_signers(&self) -> Vec<(String, String)> {
        self.model_signers.iter().map(|(a, m)| (a.clone(), m.clone())).collect()
    }

    pub fn is_response_used(&self, response_hash: String) -> bool {
        self.used_responses.contains(&response_hash)
    }

    pub fn get_autonomy(&self) -> AutonomyStatus {
        let day = env::block_timestamp_ms() / DAY_MS;
        let spent = if day == self.autonomy_day { self.autonomy_spent } else { 0 };
        let cap = self.autonomy.as_ref().map(|a| a.daily_cap.0).unwrap_or(0);
        AutonomyStatus {
            policy: self.autonomy.clone(),
            day,
            spent: U128(spent),
            committed: U128(self.autonomy_committed),
            remaining: U128(cap.saturating_sub(spent).saturating_sub(self.autonomy_committed)),
        }
    }

    // ---- proposals -----------------------------------------------------------

    pub fn propose(&mut self, kind: ProposalKind, rationale: String) -> u64 {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.proposer || self.signers.contains(&caller),
            "only the proposer or a signer can propose"
        );
        require!(rationale.len() <= 500, "rationale too long");
        self.validate_kind(&kind);
        self.insert_proposal(kind, caller, rationale, None)
    }

    /// Turn a TEE-signed NEAR AI Cloud completion into proposals.
    ///
    /// - `model`: the model id exactly as it appears in the signed text.
    /// - `request_hash`: sha256 hex of the exact request body (kept private off chain).
    /// - `response`: the exact completion bytes (non-streaming chat.completion JSON).
    /// - `signature`: the 65-byte EIP-191 signature from `/v1/signature/{chat_id}` (0x hex).
    ///
    /// The completion's `choices[0].message.content` must be a JSON array of
    /// `{ "kind": ProposalKind, "rationale": string }` using only Payout, Allocate or Withdraw.
    pub fn propose_attested(
        &mut self,
        model: String,
        request_hash: String,
        response: Base64VecU8,
        signature: String,
    ) -> Vec<u64> {
        let caller = env::predecessor_account_id();
        require!(caller == self.proposer, "only the proposer can submit attested proposals");
        require!(is_lower_hex(&request_hash, 64), "request_hash must be 64 lowercase hex chars");
        let response = response.0;
        require!(response.len() <= MAX_RESPONSE_BYTES, "response too large");

        // 1. Recompute what the TEE signed and recover the signer.
        let response_hash = to_hex(&env::sha256_array(&response));
        let text = format!("{model}:{request_hash}:{response_hash}");
        let signer = recover_eip191_address(&text, &signature);
        let registered = self.model_signers.get(&signer);
        require!(
            registered == Some(&model),
            "signature is not from a model key registered for this model"
        );

        // 2. One proposal batch per signed response.
        require!(!self.used_responses.contains(&response_hash), "response already used");
        self.used_responses.insert(response_hash.clone());

        // 3. Parse the completion the TEE signed.
        let body: Completion =
            serde_json::from_slice(&response).expect("response is not a chat completion");
        require!(body.model == model, "response model does not match");
        let created_s = body.created;
        let now_s = env::block_timestamp_ms() / 1_000;
        require!(created_s <= now_s + MAX_RESPONSE_SKEW_S, "response is from the future");
        require!(now_s.saturating_sub(created_s) <= MAX_RESPONSE_AGE_S, "response is too old");
        let content = body
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .expect("response has no message content");
        // from_slice (not from_str) reuses the SliceRead deserializers already in the binary.
        let drafts: Vec<Draft> = serde_json::from_slice(content.trim().as_bytes())
            .expect("model output is not a valid draft list");
        require!(!drafts.is_empty(), "model output has no drafts");
        require!(drafts.len() <= MAX_DRAFTS_PER_RESPONSE, "too many drafts in one response");

        let attestation = AiAttestation {
            model,
            signer,
            request_hash,
            response_hash,
            created_s,
        };
        let mut ids = Vec::with_capacity(drafts.len());
        for d in drafts {
            require!(
                matches!(
                    d.kind,
                    ProposalKind::Payout { .. }
                        | ProposalKind::PayInvoice { .. }
                        | ProposalKind::Allocate { .. }
                        | ProposalKind::Withdraw { .. }
                ),
                "attested proposals may only be Payout, PayInvoice, Allocate or Withdraw"
            );
            require!(d.rationale.len() <= 500, "rationale too long");
            self.validate_kind(&d.kind);
            ids.push(self.insert_proposal(d.kind, caller.clone(), d.rationale, Some(attestation.clone())));
        }
        ids
    }

    /// Execute an autonomy-lane payout after its veto window. Anyone may call this.
    ///
    /// If the payout no longer fits the autonomy policy (policy changed, vendor removed, today's
    /// cap used up), it leaves the autonomy lane and stays Pending for normal signer approval.
    /// Attach about 100 Tgas.
    pub fn execute_auto(&mut self, id: u64) -> Option<Promise> {
        let mut p = self.proposals.get(&id).cloned().expect("no such proposal");
        require!(p.status == Status::Pending, "proposal is not pending");
        let after = p.auto_execute_after_ms.expect("proposal is not in the autonomy lane");
        let now = env::block_timestamp_ms();
        require!(now >= after, "veto window has not ended");
        require!(now < p.created_at_ms + PROPOSAL_TTL_MS, "proposal has expired");
        require!(!self.paused, "autonomy is paused");

        let terms = self
            .lane_terms(&p.kind)
            .unwrap_or_else(|| env::panic_str("autonomy lane only holds token payouts and invoices"));
        let (to, token, amount) = (terms.to.clone(), terms.token.clone(), U128(terms.amount));
        self.release_commitment(&mut p);
        self.roll_autonomy_day();
        let still_ok = self.lane_allows(&terms)
            && self.autonomy.as_ref().is_some_and(|a| {
                self.autonomy_spent + self.autonomy_committed + amount.0 <= a.daily_cap.0
            });
        if !still_ok {
            env::log_str(&format!(
                "proposal #{id} no longer fits the autonomy policy; it now needs signer approval"
            ));
            self.proposals.insert(id, p);
            return None;
        }

        self.autonomy_spent += amount.0;
        if let ProposalKind::PayInvoice { invoice_id } = p.kind {
            self.mark_invoice_paid(invoice_id, id);
        }
        p.status = Status::Executed;
        self.proposals.insert(id, p);
        env::log_str(&format!("autonomous payout #{id}: {} to {to}", amount.0));
        Some(
            Promise::new(token.clone())
                .function_call(
                    "ft_balance_of".to_string(),
                    json!({ "account_id": env::current_account_id() }).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    FT_BALANCE_GAS,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(AUTO_PAYOUT_CHECK_CALLBACK_GAS)
                        .on_auto_payout_balance(id, to, token, amount),
                ),
        )
    }

    /// Approve a proposal. Executes automatically when the threshold is reached.
    ///
    /// Attach about 150 Tgas: allocations chain a balance check, ft_transfer_call and callbacks.
    pub fn approve(&mut self, id: u64) -> Option<Promise> {
        self.assert_signer();
        let caller = env::predecessor_account_id();
        let mut p = self.proposals.get(&id).cloned().expect("no such proposal");
        require!(p.status == Status::Pending, "proposal is not pending");
        require!(
            env::block_timestamp_ms() < p.created_at_ms + PROPOSAL_TTL_MS,
            "proposal has expired"
        );
        require!(!p.approvals.contains(&caller), "already approved");
        p.approvals.push(caller);

        // Only count approvals from accounts that are still signers.
        let valid = p.approvals.iter().filter(|a| self.signers.contains(*a)).count() as u32;

        let promise = if valid >= self.threshold {
            // State may have changed since the proposal was created: validate again.
            self.validate_kind(&p.kind);
            // Signers took over: the autonomy lane's budget hold is no longer needed.
            self.release_commitment(&mut p);
            let promise = self.execute(&p);
            // Async kinds are optimistic; their callback flips this to Failed if needed.
            p.status = Status::Executed;
            promise
        } else {
            None
        };
        self.proposals.insert(id, p);
        promise
    }

    /// Any single signer can reject a pending proposal. For an autonomy-lane payout this is the
    /// veto: one signer is enough to stop it.
    pub fn reject(&mut self, id: u64) {
        self.assert_signer();
        let mut p = self.proposals.get(&id).cloned().expect("no such proposal");
        require!(p.status == Status::Pending, "proposal is not pending");
        self.release_commitment(&mut p);
        self.unlock_invoice(&p.kind, false);
        if env::block_timestamp_ms() >= p.created_at_ms + PROPOSAL_TTL_MS {
            p.status = Status::Expired;
        } else {
            p.status = Status::Rejected;
        }
        self.proposals.insert(id, p);
    }

    /// Anyone can mark a stale pending proposal as expired.
    pub fn expire(&mut self, id: u64) {
        let mut p = self.proposals.get(&id).cloned().expect("no such proposal");
        require!(p.status == Status::Pending, "proposal is not pending");
        require!(
            env::block_timestamp_ms() >= p.created_at_ms + PROPOSAL_TTL_MS,
            "proposal has not expired yet"
        );
        self.release_commitment(&mut p);
        self.unlock_invoice(&p.kind, false);
        p.status = Status::Expired;
        self.proposals.insert(id, p);
    }

    /// Kill switch: any single signer can stop new allocations and autonomous payouts immediately.
    /// Unpausing needs a `SetPaused { paused: false }` proposal.
    pub fn pause(&mut self) {
        self.assert_signer();
        self.paused = true;
        env::log_str("allocations and autonomous payouts paused");
    }

    // ---- invoices --------------------------------------------------------------

    /// Submit an invoice to this treasury. Anyone may call it (a vendor or its agent); attach
    /// 0.01 NEAR for storage. The caller becomes issuer and first holder of the invoice NFT.
    #[payable]
    pub fn submit_invoice(
        &mut self,
        token: AccountId,
        amount: U128,
        due_ms: u64,
        reference: String,
        document_hash: Option<String>,
    ) -> u64 {
        require!(
            env::attached_deposit() >= INVOICE_DEPOSIT,
            "attach 0.01 NEAR to submit an invoice"
        );
        require!(amount.0 > 0, "amount must be positive");
        require!(
            !reference.is_empty() && reference.len() <= MAX_INVOICE_REFERENCE,
            "reference must be 1-64 bytes"
        );
        if let Some(h) = &document_hash {
            require!(is_lower_hex(h, 64), "document_hash must be 64 lowercase hex chars");
        }
        let issuer = env::predecessor_account_id();
        let id = self.next_invoice_id;
        self.next_invoice_id += 1;
        self.invoices.insert(
            id,
            Invoice {
                id,
                issuer: issuer.clone(),
                holder: issuer.clone(),
                token,
                amount,
                due_ms,
                reference,
                document_hash,
                status: InvoiceStatus::Open,
                created_at_ms: env::block_timestamp_ms(),
                pending_proposal: None,
                paid_by_proposal: None,
                sale_price: None,
            },
        );
        emit_nft_event("nft_mint", json!([{ "owner_id": issuer, "token_ids": [id.to_string()] }]));
        id
    }

    /// The issuer withdraws an invoice it still holds and nobody is paying.
    pub fn cancel_invoice(&mut self, invoice_id: u64) {
        let mut inv = self.invoice(invoice_id);
        let caller = env::predecessor_account_id();
        require!(caller == inv.issuer && caller == inv.holder, "only the issuer, while holding it, can cancel");
        require!(inv.status == InvoiceStatus::Open, "invoice is not open");
        require!(inv.pending_proposal.is_none(), "a proposal to pay this invoice is pending");
        inv.status = InvoiceStatus::Cancelled;
        inv.sale_price = None;
        self.invoices.insert(invoice_id, inv);
        emit_nft_event("nft_burn", json!([{ "owner_id": caller, "token_ids": [invoice_id.to_string()] }]));
    }

    /// List an open invoice for sale at `price` (in the invoice token), or unlist with `None`.
    pub fn set_invoice_price(&mut self, invoice_id: u64, price: Option<U128>) {
        let mut inv = self.invoice(invoice_id);
        require!(env::predecessor_account_id() == inv.holder, "only the holder can list this invoice");
        require!(inv.status == InvoiceStatus::Open, "invoice is not open");
        if let Some(p) = price {
            require!(p.0 > 0, "price must be positive");
        }
        inv.sale_price = price;
        self.invoices.insert(invoice_id, inv);
    }

    /// NEP-141 receiver. An empty msg is a plain deposit into the treasury. The msg
    /// `{"buy_invoice": <id>}` buys a listed invoice: the NFT moves to the sender, the seller is
    /// paid the price minus the factoring fee, and any excess is refunded.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        if msg.trim().is_empty() {
            return U128(0);
        }
        let parsed: serde_json::Map<String, serde_json::Value> =
            serde_json::from_slice(msg.as_bytes()).expect("unsupported ft_on_transfer msg");
        let invoice_id = parsed
            .get("buy_invoice")
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| env::panic_str("unsupported ft_on_transfer msg"));
        let mut inv = self.invoice(invoice_id);
        require!(inv.status == InvoiceStatus::Open, "invoice is not open");
        require!(env::predecessor_account_id() == inv.token, "pay with the invoice token");
        let price = inv.sale_price.expect("invoice is not for sale").0;
        require!(amount.0 >= price, "payment is below the asking price");
        require!(sender_id != inv.holder, "you already hold this invoice");

        let seller = inv.holder.clone();
        let fee = match &self.fee_recipient {
            Some(_) => price * self.factoring_fee_bps as u128 / 10_000,
            None => 0,
        };
        inv.holder = sender_id.clone();
        inv.sale_price = None;
        let token = inv.token.clone();
        self.invoices.insert(invoice_id, inv);
        emit_nft_event(
            "nft_transfer",
            json!([{ "old_owner_id": seller, "new_owner_id": sender_id, "token_ids": [invoice_id.to_string()], "memo": "sale" }]),
        );

        self.forward(&token, &seller, price - fee);
        if fee > 0 {
            let recipient = self.fee_recipient.clone().unwrap();
            self.forward(&token, &recipient, fee);
        }
        U128(amount.0 - price)
    }

    /// Withdraw funds owed to the caller after a sale payout that could not be delivered.
    pub fn claim(&mut self, token: AccountId) -> Promise {
        let caller = env::predecessor_account_id();
        let key = claim_key(&caller, &token);
        let owed = self.claims.remove(&key).expect("nothing to claim").0;
        Promise::new(token.clone())
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": caller, "amount": U128(owed) }).to_string().into_bytes(),
                ONE_YOCTO,
                FT_TRANSFER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_forward_complete(caller, token, U128(owed)),
            )
    }

    pub fn get_invoice(&self, invoice_id: u64) -> Option<Invoice> {
        self.invoices.get(&invoice_id).cloned()
    }

    pub fn list_invoices(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Invoice> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_invoice_id)
            .take(limit as usize)
            .filter_map(|i| self.invoices.get(&i).cloned())
            .collect()
    }

    /// (fee in basis points, recipient). The fee only applies when a recipient is set.
    pub fn get_factoring_fee(&self) -> (u16, Option<AccountId>) {
        (self.factoring_fee_bps, self.fee_recipient.clone())
    }

    pub fn get_claim(&self, account_id: AccountId, token: AccountId) -> U128 {
        self.claims.get(&claim_key(&account_id, &token)).copied().unwrap_or(U128(0))
    }

    // ---- NEP-171 / NEP-177 (invoices as NFTs) -----------------------------------

    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata {
            spec: "nft-1.0.0".into(),
            name: "Ghost Store Invoices".into(),
            symbol: "GINV".into(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_token(&self, token_id: String) -> Option<JsonToken> {
        let id: u64 = token_id.parse().ok()?;
        self.invoices
            .get(&id)
            .filter(|i| i.status != InvoiceStatus::Cancelled)
            .map(json_token)
    }

    /// Transfer an open invoice. Attach exactly 1 yoctoNEAR. Clears any sale listing.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        require!(env::attached_deposit() == ONE_YOCTO, "requires attached deposit of exactly 1 yoctoNEAR");
        require!(approval_id.is_none(), "approvals are not supported");
        let id: u64 = token_id.parse().unwrap_or_else(|_| env::panic_str("token not found"));
        let mut inv = self.invoice(id);
        let caller = env::predecessor_account_id();
        require!(caller == inv.holder, "only the holder can transfer this invoice");
        require!(inv.status == InvoiceStatus::Open, "only open invoices can be transferred");
        require!(receiver_id != caller, "receiver is already the holder");
        inv.holder = receiver_id.clone();
        inv.sale_price = None;
        self.invoices.insert(id, inv);
        emit_nft_event(
            "nft_transfer",
            json!([{ "old_owner_id": caller, "new_owner_id": receiver_id, "token_ids": [token_id], "memo": memo }]),
        );
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.invoices.values().filter(|i| i.status != InvoiceStatus::Cancelled).count() as u128)
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let from = from_index.map(|f| f.0 as u64).unwrap_or(0);
        self.list_invoices(Some(from), limit)
            .iter()
            .filter(|i| i.status != InvoiceStatus::Cancelled)
            .map(json_token)
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(
            self.invoices
                .values()
                .filter(|i| i.holder == account_id && i.status != InvoiceStatus::Cancelled)
                .count() as u128,
        )
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<JsonToken> {
        let skip = from_index.map(|f| f.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100) as usize;
        self.invoices
            .values()
            .filter(|i| i.holder == account_id && i.status != InvoiceStatus::Cancelled)
            .skip(skip)
            .take(limit)
            .map(json_token)
            .collect()
    }

    // ---- callbacks -----------------------------------------------------------

    /// After a payout (native or ft_transfer). Marks the proposal Failed on error.
    #[private]
    pub fn on_transfer_complete(&mut self, proposal_id: u64) {
        if env::promise_result_checked(0, 1024).is_err() {
            self.set_status(proposal_id, Status::Failed);
            let kind = self.proposals.get(&proposal_id).map(|p| p.kind.clone());
            if let Some(kind) = kind {
                self.unlock_invoice(&kind, true);
            }
            env::log_str(&format!("payout for proposal #{proposal_id} failed"));
        }
    }

    /// After forwarding a sale payout or a claim. On failure the amount becomes claimable.
    #[private]
    pub fn on_forward_complete(&mut self, receiver: AccountId, token: AccountId, amount: U128) {
        if env::promise_result_checked(0, 1024).is_err() {
            let key = claim_key(&receiver, &token);
            let owed = self.claims.get(&key).map(|v| v.0).unwrap_or(0) + amount.0;
            self.claims.insert(key, U128(owed));
            env::log_str(&format!("payout to {receiver} failed; {} is claimable with claim()", amount.0));
        }
    }

    /// After `ft_balance_of`: enforces the reserve floor, then sends the tokens to the venue.
    #[private]
    pub fn on_allocate_balance(
        &mut self,
        proposal_id: u64,
        venue: AccountId,
        token: AccountId,
        amount: U128,
    ) -> PromiseOrValue<()> {
        let balance = match env::promise_result_checked(0, 128) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes).ok(),
            Err(_) => None,
        };
        let Some(balance) = balance else {
            self.rollback_allocation(proposal_id, &venue, amount.0, false, "could not read token balance");
            return PromiseOrValue::Value(());
        };
        // Other outflows that passed their check but have not settled still sit in `balance`.
        let floor = self.policy().reserve_floor.0;
        if balance.0 < self.outflow_in_flight.saturating_add(amount.0).saturating_add(floor) {
            self.rollback_allocation(proposal_id, &venue, amount.0, false, "reserve floor would be breached");
            return PromiseOrValue::Value(());
        }
        self.outflow_in_flight += amount.0;
        PromiseOrValue::Promise(
            Promise::new(token)
                .function_call(
                    "ft_transfer_call".to_string(),
                    json!({ "receiver_id": venue, "amount": amount, "msg": "" })
                        .to_string()
                        .into_bytes(),
                    ONE_YOCTO,
                    FT_TRANSFER_CALL_GAS,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_allocate_complete(proposal_id, venue, amount),
                ),
        )
    }

    /// After ft_transfer_call. The FT returns how much the venue actually kept.
    #[private]
    pub fn on_allocate_complete(&mut self, proposal_id: u64, venue: AccountId, amount: U128) {
        match env::promise_result_checked(0, 128) {
            Err(_) => self.rollback_allocation(proposal_id, &venue, amount.0, true, "ft_transfer_call failed"),
            Ok(bytes) => {
                // Settled (any refund already happened inside ft_transfer_call).
                self.outflow_in_flight = self.outflow_in_flight.saturating_sub(amount.0);
                if let Ok(used) = serde_json::from_slice::<U128>(&bytes) {
                    let used = used.0.min(amount.0);
                    if used < amount.0 {
                        self.sub_position(&venue, amount.0 - used);
                    }
                    if used == 0 {
                        self.set_status(proposal_id, Status::Failed);
                        env::log_str(&format!("venue refused allocation for proposal #{proposal_id}"));
                    }
                } else {
                    env::log_str("unreadable ft_transfer_call result; keeping full principal on record");
                }
            }
        }
    }

    /// After `ft_balance_of` for an autonomous payout: enforce the reserve floor, then pay.
    #[private]
    pub fn on_auto_payout_balance(
        &mut self,
        proposal_id: u64,
        to: AccountId,
        token: AccountId,
        amount: U128,
    ) -> PromiseOrValue<()> {
        let balance = match env::promise_result_checked(0, 128) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes).ok(),
            Err(_) => None,
        };
        let Some(balance) = balance else {
            self.rollback_auto_payout(proposal_id, amount.0, false, "could not read token balance");
            return PromiseOrValue::Value(());
        };
        let floor = self
            .policy
            .as_ref()
            .filter(|p| p.stable_token == token)
            .map(|p| p.reserve_floor.0)
            .unwrap_or(0);
        if balance.0 < self.outflow_in_flight.saturating_add(amount.0).saturating_add(floor) {
            self.rollback_auto_payout(proposal_id, amount.0, false, "reserve floor would be breached");
            return PromiseOrValue::Value(());
        }
        self.outflow_in_flight += amount.0;
        PromiseOrValue::Promise(
            Promise::new(token)
                .function_call(
                    "ft_transfer".to_string(),
                    json!({ "receiver_id": to, "amount": amount }).to_string().into_bytes(),
                    ONE_YOCTO,
                    FT_TRANSFER_GAS,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_auto_payout_complete(proposal_id, amount),
                ),
        )
    }

    /// After an autonomous ft_transfer. On failure the budget is given back.
    #[private]
    pub fn on_auto_payout_complete(&mut self, proposal_id: u64, amount: U128) {
        if env::promise_result_checked(0, 1024).is_err() {
            self.rollback_auto_payout(proposal_id, amount.0, true, "ft_transfer failed");
        } else {
            self.outflow_in_flight = self.outflow_in_flight.saturating_sub(amount.0);
        }
    }

    /// After a venue `withdraw`. Venues return the amount actually paid out (U128); an empty or
    /// unreadable result is treated as "paid in full". A result of 0 means nothing was paid.
    #[private]
    pub fn on_withdraw_complete(&mut self, proposal_id: u64, venue: AccountId, amount: U128) {
        match env::promise_result_checked(0, 128) {
            Err(_) => {
                self.set_status(proposal_id, Status::Failed);
                env::log_str(&format!("withdraw for proposal #{proposal_id} failed"));
            }
            Ok(bytes) => {
                let paid = serde_json::from_slice::<U128>(&bytes)
                    .map(|v| v.0.min(amount.0))
                    .unwrap_or(amount.0);
                if paid == 0 {
                    self.set_status(proposal_id, Status::Failed);
                    env::log_str(&format!("venue paid nothing for proposal #{proposal_id}"));
                } else {
                    self.sub_position(&venue, paid);
                }
            }
        }
    }

    // ---- internals -----------------------------------------------------------

    fn assert_signer(&self) {
        require!(
            self.signers.contains(&env::predecessor_account_id()),
            "only a signer can do this"
        );
    }

    fn policy(&self) -> &Policy {
        self.policy
            .as_ref()
            .expect("policy not configured; propose SetPolicy first")
    }

    fn position(&self, venue: &AccountId) -> u128 {
        self.positions.get(venue).map(|v| v.0).unwrap_or(0)
    }

    fn add_position(&mut self, venue: &AccountId, amount: u128) {
        let new = self.position(venue).checked_add(amount).expect("position overflow");
        self.positions.insert(venue.clone(), U128(new));
        self.total_allocated = self.total_allocated.checked_add(amount).expect("total overflow");
    }

    fn sub_position(&mut self, venue: &AccountId, amount: u128) {
        let current = self.position(venue);
        let dec = amount.min(current);
        let new = current - dec;
        if new == 0 {
            self.positions.remove(venue);
        } else {
            self.positions.insert(venue.clone(), U128(new));
        }
        self.total_allocated = self.total_allocated.saturating_sub(dec);
    }

    fn set_status(&mut self, id: u64, status: Status) {
        let mut p = self.proposals.get(&id).cloned().expect("proposal missing in callback");
        p.status = status;
        self.proposals.insert(id, p);
    }

    /// `sent`: the balance check passed and the amount was counted in `outflow_in_flight`.
    fn rollback_allocation(&mut self, id: u64, venue: &AccountId, amount: u128, sent: bool, reason: &str) {
        self.sub_position(venue, amount);
        if sent {
            self.outflow_in_flight = self.outflow_in_flight.saturating_sub(amount);
        }
        self.set_status(id, Status::Failed);
        env::log_str(&format!("allocation for proposal #{id} rolled back: {reason}"));
    }

    fn rollback_auto_payout(&mut self, id: u64, amount: u128, sent: bool, reason: &str) {
        if sent {
            self.outflow_in_flight = self.outflow_in_flight.saturating_sub(amount);
        }
        self.autonomy_spent = self.autonomy_spent.saturating_sub(amount);
        self.set_status(id, Status::Failed);
        let kind = self.proposals.get(&id).map(|p| p.kind.clone());
        if let Some(kind) = kind {
            self.unlock_invoice(&kind, true);
        }
        env::log_str(&format!("autonomous payout #{id} failed, budget returned: {reason}"));
    }

    fn insert_proposal(
        &mut self,
        kind: ProposalKind,
        proposer: AccountId,
        rationale: String,
        attestation: Option<AiAttestation>,
    ) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let now = env::block_timestamp_ms();
        if let ProposalKind::PayInvoice { invoice_id } = kind {
            let mut inv = self.invoice(invoice_id);
            require!(inv.pending_proposal.is_none(), "a proposal to pay this invoice is already pending");
            inv.pending_proposal = Some(id);
            self.invoices.insert(invoice_id, inv);
        }
        let auto_execute_after_ms = if attestation.is_some() && self.reserve_autonomy(&kind) {
            Some(now + self.autonomy.as_ref().map(|a| a.veto_window_ms).unwrap_or(0))
        } else {
            None
        };
        if let Some(after) = auto_execute_after_ms {
            env::log_str(&format!("proposal #{id} is in the autonomy lane; executable after {after} ms"));
        }
        self.proposals.insert(
            id,
            Proposal {
                id,
                kind,
                proposer,
                rationale,
                approvals: vec![],
                status: Status::Pending,
                created_at_ms: now,
                attestation,
                auto_execute_after_ms,
            },
        );
        id
    }

    /// Start a new budget bucket when the UTC day changes.
    fn roll_autonomy_day(&mut self) {
        let day = env::block_timestamp_ms() / DAY_MS;
        if day != self.autonomy_day {
            self.autonomy_day = day;
            self.autonomy_spent = 0;
        }
    }

    /// If `kind` fits the autonomy policy, hold its amount against today's cap and return true.
    fn reserve_autonomy(&mut self, kind: &ProposalKind) -> bool {
        if self.paused {
            return false;
        }
        let Some(a) = self.autonomy.clone() else { return false };
        let Some(terms) = self.lane_terms(kind) else { return false };
        if !self.lane_allows(&terms) {
            return false;
        }
        self.roll_autonomy_day();
        let Some(total) = self
            .autonomy_spent
            .checked_add(self.autonomy_committed)
            .and_then(|v| v.checked_add(terms.amount))
        else {
            return false;
        };
        if total > a.daily_cap.0 {
            return false;
        }
        self.autonomy_committed += terms.amount;
        true
    }

    /// Who would be paid what, and which account the allowlist is checked against, for kinds
    /// the autonomy lane can hold. `None` for every other kind.
    fn lane_terms(&self, kind: &ProposalKind) -> Option<LaneTerms> {
        match kind {
            ProposalKind::Payout { to, token: Some(token), amount } => Some(LaneTerms {
                to: to.clone(),
                token: token.clone(),
                amount: amount.0,
                vendor: to.clone(),
                invoice: false,
            }),
            ProposalKind::PayInvoice { invoice_id } => {
                let inv = self.invoices.get(invoice_id)?;
                (inv.status == InvoiceStatus::Open).then(|| LaneTerms {
                    to: inv.holder.clone(),
                    token: inv.token.clone(),
                    amount: inv.amount.0,
                    vendor: inv.issuer.clone(),
                    invoice: true,
                })
            }
            _ => None,
        }
    }

    /// Policy checks other than the daily cap: not paused, right token, under the per-payout
    /// limit, vendor allowlisted, and invoice-backed when the policy requires it.
    fn lane_allows(&self, t: &LaneTerms) -> bool {
        !self.paused
            && self.autonomy.as_ref().is_some_and(|a| {
                a.token == t.token
                    && t.amount <= a.max_per_payout.0
                    && (t.invoice || !a.invoices_only)
            })
            && self.vendors.contains(&t.vendor)
    }

    /// Take a proposal out of the autonomy lane and give back its budget hold.
    fn release_commitment(&mut self, p: &mut Proposal) {
        if p.auto_execute_after_ms.take().is_some() {
            let amount = match &p.kind {
                ProposalKind::Payout { amount, .. } => amount.0,
                ProposalKind::PayInvoice { invoice_id } => {
                    self.invoices.get(invoice_id).map(|i| i.amount.0).unwrap_or(0)
                }
                _ => 0,
            };
            self.autonomy_committed = self.autonomy_committed.saturating_sub(amount);
        }
    }

    fn invoice(&self, id: u64) -> Invoice {
        self.invoices.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such invoice"))
    }

    fn mark_invoice_paid(&mut self, invoice_id: u64, proposal_id: u64) {
        let mut inv = self.invoice(invoice_id);
        inv.status = InvoiceStatus::Paid;
        inv.pending_proposal = None;
        inv.paid_by_proposal = Some(proposal_id);
        inv.sale_price = None;
        self.invoices.insert(invoice_id, inv);
    }

    /// Release an invoice from a proposal that will not pay it. With `reopen`, also undo a
    /// payment that failed after the invoice was marked paid.
    fn unlock_invoice(&mut self, kind: &ProposalKind, reopen: bool) {
        let ProposalKind::PayInvoice { invoice_id } = kind else { return };
        if let Some(mut inv) = self.invoices.get(invoice_id).cloned() {
            inv.pending_proposal = None;
            if reopen && inv.status == InvoiceStatus::Paid {
                inv.status = InvoiceStatus::Open;
                inv.paid_by_proposal = None;
            }
            self.invoices.insert(*invoice_id, inv);
        }
    }

    /// Send `amount` of `token` to `receiver`; a failure leaves it claimable.
    fn forward(&self, token: &AccountId, receiver: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        // Detached: scheduled when dropped, independent of the value returned to the token.
        let _ = Promise::new(token.clone())
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": receiver, "amount": U128(amount) }).to_string().into_bytes(),
                ONE_YOCTO,
                FT_TRANSFER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_forward_complete(receiver.clone(), token.clone(), U128(amount)),
            );
    }

    fn validate_kind(&self, kind: &ProposalKind) {
        match kind {
            ProposalKind::Payout { amount, .. } => {
                require!(amount.0 > 0, "amount must be positive");
            }
            ProposalKind::Allocate { venue, token, amount } => {
                require!(amount.0 > 0, "amount must be positive");
                require!(!self.paused, "allocations are paused");
                let cap = self.venue_caps.get(venue).expect("venue is not whitelisted");
                let new_principal = self.position(venue).checked_add(amount.0).expect("overflow");
                require!(new_principal <= cap.0, "amount exceeds the venue cap");
                let policy = self.policy();
                require!(
                    *token == policy.stable_token,
                    "only the policy stable token can be allocated"
                );
                let new_total = self.total_allocated.checked_add(amount.0).expect("overflow");
                require!(
                    new_total <= policy.max_total_allocated.0,
                    "amount exceeds the total allocation limit"
                );
            }
            ProposalKind::Withdraw { venue, amount } => {
                require!(amount.0 > 0, "amount must be positive");
                require!(self.positions.get(venue).is_some(), "no position at this venue");
                let _ = self.policy();
            }
            ProposalKind::SetVenueCap { .. } => {}
            ProposalKind::SetPolicy { .. } => {}
            ProposalKind::SetPaused { .. } => {}
            ProposalKind::AddSigner { account_id } => {
                require!(!self.signers.contains(account_id), "account is already a signer");
            }
            ProposalKind::RemoveSigner { account_id } => {
                require!(self.signers.contains(account_id), "account is not a signer");
                require!(self.signers.len() > 1, "cannot remove the last signer");
                require!(
                    self.threshold as usize <= self.signers.len() - 1,
                    "removal would make threshold unreachable; lower threshold first"
                );
            }
            ProposalKind::SetThreshold { threshold } => {
                require!(*threshold >= 1, "threshold must be at least 1");
                require!(
                    (*threshold as usize) <= self.signers.len(),
                    "threshold exceeds signer count"
                );
            }
            ProposalKind::SetProposer { .. } => {}
            ProposalKind::SetVendor { .. } => {}
            ProposalKind::SetAutonomy { policy } => {
                if let Some(a) = policy {
                    require!(a.max_per_payout.0 > 0, "max_per_payout must be positive");
                    require!(
                        a.max_per_payout.0 <= a.daily_cap.0,
                        "max_per_payout cannot exceed daily_cap"
                    );
                    require!(
                        a.veto_window_ms >= MIN_VETO_WINDOW_MS && a.veto_window_ms < PROPOSAL_TTL_MS,
                        "veto window must be at least 1 minute and shorter than the proposal TTL"
                    );
                }
            }
            ProposalKind::PayInvoice { invoice_id } => {
                let inv = self.invoice(*invoice_id);
                require!(inv.status == InvoiceStatus::Open, "invoice is not open");
            }
            ProposalKind::SetFactoringFee { fee_bps, recipient } => {
                require!(*fee_bps <= MAX_FACTORING_FEE_BPS, "factoring fee is capped at 1000 bps");
                require!(*fee_bps == 0 || recipient.is_some(), "a nonzero fee needs a recipient");
            }
            ProposalKind::SetModelSigner { address, .. } => {
                require!(
                    address.len() == 42 && address.starts_with("0x") && is_lower_hex(&address[2..], 40),
                    "address must be 0x followed by 40 lowercase hex chars"
                );
            }
        }
    }

    /// Returns Some(Promise) for async kinds, None for synchronous governance changes.
    fn execute(&mut self, p: &Proposal) -> Option<Promise> {
        match &p.kind {
            ProposalKind::Payout { to, token: None, amount } => {
                let storage_cost =
                    env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
                let available = env::account_balance()
                    .saturating_sub(storage_cost)
                    .saturating_sub(STORAGE_RESERVE);
                require!(
                    available >= NearToken::from_yoctonear(amount.0),
                    "insufficient balance after storage reserve"
                );
                Some(
                    Promise::new(to.clone())
                        .transfer(NearToken::from_yoctonear(amount.0))
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(CALLBACK_GAS)
                                .on_transfer_complete(p.id),
                        ),
                )
            }
            ProposalKind::Payout { to, token: Some(token), amount } => Some(
                Promise::new(token.clone())
                    .function_call(
                        "ft_transfer".to_string(),
                        json!({ "receiver_id": to, "amount": amount }).to_string().into_bytes(),
                        ONE_YOCTO,
                        FT_TRANSFER_GAS,
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(CALLBACK_GAS)
                            .on_transfer_complete(p.id),
                    ),
            ),
            ProposalKind::Allocate { venue, token, amount } => {
                // Reserve the principal now so two approvals in flight cannot both pass the cap.
                // Callbacks roll it back if the balance check or the transfer fails.
                self.add_position(venue, amount.0);
                Some(
                    Promise::new(token.clone())
                        .function_call(
                            "ft_balance_of".to_string(),
                            json!({ "account_id": env::current_account_id() })
                                .to_string()
                                .into_bytes(),
                            NearToken::from_yoctonear(0),
                            FT_BALANCE_GAS,
                        )
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(ALLOCATE_CHECK_CALLBACK_GAS)
                                .on_allocate_balance(p.id, venue.clone(), token.clone(), *amount),
                        ),
                )
            }
            ProposalKind::Withdraw { venue, amount } => {
                let token = self.policy().stable_token.clone();
                Some(
                    Promise::new(venue.clone())
                        .function_call(
                            "withdraw".to_string(),
                            json!({ "token_id": token, "amount": amount })
                                .to_string()
                                .into_bytes(),
                            ONE_YOCTO,
                            WITHDRAW_GAS,
                        )
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(CALLBACK_GAS)
                                .on_withdraw_complete(p.id, venue.clone(), *amount),
                        ),
                )
            }
            ProposalKind::SetVenueCap { venue, cap } => {
                if cap.0 == 0 {
                    self.venue_caps.remove(venue);
                } else {
                    self.venue_caps.insert(venue.clone(), *cap);
                }
                None
            }
            ProposalKind::SetPolicy { stable_token, max_total_allocated, reserve_floor } => {
                self.policy = Some(Policy {
                    stable_token: stable_token.clone(),
                    max_total_allocated: *max_total_allocated,
                    reserve_floor: *reserve_floor,
                });
                None
            }
            ProposalKind::SetPaused { paused } => {
                self.paused = *paused;
                None
            }
            ProposalKind::AddSigner { account_id } => {
                self.signers.push(account_id.clone());
                None
            }
            ProposalKind::RemoveSigner { account_id } => {
                self.signers.retain(|s| s != account_id);
                None
            }
            ProposalKind::SetThreshold { threshold } => {
                self.threshold = *threshold;
                None
            }
            ProposalKind::SetProposer { account_id } => {
                self.proposer = account_id.clone();
                None
            }
            ProposalKind::SetVendor { account_id, enabled } => {
                if *enabled {
                    self.vendors.insert(account_id.clone());
                } else {
                    self.vendors.remove(account_id);
                }
                None
            }
            ProposalKind::SetAutonomy { policy } => {
                self.autonomy = policy.clone();
                None
            }
            ProposalKind::PayInvoice { invoice_id } => {
                let inv = self.invoice(*invoice_id);
                self.mark_invoice_paid(*invoice_id, p.id);
                Some(
                    Promise::new(inv.token.clone())
                        .function_call(
                            "ft_transfer".to_string(),
                            json!({ "receiver_id": inv.holder, "amount": inv.amount })
                                .to_string()
                                .into_bytes(),
                            ONE_YOCTO,
                            FT_TRANSFER_GAS,
                        )
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(CALLBACK_GAS)
                                .on_transfer_complete(p.id),
                        ),
                )
            }
            ProposalKind::SetFactoringFee { fee_bps, recipient } => {
                self.factoring_fee_bps = *fee_bps;
                self.fee_recipient = recipient.clone();
                None
            }
            ProposalKind::SetModelSigner { address, model } => {
                if model.is_empty() {
                    self.model_signers.remove(address);
                } else {
                    self.model_signers.insert(address.clone(), model.clone());
                }
                None
            }
        }
    }
}

// ---- invoice helpers -------------------------------------------------------------

struct LaneTerms {
    to: AccountId,
    token: AccountId,
    amount: u128,
    /// Account checked against the vendor allowlist (the payee, or the invoice issuer).
    vendor: AccountId,
    invoice: bool,
}

fn claim_key(account: &AccountId, token: &AccountId) -> String {
    format!("{account}|{token}")
}

/// NEP-297 event log for NEP-171.
fn emit_nft_event(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "nep171", "version": "1.2.0", "event": event, "data": data })
    ));
}

fn json_token(inv: &Invoice) -> JsonToken {
    let status = match inv.status {
        InvoiceStatus::Open => "open",
        InvoiceStatus::Paid => "paid",
        InvoiceStatus::Cancelled => "cancelled",
    };
    JsonToken {
        token_id: inv.id.to_string(),
        owner_id: inv.holder.clone(),
        metadata: TokenMetadata {
            title: Some(format!("Invoice #{} · {}", inv.id, inv.reference)),
            description: Some(format!(
                "Receivable of {} {} issued by {} to this treasury. Paid to the holder.",
                inv.amount.0, inv.token, inv.issuer
            )),
            media: None,
            issued_at: Some(inv.created_at_ms.to_string()),
            extra: Some(
                json!({ "status": status, "due_ms": inv.due_ms, "issuer": inv.issuer, "amount": inv.amount, "token": inv.token })
                    .to_string(),
            ),
        },
    }
}

// ---- signature helpers ---------------------------------------------------------

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    s.as_bytes()
        .chunks(2)
        .map(|p| Some(nibble(p[0])? << 4 | nibble(p[1])?))
        .collect()
}

/// Recover the Ethereum-style address that signed `text` with EIP-191 `personal_sign`.
/// Returns lowercase 0x hex. Panics on a malformed or unrecoverable signature.
fn recover_eip191_address(text: &str, signature: &str) -> String {
    let sig = from_hex(signature.strip_prefix("0x").unwrap_or(signature))
        .filter(|s| s.len() == 65)
        .unwrap_or_else(|| env::panic_str("signature must be 65 bytes of hex"));
    let v = match sig[64] {
        0 | 1 => sig[64],
        27 | 28 => sig[64] - 27,
        _ => env::panic_str("invalid signature recovery byte"),
    };
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let digest = env::keccak256_array(&msg);
    let pubkey = env::ecrecover(&digest, &sig[..64], v, true)
        .unwrap_or_else(|| env::panic_str("could not recover signer"));
    let hash = env::keccak256_array(&pubkey);
    format!("0x{}", to_hex(&hash[12..]))
}

// ---- tests -------------------------------------------------------------------

#[cfg(test)]
mod test_vectors;
#[cfg(test)]
mod real_vectors;

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

    const TS_NS: u64 = 1_000_000_000_000; // 1000 s in ns

    // accounts: 0 alice (signer), 1 bob (signer), 2 charlie (AI proposer),
    // 3 danny (recipient / stable token), 4 eugene (venue), 5 fargo (other)
    fn alice() -> AccountId { accounts(0) }
    fn bob() -> AccountId { accounts(1) }
    fn ai() -> AccountId { accounts(2) }
    fn stable() -> AccountId { accounts(3) }
    fn venue() -> AccountId { accounts(4) }

    fn ctx(who: AccountId) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .block_timestamp(TS_NS)
            .build());
    }

    fn ctx_with_balance(who: AccountId, balance: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .account_balance(balance)
            .block_timestamp(TS_NS)
            .build());
    }

    /// Callback context: predecessor is the contract itself and a promise result is available.
    fn cb_ctx(result: PromiseResult) {
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(env::current_account_id())
                .block_timestamp(TS_NS)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    fn ok_u128(v: u128) -> PromiseResult {
        PromiseResult::Successful(serde_json::to_vec(&U128(v)).unwrap())
    }

    fn setup() -> Treasury {
        ctx(alice());
        Treasury::new(vec![alice(), bob()], 2, ai())
    }

    /// Propose as `who`, then approve by alice and bob.
    fn pass(t: &mut Treasury, who: AccountId, kind: ProposalKind) -> u64 {
        ctx(who);
        let id = t.propose(kind, "test".into());
        ctx_with_balance(alice(), NearToken::from_near(10));
        t.approve(id);
        ctx_with_balance(bob(), NearToken::from_near(10));
        t.approve(id);
        id
    }

    /// Whitelist the venue (cap) and configure the policy.
    fn setup_yield(t: &mut Treasury, venue_cap: u128, max_total: u128, floor: u128) {
        pass(t, alice(), ProposalKind::SetVenueCap { venue: venue(), cap: U128(venue_cap) });
        pass(
            t,
            alice(),
            ProposalKind::SetPolicy {
                stable_token: stable(),
                max_total_allocated: U128(max_total),
                reserve_floor: U128(floor),
            },
        );
    }

    fn allocate(t: &mut Treasury, amount: u128) -> u64 {
        pass(
            t,
            ai(),
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(amount) },
        )
    }

    // ---- baseline behaviour ---------------------------------------------------

    #[test]
    fn proposer_proposes_signers_approve() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: None, amount: U128(10) },
            "pay vendor".into(),
        );
        ctx_with_balance(alice(), NearToken::from_near(10));
        assert!(t.approve(id).is_none());
        ctx_with_balance(bob(), NearToken::from_near(10));
        assert!(t.approve(id).is_some());
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
    }

    #[test]
    #[should_panic(expected = "only a signer can do this")]
    fn proposer_cannot_approve() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: None, amount: U128(10) },
            "x".into(),
        );
        t.approve(id);
    }

    #[test]
    #[should_panic(expected = "venue is not whitelisted")]
    fn allocation_needs_whitelisted_venue() {
        let mut t = setup();
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(1) },
            "x".into(),
        );
    }

    #[test]
    #[should_panic(expected = "amount exceeds the venue cap")]
    fn allocation_respects_cap() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetVenueCap { venue: venue(), cap: U128(100) });
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(101) },
            "x".into(),
        );
    }

    #[test]
    fn native_payout_works_with_the_demo_vault_balance() {
        // Demo vault: ~4 NEAR balance, ~170 KB of storage (about 1.7 NEAR staked).
        // A 0.5 NEAR payout must succeed with the 0.5 NEAR reserve.
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout {
                to: stable(),
                token: None,
                amount: U128(NearToken::from_millinear(500).as_yoctonear()),
            },
            "demo".into(),
        );
        let demo_vault = |who: AccountId| {
            testing_env!(VMContextBuilder::new()
                .predecessor_account_id(who)
                .account_balance(NearToken::from_near(4))
                .storage_usage(170_000)
                .block_timestamp(TS_NS)
                .build());
        };
        demo_vault(alice());
        t.approve(id);
        demo_vault(bob());
        assert!(t.approve(id).is_some());
    }

    #[test]
    #[should_panic(expected = "insufficient balance after storage reserve")]
    fn native_payout_rejects_when_balance_too_low() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout {
                to: stable(),
                token: None,
                amount: U128(NearToken::from_near(1000).as_yoctonear()),
            },
            "big payout".into(),
        );
        ctx_with_balance(alice(), NearToken::from_near(1));
        t.approve(id);
        ctx_with_balance(bob(), NearToken::from_near(1));
        t.approve(id);
    }

    #[test]
    fn payout_callback_sets_failed() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: Some(accounts(5)), amount: U128(50) },
            "ft payout".into(),
        );
        t.set_status(id, Status::Executed);
        cb_ctx(PromiseResult::Failed);
        t.on_transfer_complete(id);
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
    }

    #[test]
    fn payout_callback_keeps_executed_on_success() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: Some(accounts(5)), amount: U128(50) },
            "ft payout".into(),
        );
        t.set_status(id, Status::Executed);
        cb_ctx(PromiseResult::Successful(vec![]));
        t.on_transfer_complete(id);
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
    }

    // ---- governance -----------------------------------------------------------

    #[test]
    fn set_venue_cap_requires_threshold() {
        let mut t = setup();
        ctx(alice());
        let id = t.propose(ProposalKind::SetVenueCap { venue: venue(), cap: U128(500) }, "x".into());
        ctx(alice());
        t.approve(id);
        assert!(t.get_venue_cap(venue()).is_none());
        ctx(bob());
        t.approve(id);
        assert_eq!(t.get_venue_cap(venue()), Some(U128(500)));
    }

    #[test]
    fn add_signer_through_proposal() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::AddSigner { account_id: stable() });
        let (signers, _, _) = t.get_config();
        assert!(signers.contains(&stable()));
    }

    #[test]
    fn remove_signer_through_proposal() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetThreshold { threshold: 1 });
        ctx(alice());
        let id = t.propose(ProposalKind::RemoveSigner { account_id: bob() }, "remove bob".into());
        ctx(alice());
        t.approve(id); // threshold is 1 now
        let (signers, _, _) = t.get_config();
        assert!(!signers.contains(&bob()));
    }

    #[test]
    fn set_proposer_through_proposal() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetProposer { account_id: accounts(5) });
        let (_, _, proposer) = t.get_config();
        assert_eq!(proposer, accounts(5));
    }

    #[test]
    fn new_deduplicates_signers() {
        ctx(alice());
        let t = Treasury::new(vec![alice(), alice(), bob()], 2, ai());
        assert_eq!(t.get_config().0.len(), 2);
    }

    #[test]
    #[should_panic(expected = "proposal has expired")]
    fn expired_proposal_cannot_be_approved() {
        let mut t = setup();
        testing_env!(VMContextBuilder::new().predecessor_account_id(ai()).block_timestamp(0).build());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: None, amount: U128(1) },
            "will expire".into(),
        );
        let expired_ns = (PROPOSAL_TTL_MS + 1) * 1_000_000;
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(alice())
            .block_timestamp(expired_ns)
            .build());
        t.approve(id);
    }

    #[test]
    fn anyone_can_expire_a_stale_proposal() {
        let mut t = setup();
        testing_env!(VMContextBuilder::new().predecessor_account_id(ai()).block_timestamp(0).build());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: None, amount: U128(1) },
            "stale".into(),
        );
        let later = (PROPOSAL_TTL_MS + 1) * 1_000_000;
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(5))
            .block_timestamp(later)
            .build());
        t.expire(id);
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Expired);
    }

    #[test]
    #[should_panic(expected = "proposal has not expired yet")]
    fn fresh_proposal_cannot_be_expired() {
        let mut t = setup();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: stable(), token: None, amount: U128(1) },
            "fresh".into(),
        );
        t.expire(id);
    }

    #[test]
    fn approvals_from_removed_signers_do_not_count() {
        // signers a, b, c; threshold 2
        ctx(alice());
        let mut t = Treasury::new(vec![alice(), bob(), stable()], 2, ai());
        ctx(ai());
        let pay = t.propose(
            ProposalKind::Payout { to: accounts(5), token: None, amount: U128(10) },
            "pay".into(),
        );
        // bob approves the payout, then bob is voted out
        ctx_with_balance(bob(), NearToken::from_near(10));
        t.approve(pay);
        ctx(alice());
        let rm = t.propose(ProposalKind::RemoveSigner { account_id: bob() }, "rm".into());
        ctx(alice());
        t.approve(rm);
        ctx(stable());
        t.approve(rm);
        assert!(!t.get_config().0.contains(&bob()));
        // alice approves: approvals are [bob, alice] but bob no longer counts
        ctx_with_balance(alice(), NearToken::from_near(10));
        assert!(t.approve(pay).is_none());
        assert_eq!(t.get_proposal(pay).unwrap().status, Status::Pending);
        // stable (danny) is a signer and approves: now 2 valid approvals
        ctx_with_balance(stable(), NearToken::from_near(10));
        assert!(t.approve(pay).is_some());
    }

    // ---- yield layer: validation ---------------------------------------------

    #[test]
    #[should_panic(expected = "policy not configured")]
    fn allocation_needs_policy() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetVenueCap { venue: venue(), cap: U128(100) });
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(10) },
            "x".into(),
        );
    }

    #[test]
    #[should_panic(expected = "only the policy stable token can be allocated")]
    fn allocation_must_use_the_stable_token() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: accounts(5), amount: U128(10) },
            "x".into(),
        );
    }

    #[test]
    #[should_panic(expected = "amount exceeds the total allocation limit")]
    fn allocation_respects_total_limit() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 50, 0);
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(51) },
            "x".into(),
        );
    }

    #[test]
    fn allocation_books_principal_on_approval() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        allocate(&mut t, 60);
        assert_eq!(t.get_total_allocated(), U128(60));
        assert_eq!(t.get_positions(), vec![(venue(), U128(60))]);
    }

    #[test]
    #[should_panic(expected = "amount exceeds the venue cap")]
    fn venue_cap_is_cumulative() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        allocate(&mut t, 60);
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(60) },
            "second".into(),
        );
    }

    // ---- yield layer: pause ---------------------------------------------------

    #[test]
    fn single_signer_can_pause() {
        let mut t = setup();
        ctx(alice());
        t.pause();
        assert!(t.is_paused());
    }

    #[test]
    #[should_panic(expected = "allocations are paused")]
    fn pause_blocks_new_allocations() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        ctx(alice());
        t.pause();
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(1) },
            "x".into(),
        );
    }

    #[test]
    #[should_panic(expected = "allocations are paused")]
    fn pause_blocks_execution_of_already_proposed_allocations() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        ctx(ai());
        let id = t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(10) },
            "x".into(),
        );
        ctx(alice());
        t.pause();
        ctx(alice());
        t.approve(id);
        ctx(bob());
        t.approve(id); // threshold reached: re-validation sees the pause
    }

    #[test]
    #[should_panic(expected = "only a signer can do this")]
    fn proposer_cannot_pause() {
        let mut t = setup();
        ctx(ai());
        t.pause();
    }

    #[test]
    fn unpause_needs_a_proposal() {
        let mut t = setup();
        ctx(alice());
        t.pause();
        pass(&mut t, alice(), ProposalKind::SetPaused { paused: false });
        assert!(!t.is_paused());
    }

    // ---- yield layer: async callbacks ----------------------------------------

    #[test]
    fn reserve_floor_breach_rolls_back() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 100);
        let id = allocate(&mut t, 60);
        // balance 150 < amount 60 + floor 100
        cb_ctx(ok_u128(150));
        let out = t.on_allocate_balance(id, venue(), stable(), U128(60));
        assert!(matches!(out, PromiseOrValue::Value(())));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(0));
        assert!(t.get_positions().is_empty());
        assert!(get_logs().iter().any(|l| l.contains("reserve floor would be breached")));
    }

    #[test]
    fn enough_balance_sends_tokens_to_the_venue() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 100);
        let id = allocate(&mut t, 60);
        cb_ctx(ok_u128(160)); // exactly amount + floor
        let out = t.on_allocate_balance(id, venue(), stable(), U128(60));
        assert!(matches!(out, PromiseOrValue::Promise(_)));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert_eq!(t.get_total_allocated(), U128(60));
    }

    #[test]
    fn unreadable_balance_rolls_back() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        let id = allocate(&mut t, 60);
        cb_ctx(PromiseResult::Failed);
        let out = t.on_allocate_balance(id, venue(), stable(), U128(60));
        assert!(matches!(out, PromiseOrValue::Value(())));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(0));
    }

    #[test]
    fn failed_ft_transfer_call_rolls_back() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        let id = allocate(&mut t, 60);
        cb_ctx(PromiseResult::Failed);
        t.on_allocate_complete(id, venue(), U128(60));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(0));
    }

    #[test]
    fn partial_use_adjusts_principal() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        let id = allocate(&mut t, 60);
        cb_ctx(ok_u128(40)); // venue kept only 40
        t.on_allocate_complete(id, venue(), U128(60));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert_eq!(t.get_total_allocated(), U128(40));
        assert_eq!(t.get_positions(), vec![(venue(), U128(40))]);
    }

    #[test]
    fn venue_refusing_everything_marks_failed() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        let id = allocate(&mut t, 60);
        cb_ctx(ok_u128(0));
        t.on_allocate_complete(id, venue(), U128(60));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(0));
    }

    #[test]
    fn full_use_keeps_principal() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        let id = allocate(&mut t, 60);
        cb_ctx(ok_u128(60));
        t.on_allocate_complete(id, venue(), U128(60));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert_eq!(t.get_total_allocated(), U128(60));
    }

    // ---- yield layer: withdraw ------------------------------------------------

    #[test]
    #[should_panic(expected = "no position at this venue")]
    fn withdraw_needs_a_position() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        ctx(ai());
        t.propose(ProposalKind::Withdraw { venue: venue(), amount: U128(10) }, "x".into());
    }

    #[test]
    fn withdraw_reduces_principal_on_success() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        let id = pass(&mut t, ai(), ProposalKind::Withdraw { venue: venue(), amount: U128(25) });
        cb_ctx(PromiseResult::Successful(vec![]));
        t.on_withdraw_complete(id, venue(), U128(25));
        assert_eq!(t.get_total_allocated(), U128(35));
        assert_eq!(t.get_positions(), vec![(venue(), U128(35))]);
    }

    #[test]
    fn venue_paying_less_reduces_principal_by_what_was_paid() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        let id = pass(&mut t, ai(), ProposalKind::Withdraw { venue: venue(), amount: U128(25) });
        cb_ctx(ok_u128(10));
        t.on_withdraw_complete(id, venue(), U128(25));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert_eq!(t.get_total_allocated(), U128(50));
    }

    #[test]
    fn venue_paying_zero_marks_failed() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        let id = pass(&mut t, ai(), ProposalKind::Withdraw { venue: venue(), amount: U128(25) });
        cb_ctx(ok_u128(0));
        t.on_withdraw_complete(id, venue(), U128(25));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(60));
    }

    #[test]
    fn withdrawing_more_than_principal_clears_the_position() {
        // amount can include interest; principal bottoms out at zero
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        let id = pass(&mut t, ai(), ProposalKind::Withdraw { venue: venue(), amount: U128(75) });
        cb_ctx(PromiseResult::Successful(vec![]));
        t.on_withdraw_complete(id, venue(), U128(75));
        assert_eq!(t.get_total_allocated(), U128(0));
        assert!(t.get_positions().is_empty());
    }

    #[test]
    fn failed_withdraw_leaves_principal_and_marks_failed() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        let id = pass(&mut t, ai(), ProposalKind::Withdraw { venue: venue(), amount: U128(25) });
        cb_ctx(PromiseResult::Failed);
        t.on_withdraw_complete(id, venue(), U128(25));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(60));
    }

    #[test]
    fn withdraw_is_allowed_while_paused() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        ctx(alice());
        t.pause();
        ctx(ai());
        t.propose(ProposalKind::Withdraw { venue: venue(), amount: U128(10) }, "exit".into());
    }

    // ---- two-venue bookkeeping ------------------------------------------------

    /// Second venue. `accounts(5)` is the "other" account in this suite; nothing else is
    /// whitelisted in the tests below, so it is unambiguous here.
    fn venue_b() -> AccountId {
        accounts(5)
    }

    fn allocate_to(t: &mut Treasury, v: AccountId, amount: u128) -> u64 {
        pass(t, ai(), ProposalKind::Allocate { venue: v, token: stable(), amount: U128(amount) })
    }

    fn withdraw_from(t: &mut Treasury, v: AccountId, amount: u128) -> u64 {
        pass(t, ai(), ProposalKind::Withdraw { venue: v, amount: U128(amount) })
    }

    /// Whitelist both venues, then set the policy.
    fn two_venues(t: &mut Treasury, cap: u128, max_total: u128, floor: u128) {
        pass(t, alice(), ProposalKind::SetVenueCap { venue: venue(), cap: U128(cap) });
        pass(t, alice(), ProposalKind::SetVenueCap { venue: venue_b(), cap: U128(cap) });
        pass(
            t,
            alice(),
            ProposalKind::SetPolicy {
                stable_token: stable(),
                max_total_allocated: U128(max_total),
                reserve_floor: U128(floor),
            },
        );
    }

    #[test]
    fn over_withdraw_from_one_venue_leaves_the_other_untouched() {
        // A holds 150, B holds 100; withdraw 500 from A. The venue pays only its principal,
        // so only A's position and the total drop, by 150.
        let mut t = setup();
        two_venues(&mut t, 500, 1_000, 0);
        allocate_to(&mut t, venue(), 150);
        allocate_to(&mut t, venue_b(), 100);
        assert_eq!(t.get_total_allocated(), U128(250));

        let id = withdraw_from(&mut t, venue(), 500);
        cb_ctx(ok_u128(150));
        t.on_withdraw_complete(id, venue(), U128(500));

        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert_eq!(t.get_total_allocated(), U128(100));
        assert_eq!(t.get_positions(), vec![(venue_b(), U128(100))]);
    }

    #[test]
    fn zero_payout_from_one_venue_keeps_both_positions() {
        // Same shape, but the venue reports 0 paid: nothing may be written off anywhere.
        let mut t = setup();
        two_venues(&mut t, 500, 1_000, 0);
        allocate_to(&mut t, venue(), 150);
        allocate_to(&mut t, venue_b(), 100);

        let id = withdraw_from(&mut t, venue(), 500);
        cb_ctx(ok_u128(0));
        t.on_withdraw_complete(id, venue(), U128(500));

        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(250));
        let mut positions = t.get_positions();
        positions.sort();
        assert_eq!(positions, vec![(venue(), U128(150)), (venue_b(), U128(100))]);
    }

    #[test]
    fn venue_refund_books_no_position_and_leaves_the_other_venue() {
        // B's venue keeps nothing (returns 0); the position booked for B on approval must go,
        // and A's already-settled position must not move.
        let mut t = setup();
        two_venues(&mut t, 500, 1_000, 0);
        allocate_to(&mut t, venue(), 60);
        let id = allocate_to(&mut t, venue_b(), 40);
        assert_eq!(t.get_total_allocated(), U128(100));

        cb_ctx(ok_u128(0));
        t.on_allocate_complete(id, venue_b(), U128(40));

        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(60));
        assert_eq!(t.get_positions(), vec![(venue(), U128(60))]);
    }

    #[test]
    fn reserve_floor_rollback_leaves_an_existing_position_intact() {
        // A is already allocated 60. B needs 40 and the balance snapshot is 130; the floor of
        // 100 means 140 is required, so only B's pending principal is rolled back.
        let mut t = setup();
        two_venues(&mut t, 500, 1_000, 100);
        allocate_to(&mut t, venue(), 60);
        let id = allocate_to(&mut t, venue_b(), 40);

        cb_ctx(ok_u128(130));
        let out = t.on_allocate_balance(id, venue_b(), stable(), U128(40));

        assert!(matches!(out, PromiseOrValue::Value(())));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        assert_eq!(t.get_total_allocated(), U128(60));
        assert_eq!(t.get_positions(), vec![(venue(), U128(60))]);
    }

    #[test]
    fn venue_cap_allows_two_allocations_up_to_the_cap() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        allocate_to(&mut t, venue(), 60);
        allocate_to(&mut t, venue(), 40);
        assert_eq!(t.get_total_allocated(), U128(100));
    }

    #[test]
    #[should_panic(expected = "amount exceeds the venue cap")]
    fn venue_cap_rejects_one_unit_over_the_cap() {
        let mut t = setup();
        setup_yield(&mut t, 100, 1_000, 0);
        allocate_to(&mut t, venue(), 60);
        allocate_to(&mut t, venue(), 40);
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue(), token: stable(), amount: U128(1) },
            "one over".into(),
        );
    }

    #[test]
    #[should_panic(expected = "amount exceeds the total allocation limit")]
    fn total_cap_is_cumulative_across_venues() {
        let mut t = setup();
        two_venues(&mut t, 500, 100, 0);
        allocate_to(&mut t, venue(), 60);
        ctx(ai());
        t.propose(
            ProposalKind::Allocate { venue: venue_b(), token: stable(), amount: U128(60) },
            "second venue".into(),
        );
    }

    // ---- pause: what still works ---------------------------------------------

    #[test]
    fn payout_executes_while_paused() {
        let mut t = setup();
        ctx(alice());
        t.pause();
        ctx(ai());
        let id = t.propose(
            ProposalKind::Payout { to: accounts(5), token: None, amount: U128(10) },
            "vendor".into(),
        );
        ctx_with_balance(alice(), NearToken::from_near(10));
        assert!(t.approve(id).is_none());
        ctx_with_balance(bob(), NearToken::from_near(10));
        assert!(t.approve(id).is_some());
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert!(t.is_paused(), "a payout must not unpause the treasury");
    }

    #[test]
    fn withdraw_executes_while_paused() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 0);
        allocate(&mut t, 60);
        ctx(alice());
        t.pause();

        let id = withdraw_from(&mut t, venue(), 25);
        cb_ctx(ok_u128(25));
        t.on_withdraw_complete(id, venue(), U128(25));

        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert_eq!(t.get_total_allocated(), U128(35));
        assert!(t.is_paused(), "a withdraw must not unpause the treasury");
    }

    // ---- removed signers ------------------------------------------------------

    #[test]
    #[should_panic(expected = "only a signer can do this")]
    fn removed_signer_cannot_approve() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetThreshold { threshold: 1 });
        ctx(alice());
        let rm = t.propose(ProposalKind::RemoveSigner { account_id: bob() }, "rm".into());
        ctx(alice());
        t.approve(rm);
        assert!(!t.get_config().0.contains(&bob()));

        ctx(ai());
        let pay = t.propose(
            ProposalKind::Payout { to: accounts(5), token: None, amount: U128(10) },
            "pay".into(),
        );
        ctx(bob());
        t.approve(pay);
    }

    // ---- attested proposals and the autonomy lane -----------------------------

    use crate::test_vectors as tv;

    const HOUR_MS: u64 = 60 * 60 * 1_000;

    fn vendor() -> AccountId { accounts(5) } // "fargo", the payee in the signed fixtures

    fn ctx_at(who: AccountId, ts_ms: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .block_timestamp(ts_ms * 1_000_000)
            .build());
    }

    fn cb_ctx_at(result: PromiseResult, ts_ms: u64) {
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(env::current_account_id())
                .block_timestamp(ts_ms * 1_000_000)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    fn now_ms() -> u64 { TS_NS / 1_000_000 }

    /// Treasury with the test model key registered, the yield layer configured and,
    /// when `cap` is given, the autonomy lane on with `fargo` allowlisted.
    fn setup_autonomy(per_payout: u128, cap: Option<u128>) -> Treasury {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 10);
        pass(&mut t, alice(), ProposalKind::SetModelSigner {
            address: tv::SIGNER.into(),
            model: tv::MODEL.into(),
        });
        if let Some(cap) = cap {
            pass(&mut t, alice(), ProposalKind::SetVendor { account_id: vendor(), enabled: true });
            pass(&mut t, alice(), ProposalKind::SetAutonomy {
                policy: Some(AutonomyPolicy {
                    token: stable(),
                    max_per_payout: U128(per_payout),
                    daily_cap: U128(cap),
                    veto_window_ms: HOUR_MS,
                    invoices_only: false,
                }),
            });
        }
        t
    }

    fn submit(t: &mut Treasury, fixture: (&str, &str)) -> Vec<u64> {
        ctx(ai());
        t.propose_attested(
            tv::MODEL.into(),
            tv::REQUEST_HASH.into(),
            Base64VecU8(fixture.0.as_bytes().to_vec()),
            fixture.1.into(),
        )
    }

    #[test]
    fn attested_response_creates_proposals_with_verified_signer() {
        let mut t = setup_autonomy(100, Some(150));
        let ids = submit(&mut t, tv::PAYOUT_AND_ALLOCATE);
        assert_eq!(ids.len(), 2);

        let pay = t.get_proposal(ids[0]).unwrap();
        let att = pay.attestation.clone().expect("attestation recorded");
        assert_eq!(att.signer, tv::SIGNER);
        assert_eq!(att.request_hash, tv::REQUEST_HASH);
        assert_eq!(att.created_s, 1000);
        assert_eq!(pay.rationale, "Pay the fargo invoice due this week");
        assert_eq!(pay.auto_execute_after_ms, Some(now_ms() + HOUR_MS));
        assert!(t.is_response_used(att.response_hash));

        // Allocations never enter the autonomy lane.
        let alloc = t.get_proposal(ids[1]).unwrap();
        assert!(alloc.attestation.is_some());
        assert_eq!(alloc.auto_execute_after_ms, None);
        assert_eq!(t.get_autonomy().committed, U128(50));
        assert_eq!(t.get_autonomy().remaining, U128(100));
    }

    #[test]
    #[should_panic(expected = "response already used")]
    fn signed_response_cannot_be_replayed() {
        let mut t = setup_autonomy(100, Some(150));
        submit(&mut t, tv::PAYOUT_AND_ALLOCATE);
        submit(&mut t, tv::PAYOUT_AND_ALLOCATE);
    }

    #[test]
    #[should_panic(expected = "signature is not from a model key registered for this model")]
    fn unregistered_model_key_is_refused() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 10);
        submit(&mut t, tv::PAYOUT_AND_ALLOCATE);
    }

    #[test]
    #[should_panic(expected = "signature is not from a model key registered for this model")]
    fn wrong_model_name_breaks_the_signature() {
        let mut t = setup_autonomy(100, Some(150));
        ctx(ai());
        t.propose_attested(
            "other/model".into(),
            tv::REQUEST_HASH.into(),
            Base64VecU8(tv::PAYOUT_AND_ALLOCATE.0.as_bytes().to_vec()),
            tv::PAYOUT_AND_ALLOCATE.1.into(),
        );
    }

    #[test]
    #[should_panic(expected = "signature is not from a model key registered for this model")]
    fn tampered_amount_breaks_the_signature() {
        let mut t = setup_autonomy(100, Some(150));
        let tampered = tv::PAYOUT_AND_ALLOCATE.0.replacen("\\\"50\\\"", "\\\"5000\\\"", 1);
        assert_ne!(tampered, tv::PAYOUT_AND_ALLOCATE.0);
        submit(&mut t, (&tampered, tv::PAYOUT_AND_ALLOCATE.1));
    }

    #[test]
    #[should_panic(expected = "signature is not from a model key registered for this model")]
    fn tampered_request_hash_breaks_the_signature() {
        let mut t = setup_autonomy(100, Some(150));
        ctx(ai());
        t.propose_attested(
            tv::MODEL.into(),
            "00".repeat(32),
            Base64VecU8(tv::PAYOUT_AND_ALLOCATE.0.as_bytes().to_vec()),
            tv::PAYOUT_AND_ALLOCATE.1.into(),
        );
    }

    #[test]
    #[should_panic(expected = "attested proposals may only be Payout, PayInvoice, Allocate or Withdraw")]
    fn model_cannot_propose_governance() {
        let mut t = setup_autonomy(100, Some(150));
        submit(&mut t, tv::GOVERNANCE);
    }

    #[test]
    #[should_panic(expected = "response is too old")]
    fn stale_response_is_refused() {
        let mut t = setup_autonomy(100, Some(150));
        ctx_at(ai(), (1000 + MAX_RESPONSE_AGE_S + 1) * 1_000);
        t.propose_attested(
            tv::MODEL.into(),
            tv::REQUEST_HASH.into(),
            Base64VecU8(tv::BIG_PAYOUT.0.as_bytes().to_vec()),
            tv::BIG_PAYOUT.1.into(),
        );
    }

    #[test]
    #[should_panic(expected = "only the proposer can submit attested proposals")]
    fn only_the_proposer_submits_attested_proposals() {
        let mut t = setup_autonomy(100, Some(150));
        ctx(alice());
        t.propose_attested(
            tv::MODEL.into(),
            tv::REQUEST_HASH.into(),
            Base64VecU8(tv::BIG_PAYOUT.0.as_bytes().to_vec()),
            tv::BIG_PAYOUT.1.into(),
        );
    }

    #[test]
    fn payout_over_the_per_payout_limit_needs_signers() {
        let mut t = setup_autonomy(100, Some(150));
        let ids = submit(&mut t, tv::BIG_PAYOUT);
        let p = t.get_proposal(ids[0]).unwrap();
        assert!(p.attestation.is_some());
        assert_eq!(p.auto_execute_after_ms, None);
        assert_eq!(t.get_autonomy().committed, U128(0));
    }

    #[test]
    fn vendor_not_on_the_allowlist_needs_signers() {
        let mut t = setup_autonomy(100, Some(150));
        pass(&mut t, alice(), ProposalKind::SetVendor { account_id: vendor(), enabled: false });
        let ids = submit(&mut t, tv::PAYOUT_60_A);
        assert_eq!(t.get_proposal(ids[0]).unwrap().auto_execute_after_ms, None);
    }

    #[test]
    fn autonomy_off_means_signers_only() {
        let mut t = setup_autonomy(100, None);
        let ids = submit(&mut t, tv::PAYOUT_60_A);
        assert_eq!(t.get_proposal(ids[0]).unwrap().auto_execute_after_ms, None);
    }

    #[test]
    fn daily_cap_counts_payouts_waiting_in_the_veto_window() {
        let mut t = setup_autonomy(100, Some(100));
        let a = submit(&mut t, tv::PAYOUT_60_A)[0];
        let b = submit(&mut t, tv::PAYOUT_60_B)[0];
        assert!(t.get_proposal(a).unwrap().auto_execute_after_ms.is_some());
        assert_eq!(t.get_proposal(b).unwrap().auto_execute_after_ms, None, "60 + 60 > 100");
        assert_eq!(t.get_autonomy().remaining, U128(40));
    }

    #[test]
    #[should_panic(expected = "veto window has not ended")]
    fn autonomous_payout_waits_for_the_veto_window() {
        let mut t = setup_autonomy(100, Some(150));
        let id = submit(&mut t, tv::PAYOUT_60_A)[0];
        ctx_at(accounts(5), now_ms() + HOUR_MS - 1);
        t.execute_auto(id);
    }

    #[test]
    fn anyone_executes_after_the_window_and_the_floor_is_checked() {
        let mut t = setup_autonomy(100, Some(150));
        let id = submit(&mut t, tv::PAYOUT_60_A)[0];
        let at = now_ms() + HOUR_MS;
        ctx_at(accounts(5), at);
        assert!(t.execute_auto(id).is_some());
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
        assert!(t.get_proposal(id).unwrap().approvals.is_empty());
        ctx_at(accounts(5), at);
        assert_eq!(t.get_autonomy().spent, U128(60));
        assert_eq!(t.get_autonomy().committed, U128(0));

        // Balance 1000, floor 10: the transfer is scheduled and counted in flight.
        cb_ctx_at(ok_u128(1_000), at);
        assert!(matches!(
            t.on_auto_payout_balance(id, vendor(), stable(), U128(60)),
            PromiseOrValue::Promise(_)
        ));
        assert_eq!(t.get_outflow_in_flight(), U128(60));
        cb_ctx_at(PromiseResult::Successful(vec![]), at);
        t.on_auto_payout_complete(id, U128(60));
        assert_eq!(t.get_outflow_in_flight(), U128(0));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Executed);
    }

    #[test]
    fn autonomous_payout_cannot_breach_the_reserve_floor() {
        let mut t = setup_autonomy(100, Some(150));
        let id = submit(&mut t, tv::PAYOUT_60_A)[0];
        let at = now_ms() + HOUR_MS;
        ctx_at(accounts(5), at);
        t.execute_auto(id);
        cb_ctx_at(ok_u128(69), at); // needs 60 + floor 10
        assert!(matches!(
            t.on_auto_payout_balance(id, vendor(), stable(), U128(60)),
            PromiseOrValue::Value(())
        ));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        ctx_at(accounts(5), at);
        assert_eq!(t.get_autonomy().spent, U128(0), "budget returned");
        assert_eq!(t.get_outflow_in_flight(), U128(0));
    }

    #[test]
    fn failed_autonomous_transfer_returns_the_budget() {
        let mut t = setup_autonomy(100, Some(150));
        let id = submit(&mut t, tv::PAYOUT_60_A)[0];
        let at = now_ms() + HOUR_MS;
        ctx_at(accounts(5), at);
        t.execute_auto(id);
        cb_ctx_at(ok_u128(1_000), at);
        let _ = t.on_auto_payout_balance(id, vendor(), stable(), U128(60));
        cb_ctx_at(PromiseResult::Failed, at);
        t.on_auto_payout_complete(id, U128(60));
        assert_eq!(t.get_proposal(id).unwrap().status, Status::Failed);
        ctx_at(accounts(5), at);
        assert_eq!(t.get_autonomy().spent, U128(0));
        assert_eq!(t.get_outflow_in_flight(), U128(0));
    }

    #[test]
    fn one_signer_veto_stops_an_autonomous_payout() {
        let mut t = setup_autonomy(100, Some(150));
        let id = submit(&mut t, tv::PAYOUT_60_A)[0];
        ctx(bob());
        t.reject(id);
        let p = t.get_proposal(id).unwrap();
        assert_eq!(p.status, Status::Rejected);
        assert_eq!(p.auto_execute_after_ms, None);
        assert_eq!(t.get_autonomy().committed, U128(0));
    }

    #[test]
    #[should_panic(expected = "proposal is not pending")]
    fn vetoed_payout_cannot_be_executed() {
        let mut t = setup_autonomy(100, Some(150));
        let id = submit(&mut t, tv::PAYOUT_60_A)[0];
        ctx(bob());
        t.reject(id);
        ctx_at(accounts(5), now_ms() + HOUR_MS);
        t.execute_auto(id);
    }

    #[test]
    #[should_panic(expected = "autonomy is paused")]
    fn pause_stops_autonomous_payouts() {
        let mut t = setup_autonomy(100, Some(150));
        let id = submit(&mut t, tv::PAYOUT_60_A)[0];
        ctx(alice());
        t.pause();
        ctx_at(accounts(5), now_ms() + HOUR_MS);
        t.execute_auto(id);
    }

    #[test]
    fn payout_that_no_longer_fits_falls_back_to_signers() {
        let mut t = setup_autonomy(100, Some(150));
        let id = submit(&mut t, tv::PAYOUT_60_A)[0];
        pass(&mut t, alice(), ProposalKind::SetVendor { account_id: vendor(), enabled: false });
        ctx_at(accounts(5), now_ms() + HOUR_MS);
        assert!(t.execute_auto(id).is_none());
        let p = t.get_proposal(id).unwrap();
        assert_eq!(p.status, Status::Pending);
        assert_eq!(p.auto_execute_after_ms, None);
        assert_eq!(t.get_autonomy().committed, U128(0));
    }

    #[test]
    fn signer_approval_takes_over_from_the_autonomy_lane() {
        let mut t = setup_autonomy(100, Some(150));
        let id = submit(&mut t, tv::PAYOUT_60_A)[0];
        ctx(alice());
        t.approve(id);
        ctx(bob());
        assert!(t.approve(id).is_some());
        let p = t.get_proposal(id).unwrap();
        assert_eq!(p.status, Status::Executed);
        assert_eq!(p.auto_execute_after_ms, None);
        assert_eq!(t.get_autonomy().committed, U128(0));
        assert_eq!(t.get_autonomy().spent, U128(0), "signer-approved payouts do not use the budget");
    }

    #[test]
    fn budget_resets_on_a_new_utc_day() {
        let mut t = setup_autonomy(100, Some(100));
        let id = submit(&mut t, tv::PAYOUT_60_A)[0];
        ctx_at(accounts(5), now_ms() + HOUR_MS);
        t.execute_auto(id);
        ctx_at(accounts(5), now_ms() + HOUR_MS);
        assert_eq!(t.get_autonomy().remaining, U128(40));
        ctx_at(accounts(5), now_ms() + DAY_MS);
        assert_eq!(t.get_autonomy().remaining, U128(100));
    }

    #[test]
    #[should_panic(expected = "address must be 0x followed by 40 lowercase hex chars")]
    fn model_signer_address_must_be_normalised() {
        let mut t = setup();
        ctx(alice());
        t.propose(
            ProposalKind::SetModelSigner {
                address: "0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266".into(),
                model: "m".into(),
            },
            "x".into(),
        );
    }

    #[test]
    #[should_panic(expected = "veto window must be at least 1 minute")]
    fn veto_window_has_a_minimum() {
        let mut t = setup();
        ctx(alice());
        t.propose(
            ProposalKind::SetAutonomy {
                policy: Some(AutonomyPolicy {
                    token: stable(),
                    max_per_payout: U128(1),
                    daily_cap: U128(1),
                    veto_window_ms: 0,
                    invoices_only: false,
                }),
            },
            "x".into(),
        );
    }

    #[test]
    fn racing_allocations_cannot_both_pass_the_reserve_floor() {
        let mut t = setup();
        setup_yield(&mut t, 1_000, 1_000, 100);
        let a = allocate(&mut t, 200);
        let b = allocate(&mut t, 200);
        // Both balance checks read 450 before either transfer settles.
        cb_ctx(ok_u128(450));
        assert!(matches!(
            t.on_allocate_balance(a, venue(), stable(), U128(200)),
            PromiseOrValue::Promise(_)
        ));
        cb_ctx(ok_u128(450));
        assert!(matches!(
            t.on_allocate_balance(b, venue(), stable(), U128(200)),
            PromiseOrValue::Value(())
        ));
        assert_eq!(t.get_proposal(b).unwrap().status, Status::Failed);
        assert_eq!(t.get_positions(), vec![(venue(), U128(200))]);
        assert_eq!(t.get_outflow_in_flight(), U128(200));
        cb_ctx(ok_u128(200));
        t.on_allocate_complete(a, venue(), U128(200));
        assert_eq!(t.get_outflow_in_flight(), U128(0));
    }

    #[test]
    fn migrate_keeps_v1_proposals_and_positions() {
        ctx(alice());
        let mut old = TreasuryV1 {
            signers: vec![alice(), bob()],
            threshold: 2,
            proposer: ai(),
            venue_caps: IterableMap::new(b"v"),
            proposals: IterableMap::new(b"p"),
            next_id: 2,
            policy: None,
            paused: false,
            positions: IterableMap::new(b"x"),
            total_allocated: 150,
        };
        for id in 0..2 {
            old.proposals.insert(id, ProposalV1 {
                id,
                kind: ProposalKind::Withdraw { venue: venue(), amount: U128(50) },
                proposer: ai(),
                rationale: format!("v1 #{id}"),
                approvals: vec![alice(), bob()],
                status: Status::Executed,
                created_at_ms: 7,
            });
        }
        old.positions.insert(venue(), U128(150));
        old.venue_caps.insert(venue(), U128(500));
        old.proposals.flush();
        old.positions.flush();
        old.venue_caps.flush();
        env::state_write(&old);

        let t = Treasury::migrate();
        let ps = t.list_proposals(None, None);
        assert_eq!(ps.len(), 2);
        assert_eq!(ps[1].rationale, "v1 #1");
        assert_eq!(ps[1].status, Status::Executed);
        assert_eq!(ps[1].attestation, None);
        assert_eq!(t.get_positions(), vec![(venue(), U128(150))]);
        assert_eq!(t.get_venue_cap(venue()), Some(U128(500)));
        assert_eq!(t.get_total_allocated(), U128(150));
        assert_eq!(t.get_config().1, 2);
        assert!(!env::storage_has_key(&[b"p".as_slice(), &near_sdk::borsh::to_vec(&0u64).unwrap()].concat()));
    }

    #[test]
    fn real_near_ai_tee_signature_is_verified_on_chain() {
        use crate::real_vectors as rv;
        let id = |s: &str| -> AccountId { s.parse().unwrap() };
        let usdt = id("usdt.fakes.testnet");
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetModelSigner { address: rv::SIGNER.into(), model: rv::MODEL.into() });
        // The model named the treasury itself as a venue in this run; whitelist it so all drafts validate.
        pass(&mut t, alice(), ProposalKind::SetVenueCap { venue: id("vault.treasury-dev.testnet"), cap: U128(500_000_000) });
        pass(&mut t, alice(), ProposalKind::SetPolicy {
            stable_token: usdt.clone(),
            max_total_allocated: U128(1_000_000_000),
            reserve_floor: U128(100_000_000),
        });
        for v in ["packaging.treasury-dev.testnet", "courier.treasury-dev.testnet"] {
            pass(&mut t, alice(), ProposalKind::SetVendor { account_id: id(v), enabled: true });
        }
        pass(&mut t, alice(), ProposalKind::SetAutonomy {
            policy: Some(AutonomyPolicy {
                token: usdt,
                max_per_payout: U128(50_000_000),
                daily_cap: U128(100_000_000),
                veto_window_ms: 5 * 60_000,
                invoices_only: false,
            }),
        });

        ctx_at(ai(), rv::CREATED_S * 1_000 + 30_000);
        let ids = t.propose_attested(
            rv::MODEL.into(),
            rv::REQUEST_HASH.into(),
            Base64VecU8(rv::RESPONSE.as_bytes().to_vec()),
            rv::SIGNATURE.into(),
        );
        assert_eq!(ids.len(), 3);
        let p0 = t.get_proposal(ids[0]).unwrap();
        assert_eq!(p0.attestation.as_ref().unwrap().signer, rv::SIGNER);
        assert!(p0.auto_execute_after_ms.is_some(), "40 USDT to an allowlisted vendor");
        assert!(t.get_proposal(ids[1]).unwrap().auto_execute_after_ms.is_some(), "25 USDT, 65 of 100 used");
        assert_eq!(t.get_proposal(ids[2]).unwrap().auto_execute_after_ms, None, "allocations need signers");
        assert_eq!(t.get_autonomy().committed, U128(65_000_000));
    }

    // ---- invoices, invoice NFTs and factoring ------------------------------------

    fn buyer() -> AccountId { "buyer.near".parse().unwrap() }

    fn ctx_pay(who: AccountId, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .attached_deposit(deposit)
            .block_timestamp(TS_NS)
            .build());
    }

    /// `fargo` (the allowlisted vendor in the fixtures) submits an invoice in the stable token.
    fn invoice_from_vendor(t: &mut Treasury, amount: u128) -> u64 {
        ctx_pay(vendor(), INVOICE_DEPOSIT);
        t.submit_invoice(stable(), U128(amount), 2_000_000, "FAR-1".into(), None)
    }

    fn set_invoices_only(t: &mut Treasury, per_payout: u128, cap: u128) {
        pass(t, alice(), ProposalKind::SetAutonomy {
            policy: Some(AutonomyPolicy {
                token: stable(),
                max_per_payout: U128(per_payout),
                daily_cap: U128(cap),
                veto_window_ms: HOUR_MS,
                invoices_only: true,
            }),
        });
    }

    #[test]
    #[should_panic(expected = "attach 0.01 NEAR to submit an invoice")]
    fn invoice_needs_a_storage_deposit() {
        let mut t = setup();
        ctx(vendor());
        t.submit_invoice(stable(), U128(30), 0, "FAR-1".into(), None);
    }

    #[test]
    fn submitted_invoice_is_an_nft_held_by_the_issuer() {
        let mut t = setup();
        let id = invoice_from_vendor(&mut t, 30);
        let inv = t.get_invoice(id).unwrap();
        assert_eq!((inv.issuer.clone(), inv.holder.clone()), (vendor(), vendor()));
        assert_eq!(inv.status, InvoiceStatus::Open);
        let tok = t.nft_token(id.to_string()).unwrap();
        assert_eq!(tok.owner_id, vendor());
        assert_eq!(t.nft_total_supply(), U128(1));
        assert_eq!(t.nft_supply_for_owner(vendor()), U128(1));
        assert!(get_logs().iter().any(|l| l.contains("\"nft_mint\"")));
    }

    #[test]
    fn signers_pay_an_invoice_to_its_holder() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        let pid = pass(&mut t, alice(), ProposalKind::PayInvoice { invoice_id: inv });
        assert_eq!(t.get_proposal(pid).unwrap().status, Status::Executed);
        let i = t.get_invoice(inv).unwrap();
        assert_eq!(i.status, InvoiceStatus::Paid);
        assert_eq!(i.paid_by_proposal, Some(pid));
        assert_eq!(i.pending_proposal, None);
    }

    #[test]
    fn failed_invoice_payment_reopens_the_invoice() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        let pid = pass(&mut t, alice(), ProposalKind::PayInvoice { invoice_id: inv });
        cb_ctx(PromiseResult::Failed);
        t.on_transfer_complete(pid);
        assert_eq!(t.get_proposal(pid).unwrap().status, Status::Failed);
        let i = t.get_invoice(inv).unwrap();
        assert_eq!((i.status, i.paid_by_proposal, i.pending_proposal), (InvoiceStatus::Open, None, None));
    }

    #[test]
    #[should_panic(expected = "a proposal to pay this invoice is already pending")]
    fn an_invoice_backs_one_pending_proposal_at_a_time() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        ctx(alice());
        t.propose(ProposalKind::PayInvoice { invoice_id: inv }, "a".into());
        t.propose(ProposalKind::PayInvoice { invoice_id: inv }, "b".into());
    }

    #[test]
    fn rejecting_releases_the_invoice() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        ctx(alice());
        let pid = t.propose(ProposalKind::PayInvoice { invoice_id: inv }, "a".into());
        t.reject(pid);
        assert_eq!(t.get_invoice(inv).unwrap().pending_proposal, None);
        t.propose(ProposalKind::PayInvoice { invoice_id: inv }, "again".into());
    }

    #[test]
    #[should_panic(expected = "invoice is not open")]
    fn a_paid_invoice_cannot_be_paid_again() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        pass(&mut t, alice(), ProposalKind::PayInvoice { invoice_id: inv });
        ctx(alice());
        t.propose(ProposalKind::PayInvoice { invoice_id: inv }, "twice".into());
    }

    #[test]
    fn attested_invoice_from_an_allowlisted_issuer_enters_the_lane() {
        let mut t = setup_autonomy(100, Some(150));
        set_invoices_only(&mut t, 100, 150);
        let inv = invoice_from_vendor(&mut t, 30);
        assert_eq!(inv, 0, "the PAY_INVOICE_0 fixture names invoice 0");
        let pid = submit(&mut t, tv::PAY_INVOICE_0)[0];
        let p = t.get_proposal(pid).unwrap();
        assert!(p.auto_execute_after_ms.is_some());
        assert_eq!(t.get_autonomy().committed, U128(30));
        assert_eq!(t.get_invoice(inv).unwrap().pending_proposal, Some(pid));
    }

    #[test]
    fn invoices_only_keeps_raw_payouts_out_of_the_lane() {
        let mut t = setup_autonomy(100, Some(150));
        set_invoices_only(&mut t, 100, 150);
        let pid = submit(&mut t, tv::PAYOUT_60_A)[0];
        assert_eq!(t.get_proposal(pid).unwrap().auto_execute_after_ms, None);
        assert_eq!(t.get_autonomy().committed, U128(0));
    }

    #[test]
    fn autonomous_invoice_payment_goes_to_the_current_holder() {
        let mut t = setup_autonomy(100, Some(150));
        set_invoices_only(&mut t, 100, 150);
        let inv = invoice_from_vendor(&mut t, 30);
        let pid = submit(&mut t, tv::PAY_INVOICE_0)[0];
        // The vendor sells the receivable while the payment waits in the veto window.
        ctx_pay(vendor(), ONE_YOCTO);
        t.nft_transfer(buyer(), inv.to_string(), None, None);

        let at = now_ms() + HOUR_MS;
        ctx_at(accounts(5), at);
        assert!(t.execute_auto(pid).is_some());
        let i = t.get_invoice(inv).unwrap();
        assert_eq!((i.status, i.holder.clone()), (InvoiceStatus::Paid, buyer()));
        assert!(get_logs().iter().any(|l| l.contains("to buyer.near")), "{:?}", get_logs());

        // A failed transfer reopens the invoice and returns the budget.
        cb_ctx_at(ok_u128(1_000), at);
        let _ = t.on_auto_payout_balance(pid, buyer(), stable(), U128(30));
        cb_ctx_at(PromiseResult::Failed, at);
        t.on_auto_payout_complete(pid, U128(30));
        assert_eq!(t.get_invoice(inv).unwrap().status, InvoiceStatus::Open);
        ctx_at(accounts(5), at);
        assert_eq!(t.get_autonomy().spent, U128(0));
    }

    #[test]
    fn invoice_from_a_vendor_off_the_allowlist_needs_signers() {
        let mut t = setup_autonomy(100, Some(150));
        set_invoices_only(&mut t, 100, 150);
        pass(&mut t, alice(), ProposalKind::SetVendor { account_id: vendor(), enabled: false });
        invoice_from_vendor(&mut t, 30);
        let pid = submit(&mut t, tv::PAY_INVOICE_0)[0];
        assert_eq!(t.get_proposal(pid).unwrap().auto_execute_after_ms, None);
    }

    #[test]
    #[should_panic(expected = "requires attached deposit of exactly 1 yoctoNEAR")]
    fn nft_transfer_needs_one_yocto() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        ctx(vendor());
        t.nft_transfer(buyer(), inv.to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "only the holder can transfer this invoice")]
    fn only_the_holder_transfers_an_invoice() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        ctx_pay(buyer(), ONE_YOCTO);
        t.nft_transfer(buyer(), inv.to_string(), None, None);
    }

    #[test]
    fn listed_invoice_sells_atomically_with_a_fee() {
        let mut t = setup();
        pass(&mut t, alice(), ProposalKind::SetFactoringFee { fee_bps: 100, recipient: Some(alice()) });
        let inv = invoice_from_vendor(&mut t, 30_000);
        ctx(vendor());
        t.set_invoice_price(inv, Some(U128(29_000)));

        // The stable token calls ft_on_transfer for the buyer's ft_transfer_call.
        ctx(stable());
        let refund = t.ft_on_transfer(buyer(), U128(29_500), r#"{"buy_invoice":0}"#.into());
        assert_eq!(refund, U128(500));
        let i = t.get_invoice(inv).unwrap();
        assert_eq!((i.holder.clone(), i.sale_price), (buyer(), None));
        assert_eq!(t.nft_token(inv.to_string()).unwrap().owner_id, buyer());
        assert_eq!(t.get_factoring_fee(), (100, Some(alice())));
    }

    #[test]
    #[should_panic(expected = "pay with the invoice token")]
    fn invoice_purchase_must_use_the_invoice_token() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        ctx(vendor());
        t.set_invoice_price(inv, Some(U128(29)));
        ctx(accounts(4));
        t.ft_on_transfer(buyer(), U128(29), r#"{"buy_invoice":0}"#.into());
    }

    #[test]
    #[should_panic(expected = "payment is below the asking price")]
    fn invoice_purchase_below_price_is_refused() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        ctx(vendor());
        t.set_invoice_price(inv, Some(U128(29)));
        ctx(stable());
        t.ft_on_transfer(buyer(), U128(28), r#"{"buy_invoice":0}"#.into());
    }

    #[test]
    #[should_panic(expected = "invoice is not for sale")]
    fn unlisted_invoice_cannot_be_bought() {
        let mut t = setup();
        invoice_from_vendor(&mut t, 30);
        ctx(stable());
        t.ft_on_transfer(buyer(), U128(30), r#"{"buy_invoice":0}"#.into());
    }

    #[test]
    fn plain_token_deposit_is_accepted() {
        let mut t = setup();
        ctx(stable());
        assert_eq!(t.ft_on_transfer(buyer(), U128(30), "".into()), U128(0));
    }

    #[test]
    fn failed_sale_payout_becomes_claimable() {
        let mut t = setup();
        cb_ctx(PromiseResult::Failed);
        t.on_forward_complete(vendor(), stable(), U128(29));
        assert_eq!(t.get_claim(vendor(), stable()), U128(29));
    }

    #[test]
    fn issuer_cancels_an_unsold_invoice() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        ctx(vendor());
        t.cancel_invoice(inv);
        assert_eq!(t.get_invoice(inv).unwrap().status, InvoiceStatus::Cancelled);
        assert!(t.nft_token(inv.to_string()).is_none());
        assert_eq!(t.nft_total_supply(), U128(0));
    }

    #[test]
    #[should_panic(expected = "only the issuer, while holding it, can cancel")]
    fn sold_invoice_cannot_be_cancelled_by_the_issuer() {
        let mut t = setup();
        let inv = invoice_from_vendor(&mut t, 30);
        ctx_pay(vendor(), ONE_YOCTO);
        t.nft_transfer(buyer(), inv.to_string(), None, None);
        ctx(vendor());
        t.cancel_invoice(inv);
    }

    #[test]
    #[should_panic(expected = "factoring fee is capped at 1000 bps")]
    fn factoring_fee_is_capped() {
        let mut t = setup();
        ctx(alice());
        t.propose(ProposalKind::SetFactoringFee { fee_bps: 1_001, recipient: Some(alice()) }, "x".into());
    }
}
