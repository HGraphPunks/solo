# Private Token Transfer Mechanics in Solo

This note explains how the new private token workflow operates inside Solo, what changes were required in both the Solo tooling and the consensus node, and how those changes allow the private transfer path to function end‑to‑end. It is intended for engineers already familiar with Solo’s architecture and deployment model.

---

## 1. High‑level flow

1. `scripts/private-token-e2e.sh` provisions a Kind cluster, deploys a Solo one‑shot (Falcon) network, and captures the resulting deployment metadata under `.solo-private-token`.
2. After the network is ACTIVE, the script patches the live consensus pod so that `blockStream.streamMode=RECORDS` and `blockStream.writerMode=FILE`. This effectively disables the block stream writer (`worker == null`), which is a prerequisite for the current private token code path.
3. The script stages a locally built `HederaNode.jar` (from `../hiero-consensus-node/hedera-node/data/apps`) so the cluster runs the fork that contains the block stream fixes and the ServiceScopeLookup update described below.
4. The spec runner (`examples/tests/privateToken.spec.ts`) uses the recorded metadata to:
   - Spin up a JS SDK client pointed at the forwarded node gRPC port (default `127.0.0.1:50211`).
   - Create a recipient account and a fungible private token.
   - Associate the recipient with the token.
   - Pull the treasury’s initial private commitment from `swirlds.log`, craft new Pedersen commitments for the recipient/change, and submit a `PRIVATE_TOKEN_TRANSFER`.
   - Verify the transaction receipt and assert that visible balances for both treasury and recipient remain zero. (The spec now coerces SDK `Long` values to JS numbers before comparing.)
   - Attempt a public `TokenTransfer` to prove the token is non‑transferable via the public path (`NOT_SUPPORTED`).

The transfer logic itself lives in `hedera-token-service-impl`’s `PrivateTokenTransferHandler`. It:

- Loads the `WritableTokenStore`/`WritableTokenRelationStore` via the `StoreFactory` (see §3), validates the token is `FUNGIBLE_PRIVATE`, confirms payer ownership of the input commitments, and checks the recipient/change outputs are properly associated.
- Uses `PedersenCommitments.sumsMatch` to verify input/output amounts match without revealing them.
- Removes consumed commitments from `PrivateCommitmentRegistry`, inserts the new commitments, and records the transaction via `TokenBaseStreamBuilder`.

No cleartext amount or recipient is written to public state; only commitments and associations exist, satisfying the “truly private transfer” requirement for the visible ledger.

---

## 2. Solo tooling changes

### 2.1 `scripts/private-token-e2e.sh`

Key additions under lines 150‑210:

- **Metadata capture:** after `solo one-shot falcon deploy` finishes, the script copies the generated `one-shot-solo-deployment-<id>` directory into a spec‑specific temp directory so repeated spec invocations reuse the same deployment.
- **In‑pod config patch (`patch_block_stream_config`)**:
  - Locates the consensus pod (`solo.hedera.com/type=network-node`).
  - `kubectl exec`s into the container, edits `/opt/hgcapp/services-hedera/HapiApp2.0/data/config/application.properties` in place, forcing `blockStream.streamMode=RECORDS` and `blockStream.writerMode=FILE`.
  - Restarts `network-node.service` and waits for the pod to report Ready. This ensures the running process (not just the mounted ConfigMap) reflects the block stream settings before tests run.
- **Local build staging:** the script copies the local services build (`../hiero-consensus-node/hedera-node/data`) into a temp directory (`.solo-private-token/falcon-build.*`) and passes it via `--local-build-path` in the values file. This guarantees the deployment uses the patched consensus jar you built locally.

### 2.2 Spec harness tweak

`examples/tests/privateToken.spec.ts` now converts token balances returned by the SDK to primitive numbers before comparison:

```ts
const raw = balance.tokens?.get(tokenId) ?? 0;
const bal =
  typeof raw === 'number'
    ? raw
    : raw && typeof raw.toNumber === 'function'
      ? raw.toNumber()
      : Number(raw ?? 0);
```

Without this, `Long` objects coming back from `AccountBalanceQuery` never compared equal to zero, falsely failing the visibility check even when the transfer succeeded.

---

## 3. Consensus node changes

All consensus changes live in `../hiero-consensus-node` and are baked into `HederaNode.jar` before deployment.

### 3.1 `BlockStreamManagerImpl`

In `writeItem()`/`prngSeed()` we now short‑circuit when `worker == null`. When the block stream is configured for `RECORDS/FILE`, Solo doesn’t instantiate a `BlockStreamManagerTask`, so any attempt to emit block items previously threw an NPE (in `BlockStreamManagerImpl.writeItem`) during private token handling. The new guard makes block stream writes a no‑op in this configuration, preventing the crash while keeping the rest of the workflow intact.

