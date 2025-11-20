# HIP-0000: Private Transfer Workflow for Hedera Token Service on Solo

| Field             | Value                                    |
| ----------------- | ---------------------------------------- |
| Author(s)         | Solo Private Tokens Team                 |
| Working Group     | Services / Tooling                       |
| Status            | Draft                                     |
| Type              | Standards Track                          |
| Category          | Service                                  |
| Created           | 2025-11-14                               |
| Implemented in    | Solo CLI + patched consensus node (dev)  |

## Abstract

This HIP proposes an extension to the Hedera Token Service (HTS) to support off-ledger privacy for fungible tokens. The design leverages Pedersen commitments and a new `PRIVATE_TOKEN_TRANSFER` transaction that preserves confidentiality of amounts and recipients while retaining compatibility with existing HTS primitives (account association, KYC, treasury keys). The implementation has been prototyped and tested within Solo’s one-shot (Falcon) deployments using a private wallet overlay in TypeScript as well as consensus node modifications to support commitment-only block propagation.

## Motivation

Some enterprises require fungible assets whose transfer amounts and ownership remain private, yet they still need to rely on HTS semantics (account association, treasury control, supply limits). Existing HTS flows always expose balances via `AccountBalanceQuery` and record streams, making them unsuitable for regulated private assets. This HIP introduces a mechanism whereby:

1. Token creation and association remain unchanged, so existing network participants can adopt the feature without re-architecting their onboarding flow.
2. Transfers operate on commitments (not amounts) and therefore do not reveal quantities or recipients in the public record stream.
3. Wallets hold their own blinding factors locally, enabling private balance computation even though the network never sees cleartext.

## Rationale

- **Pedersen commitments:** Provide homomorphic addition and allow validation that inputs equal outputs without exposing actual values. This enables HTS nodes to verify conservation-of-value.
- **Commitment registry (node-local):** By storing commitments per token+owner in memory (and eventually durable storage), the network can authorize spending of existing commitments while never materializing balances in state.
- **Block stream suppression:** Disabling the block stream writer mode prevents the system from emitting commitment data. Active record streams still record transaction metadata (type, payer, fees) but no amounts.
- **Local wallet overlay:** Because the ledger no longer exposes amounts, end users must maintain a local view of their commitments and blinding factors. Our demo illustrates how a wallet can track minted supply, change commitments, and recipient commitments, yet still prove “public ledger = zero” for outside observers.

## Specification

### Transaction flow

1. **Token creation:** `TokenCreateTransaction` with `tokenType = TokenType.FUNGIBLE_PRIVATE` behaves like a standard FT, but network logs include a “Initial private supply … commitment” line (for auditing). Treasury receives the first commitment identifier.
2. **Association:** `TokenAssociateTransaction` remains unchanged; recipients must be associated and KYC’d (if required) before accepting private commitments.
3. **Private transfer:** Clients submit a new `PRIVATE_TOKEN_TRANSFER` transaction body containing:
   - `token` ID.
   - `inputs[]`: list of commitment hashes to consume (owned by the payer/treasury).
   - `outputs[]`: list of `(owner, commitment)` pairs for recipients and change.
   - Optional `zkProof` field for future extensions.
4. **Validation steps (handle workflow):**
   - `WritableTokenStore` and `WritableTokenRelationStore` are fetched from the service scope.
   - The handler ensures token type is `FUNGIBLE_PRIVATE`, payer owns the inputs, and all participants are associated and (if necessary) KYC granted.
   - `PedersenCommitments.sumsMatch(inputs, outputs)` verifies conservation of value.
   - `PrivateCommitmentRegistry.remove()` consumes inputs; `PrivateCommitmentRegistry.put()` stores outputs.
   - Ledger record is emitted with standard metadata but no amounts.
5. **Public transfer guard:** Standard `TransferTransaction` for a private token returns `NOT_SUPPORTED` to prevent leakage via visible HTS flows.

### Solo-specific deployments

- After `solo one-shot falcon deploy` completes, the CLI patches `/opt/hgcapp/services-hedera/HapiApp2.0/data/config/application.properties` inside the consensus pod to enforce:
  - `blockStream.streamMode=RECORDS`
  - `blockStream.writerMode=FILE`
  This disables block streaming (no gRPC/file output) while retaining record stream emission.
- Consensus jar modifications:
  1. In `BlockStreamManagerImpl`, skip `writeItem()`/`prngSeed()` when no worker exists, preventing NPEs when the block stream is disabled.
  2. In `ServiceScopeLookup`, map `PRIVATE_TOKEN_TRANSFER` to `TokenService` so the token store is registered.
- Testing harness:
  - `npm run private-token-spec` executes the original end-to-end spec (create account, mint token, craft commitments, submit private transfer, validate zero balances, confirm NOT_SUPPORTED for public transfer).
  - `npm run private-token-demo` prints a verbose “Private Wallet vs Public Ledger” walkthrough, showing that the wallet sees private balances while the ledger stays at zero.

## Reference Implementation

- **CLI:** [scripts/private-token-e2e.sh] – handles Kind cluster provisioning, deployment, and pod patching.
- **Specs:** `examples/tests/privateToken.spec.ts` and `examples/tests/privateTokenDemo.spec.ts`.
- **Consensus patches:** `../hiero-consensus-node/hedera-node/hedera-app/src/main/java/com/hedera/node/app/blocks/impl/BlockStreamManagerImpl.java` and `.../services/ServiceScopeLookup.java`.

## Backwards Compatibility

Existing HTS functionality (public tokens, NFT operations, scheduling) remains unchanged. `PRIVATE_TOKEN_TRANSFER` introduces a new transaction type; nodes not running the updated binary will reject it. It is up to the network operator to gate deployment until all nodes support the feature. Public `TransferTransaction` behavior for private tokens now returns `NOT_SUPPORTED`, but this only applies to the new token type flag.

## Security Considerations

- **State durability:** Current prototype keeps `PrivateCommitmentRegistry` in memory; network restarts would orphan unspent commitments. Production deployments must persist these mappings or risk loss of funds.
- **Observability:** Disabling block streaming limits network telemetry. Operators should provide alternative monitoring (internal metrics/logs) before enabling this mode cluster-wide.
- **Proof validation:** We currently rely on `PedersenCommitments.sumsMatch`. If regulators require audit, we must provide viewing keys or encrypted blinding factors. This HIP does not yet standardize a regulator key path.

## UX Considerations

- Wallets must maintain local records of commitments and blinding factors to reconstruct balances. Without these, users cannot prove their own holdings.
- Demo script (`npm run private-token-demo`) illustrates how CLI tooling can present both private and public views to end users.

## Testing

- `npm run private-token-spec`: Pass (2025-11-14T11:31Z) on Kind `solo-private-token` cluster.
- `npm run private-token-demo`: Pass (same session). Output included in `expand_demo.md`.
- Both tests rely on `SOLO_ONE_SHOT_DIR=.solo-private-token/private-token-spec.*` produced by `KEEP_ENVIRONMENT=1 ./scripts/private-token-e2e.sh`.

## Deployment & Roll-out

1. Ship the patched consensus binary to Solo operators (or bake into the official Helm chart).
2. Update Solo CLI to include the block stream patching step by default for private-token deployments.
3. Provide wallet SDK updates so clients can easily maintain private commitment records and craft `PRIVATE_TOKEN_TRANSFER` payloads.

## References

- `mechanics.md`: Detailed architecture write-up.
- `expand_demo.md`: Step-by-step demo instructions.
- Solo repo PRs containing the CLI/spec changes.
