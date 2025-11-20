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



----
Succesful execution of private transaciton logs
----

solo creation 
...
✅ Created accounts saved to file in JSON format: /Users/.../.../GitHub/hedera/solo-private-tokens/workspace/solo/.solo-private-token/one-shot-solo-deployment-353e91d4/accounts.json
For more information on public and private keys see: https://docs.hedera.com/hedera/core-concepts/keys-and-signatures
✅ Deployment name (solo-deployment-353e91d4) saved to file: /Users/patches/Documents/GitHub/hedera/solo-private-tokens/workspace/solo/.solo-private-token/cache/last-one-shot-deployment.txt
Stopping port-forwarder for port [30212]
[2025-11-20T16:17:37-0700] Captured Solo deployment metadata: deployment=solo-deployment-353e91d4, namespace=solo-353e91d4, clusterRef=solo-353e91d4
[2025-11-20T16:17:37-0700] Patching blockStream configuration inside pod network-node1-0...
[2025-11-20T16:17:37-0700] Waiting for network node to return to Ready...
[2025-11-20T16:17:37-0700] Running private token end-to-end spec...
^[
> @hashgraph/solo@0.49.0 private-token-spec
> tsx --no-deprecation --no-warnings examples/tests/privateToken.spec.ts

--- Private Token end-to-end spec ---
Using deployment solo-deployment-353e91d4 in namespace solo-353e91d4 via 127.0.0.1:50211
Created recipient account 0.0.1032
Created private token 0.0.1033
Associated 0.0.1032 with 0.0.1033
Treasury commitment: 02ac0ceffdeb476a4753162283a8b09bfc7517d0236d41744bacba52b64272e71d
Crafted output commitments: recipient 022b4e0a5572db89183fe92381dfda19e09fa31000e5f2958eab914d450abc7905, change 03b26090ceec4d49293f0b52e9d89c29f2b4686ed9db02086c6443cc76400b85bb
PrivateTokenTransfer submitted as 0.0.2@1763680651.377219337
Private token transfer receipt returned SUCCESS
Visible balance for 0.0.2 and 0.0.1033 is 0
Visible balance for 0.0.1032 and 0.0.1033 is 0
Expected failure of public transfer: {"name":"StatusError","status":"NOT_SUPPORTED","transactionId":"0.0.2@1763680651.412955234","message":"receipt for transaction 0.0.2@1763680651.412955234 contained error status NOT_SUPPORTED"}
All checks passed.



---


> 📝 Solo has a new one-shot command!  check it
> out: [Solo User Guide](https://solo.hiero.org/main/docs/step-by-step-guide/#one-shot-deployment), [Solo CLI Commands](https://solo.hiero.org/main/docs/solo-commands/#one-shot-single)

# Solo

[![NPM Version](https://img.shields.io/npm/v/%40hashgraph%2Fsolo?logo=npm)](https://www.npmjs.com/package/@hashgraph/solo)
[![GitHub License](https://img.shields.io/github/license/hiero-ledger/solo?logo=apache\&logoColor=red)](LICENSE)
![node-lts](https://img.shields.io/node/v-lts/%40hashgraph%2Fsolo)
[![Build Application](https://github.com/hiero-ledger/solo/actions/workflows/flow-build-application.yaml/badge.svg)](https://github.com/hiero-ledger/solo/actions/workflows/flow-build-application.yaml)
[![Codacy Grade](https://app.codacy.com/project/badge/Grade/78539e1c1b4b4d4d97277e7eeeab9d09)](https://app.codacy.com/gh/hiero-ledger/solo/dashboard?utm_source=gh\&utm_medium=referral\&utm_content=\&utm_campaign=Badge_grade)
[![Codacy Coverage](https://app.codacy.com/project/badge/Coverage/78539e1c1b4b4d4d97277e7eeeab9d09)](https://app.codacy.com/gh/hiero-ledger/solo/dashboard?utm_source=gh\&utm_medium=referral\&utm_content=\&utm_campaign=Badge_coverage)
[![codecov](https://codecov.io/gh/hashgraph/solo/graph/badge.svg?token=hBkQdB1XO5)](https://codecov.io/gh/hashgraph/solo)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/hiero-ledger/solo/badge)](https://scorecard.dev/viewer/?uri=github.com/hiero-ledger/solo)
[![CII Best Practices](https://bestpractices.coreinfrastructure.org/projects/10697/badge)](https://bestpractices.coreinfrastructure.org/projects/10697)

An opinionated CLI tool to deploy and manage standalone test networks.

## Releases and Requirements

Solo releases are supported for one month after their release date, after which they are no longer maintained.
It is recommended to upgrade to the latest version to benefit from new features and improvements.
Every quarter a version will be designated as LTS (Long-Term Support) and will be supported for three months.

### Current Releases

| Solo Version | Node.js             | Kind       | Solo Chart | Hedera   | Kubernetes | Kubectl    | Helm    | k9s        | Docker Resources         | Release Date | End of Support |
|--------------|---------------------|------------|------------|----------|------------|------------|---------|------------|--------------------------|--------------|----------------|
| 0.49.0       | >= 22.0.0 (lts/jod) | >= v0.26.0 | v0.57.0    | v0.66.0+ | >= v1.27.3 | >= v1.27.3 | v3.14.2 | >= v0.27.4 | Memory >= 12GB, CPU >= 4 | 2025-11-06   | 2025-12-06     |
| 0.48.0 (LTS) | >= 22.0.0 (lts/jod) | >= v0.26.0 | v0.56.0    | v0.66.0+ | >= v1.27.3 | >= v1.27.3 | v3.14.2 | >= v0.27.4 | Memory >= 12GB, CPU >= 4 | 2025-10-24   | 2026-01-24     |

To see a list of legacy releases, please check the [legacy versions documentation page](docs/legacy-versions.md).

### Hardware Requirements

To run a one-node network, you will need to set up Docker Desktop with at least 12GB of memory and 4 CPUs.

![alt text](images/docker-desktop.png)

## Setup

* Install [Node](https://nodejs.org/en/download). You may also use [nvm](https://github.com/nvm-sh/nvm) to manage
  different Node versions locally, some examples:

```
# install specific nodejs version
# nvm install <version>

# install nodejs version 22.0.0
nvm install v22.0.0

# lists available node versions already installed
nvm ls

# switch to selected node version
# nvm use <version>
nvm use v22.0.0

```

* Useful tools:
  * Install [kubectl](https://kubernetes.io/docs/tasks/tools/)
  * Install [k9s](https://k9scli.io/)
  * Install [kind](https://kind.sigs.k8s.io/)

## Install Solo

* Run `npx @hashgraph/solo`

## Documentation

[Getting Started](https://solo.hiero.org/)

## Contributing

Contributions are welcome. Please see
the [contributing guide](https://github.com/hiero-ledger/.github/blob/main/CONTRIBUTING.md) to see how you can get
involved.

## Code of Conduct

This project is governed by
the [Contributor Covenant Code of Conduct](https://github.com/hiero-ledger/.github/blob/main/CODE_OF_CONDUCT.md). By
participating, you are
expected to uphold this code of conduct.

## License

[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