### 3.2 `ServiceScopeLookup`

`PRIVATE_TOKEN_TRANSFER` is now routed to `TokenService.NAME`. Previously it fell through to the default case, resulting in `WritableTokenStore` not being registered in the `WritableStoreFactory` for that transaction. The handler then threw `IllegalArgumentException: No store of the given class is available com.hedera.node.app.service.token.impl.WritableTokenStore`. Mapping the functionality to `TokenService` aligns it with the rest of the HTS operations and unlocks the necessary stores.

---

## 4. End‑to‑end privacy guarantees

With the above pieces in place:

- Private supply and transfer state lives entirely in `PrivateCommitmentRegistry`. Only Pedersen commitments (`Bytes`) plus owner/token IDs are persisted. Amounts and destinations never appear in `ReadableTokenStore`, `TokenRelation`, or record stream outputs.
- Ledger state still enforces association, KYC, and treasury constraints because `WritableTokenRelationStore` lookups occur before commitments are consumed/created. That keeps token semantics consistent with public HTS flows.
- Because we force block stream mode to `RECORDS` and disable gRPC/file streaming, the transfer does not emit block items. Combined with the existing record stream behavior in Solo (which still shows only standard transaction metadata), no observable artifact reveals the private transfer’s amount or recipients.

---

## 5. Integration checklist for engineers

1. **Build consensus locally** (`../hiero-consensus-node`):
   - Install JDK 21 (`brew install openjdk@21`).
   - `cd ../hiero-consensus-node && ./gradlew :app:assemble`.
   - Ensure `hedera-node/data/apps/HederaNode.jar` is updated.
2. **Run the provisioning script** from `solo`:
   ```bash
   KEEP_ENVIRONMENT=1 ./scripts/private-token-e2e.sh
   ```
3. **(Optional) Inspect the running pod** to confirm block stream config and local jar:
   ```bash
   kubectl -n <namespace> exec network-node1-0 -c root-container -- \
     grep '^blockStream' /opt/hgcapp/services-hedera/HapiApp2.0/data/config/application.properties
   ```
4. **Execute the spec**:
   ```bash
   npm run private-token-spec
   ```
5. **Tear down** when finished:
   ```bash
   kind delete cluster --name solo-private-token
   ```

These steps ensure every engineer runs the same patched node binary, with the same block stream settings, producing deterministic private transfer results.

---

## 6. Future considerations

- **Automated detection of stale deployments:** At present the spec will fail with a kubectl error if the cached namespace is gone. A follow‑up could verify namespace existence and instruct the user to rerun the provisioning script.
- **Re‑enabling block streaming:** Once block streaming supports private transfers, we can revert the script to allow `BOTH/FILE_AND_GRPC` and drop the `writeItem()` guard in favor of a proper writer implementation.
- **Hardening commitment persistence:** Today `PrivateCommitmentRegistry` is local JVM state. Persistence/backups (MinIO, etc.) aren’t wired in. Productionizing private transfers would require durable commitment storage and recovery logic.

---

With these changes, Solo can mint and transfer private fungible tokens entirely via the canonical HTS/JS SDK workflows while keeping amounts and destinations off the public ledger. The work demonstrates how a privacy layer can be integrated into Solo’s deployment tooling and services stack with minimal surface area changes.

---

## 7. Operational considerations

- **Consensus throughput:** Forcing `blockStream.streamMode=RECORDS` and `writerMode=FILE` eliminates the block streaming worker and gRPC back‑pressure logic. On a single-node Kind cluster this is inconsequential, but on a multi-node network block nodes would stop receiving block data. Until the block streaming pipeline supports private transfers, deploying this configuration network-wide would effectively disable block ingest/export.
- **State growth:** Private commitments are stored in-memory (`PrivateCommitmentRegistry`). In a production deployment we would need to persist them (e.g., in state or external storage) to avoid data loss on restart. Otherwise any crash/restart would orphan unspent commitments, causing token balances to become unrecoverable.
- **Scheduling/handling cost:** The handler itself performs additional cryptographic checks (Pedersen sums, registry lookups). On a large network with high HTS throughput, profiling is necessary to ensure these checks do not materially increase handle latency. If private transfers become common, consider batching or moving proofs off the critical path.
- **Observability trade-offs:** Disabling the block stream and suppressing public record data limits operators’ ability to audit private tokens. Before enabling this mode on a shared network, provide alternative telemetry (internal metrics, commitment state dumps, etc.) so SREs can still diagnose issues.
