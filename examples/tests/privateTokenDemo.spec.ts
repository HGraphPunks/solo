#!/usr/bin/env tsx
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import crypto from 'node:crypto';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import Long from 'long';
import elliptic from 'elliptic';
import BN from 'bn.js';
import protobuf from 'protobufjs';
import {
  AccountBalanceQuery,
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenId,
  TokenSupplyType,
  TransactionId,
  TransactionReceiptQuery,
  TransferTransaction,
} from '@hiero-ledger/sdk';

const asyncExecFile = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOLO_ROOT = process.env.SOLO_WORKSPACE_ROOT
  ? path.resolve(process.env.SOLO_WORKSPACE_ROOT)
  : process.cwd();
const REPO_ROOT = path.resolve(SOLO_ROOT, '..', '..');
const PROTO_ROOT = path.resolve(
  REPO_ROOT,
  'workspace',
  'hiero-consensus-node',
  'hapi',
  'hedera-protobuf-java-api',
  'src',
  'main',
  'proto',
);
const TRANSACTION_PROTO = [
  path.join(PROTO_ROOT, 'services', 'transaction.proto'),
  path.join(PROTO_ROOT, 'services', 'transaction_contents.proto'),
];
const NETWORK_SERVICE_PROTO = path.join(PROTO_ROOT, 'services', 'network_service.proto');
const NODE_LOG_PATHS = [
  '/opt/hgcapp/services-hedera/HapiApp2.0/output/hgcaa.log',
  '/opt/hgcapp/services-hedera/HapiApp2.0/output/swirlds.log',
];
const DEFAULT_NODE_ID = AccountId.fromString('0.0.3');
const require = createRequire(import.meta.url);
const TokenTypeModule = require(path.join(
  SOLO_ROOT,
  'node_modules',
  '@hiero-ledger',
  'sdk',
  'lib',
  'token',
  'TokenType.js',
));
const TokenType = TokenTypeModule.default ?? TokenTypeModule;
const PRIVATE_TOKEN_TYPE = ensurePrivateTokenType();
const INITIAL_SUPPLY = 1000;
const TRANSFER_AMOUNT = 300;

interface SoloDeploymentInfo {
  namespace: string;
  deploymentName: string;
  grpcEndpoint: string;
  accountsFile: string;
  podName: string;
}

interface OperatorCredentials {
  accountId: AccountId;
  privateKey: PrivateKey;
}

interface CommitmentSplit {
  inputHex: string;
  recipientCommitmentHex: string;
  changeCommitmentHex: string;
  recipientBlindingHex: string;
}

interface WalletRecord {
  commitmentHex: string;
  amount: number;
  blindingHex?: string;
  note?: string;
}

class PrivateWallet {
  private readonly entries = new Map<string, WalletRecord[]>();

  add(owner: AccountId, record: WalletRecord) {
    const key = owner.toString();
    const list = this.entries.get(key) ?? [];
    list.push(record);
    this.entries.set(key, list);
  }

  consume(owner: AccountId, commitmentHex: string) {
    const key = owner.toString();
    const list = this.entries.get(key);
    if (!list) {
      return;
    }
    const index = list.findIndex((entry) => entry.commitmentHex === commitmentHex);
    if (index >= 0) {
      list.splice(index, 1);
      this.entries.set(key, list);
    }
  }

  getTotal(owner: AccountId): number {
    const key = owner.toString();
    const list = this.entries.get(key) ?? [];
    return list.reduce((sum, entry) => sum + entry.amount, 0);
  }

  describe(owner: AccountId): string {
    const key = owner.toString();
    const list = this.entries.get(key) ?? [];
    if (list.length === 0) {
      return `No private commitments tracked for ${key}`;
    }
    const details = list.map((entry, idx) => {
      const blind = entry.blindingHex ? `${entry.blindingHex}` : 'unknown';
      const note = entry.note ? ` (${entry.note})` : '';
      return `    [${idx + 1}] amount=${entry.amount} commitment=${entry.commitmentHex} blinding=${blind}${note}`;
    });
    return [`${key} holds ${this.getTotal(owner)} units privately:`, ...details].join('\n');
  }
}

const EC = elliptic.ec;
const PEDERSEN = new (class PedersenFactory {
  private readonly curve = new EC('secp256k1');
  private readonly n = this.curve.n;
  private readonly H = this.deriveGenerator();

  commit(value: number | bigint, blinding?: BN) {
    const scalar = new BN(value, 10);
    let blind = blinding ?? this.randomScalar();
    if (blind.isZero()) {
      blind = this.randomScalar();
    }
    const point = this.curve.g.mul(scalar).add(this.H.mul(blind));
    return {point, blinding: blind};
  }

  decode(hex: string) {
    return this.curve.curve.decodePoint(Buffer.from(hex, 'hex'));
  }

  encode(point: any): string {
    return Buffer.from(point.encodeCompressed()).toString('hex');
  }

  subtract(a: any, b: any) {
    return a.add(b.neg());
  }

  private randomScalar(): BN {
    let candidate: BN;
    do {
      candidate = new BN(crypto.randomBytes(32));
    } while (candidate.isZero());
    return candidate.umod(this.n);
  }

  private deriveGenerator() {
    const hash = crypto
      .createHash('sha256')
      .update(Buffer.from(this.curve.g.encodeCompressed()))
      .digest();
    let scalar = new BN(hash).umod(this.n);
    if (scalar.isZero()) {
      scalar = new BN(1);
    }
    return this.curve.g.mul(scalar);
  }
})();

async function main() {
  console.log('--- Private Token walkthrough demo ---');
  const solo = await locateSoloDeployment();
  console.log(
    `Using deployment ${solo.deploymentName} in namespace ${solo.namespace} via ${solo.grpcEndpoint}`,
  );
  const operator = await loadOperatorCredentials(solo.accountsFile);
  const client = Client.forNetwork({[solo.grpcEndpoint]: DEFAULT_NODE_ID});
  client.setOperator(operator.accountId, operator.privateKey);
  client.setTransportSecurity(false);
  const wallet = new PrivateWallet();
  console.log('Connected to Solo gRPC endpoint; preparing local private wallet view.\n');

  const newKey = PrivateKey.generateED25519();
  const createAccountRx = await new AccountCreateTransaction()
    .setKey(newKey.publicKey)
    .setInitialBalance(new Hbar(25))
    .execute(client)
    .then((tx) => tx.getReceipt(client));
  const recipientId = createAccountRx.accountId;
  if (!recipientId) {
    throw new Error('Account creation did not return an account ID');
  }
  console.log(`Created recipient account ${recipientId.toString()}`);

  const tokenRx = await new TokenCreateTransaction()
    .setTokenName('Solo Private Token')
    .setTokenSymbol('SPRV')
    .setTreasuryAccountId(operator.accountId)
    .setInitialSupply(INITIAL_SUPPLY)
    .setDecimals(0)
    .setSupplyType(TokenSupplyType.Infinite)
    .setAdminKey(operator.privateKey.publicKey)
    .setSupplyKey(operator.privateKey.publicKey)
    .setTokenType(PRIVATE_TOKEN_TYPE as any)
    .execute(client)
    .then((tx) => tx.getReceipt(client));
  const tokenId = tokenRx.tokenId;
  if (!tokenId) {
    throw new Error('Token creation failed to return a token ID');
  }
  console.log(`Created private token ${tokenId.toString()}`);

  await new TokenAssociateTransaction()
    .setAccountId(recipientId)
    .setTokenIds([tokenId])
    .freezeWith(client)
    .sign(newKey)
    .then((signed) => signed.execute(client))
    .then((tx) => tx.getReceipt(client));
  console.log(`Associated ${recipientId.toString()} with ${tokenId.toString()}`);

  const inputCommitmentHex = await readInitialCommitmentHex(solo, tokenId);
  console.log(`Treasury commitment (minted supply): ${inputCommitmentHex}`);
  wallet.add(operator.accountId, {
    commitmentHex: inputCommitmentHex,
    amount: INITIAL_SUPPLY,
    note: 'Minted during token creation (blinding generated by network)',
  });
  logWalletBalance(wallet, operator.accountId, 'Treasury private view after mint');
  await logNetworkBalance(client, operator.accountId, tokenId, 'Treasury public view after mint');

  const transferAmount = TRANSFER_AMOUNT;
  const split = createCommitmentSplit(inputCommitmentHex, transferAmount);
  console.log(
    `Crafted output commitments: recipient ${split.recipientCommitmentHex}, change ${split.changeCommitmentHex}`,
  );

  const {transactionId} = await submitPrivateTransfer({
    operator,
    tokenId,
    recipientId,
    split,
    client,
    solo,
  });
  console.log(`PrivateTokenTransfer submitted as ${transactionId.toString()}`);
  await new TransactionReceiptQuery().setTransactionId(transactionId).execute(client);
  console.log('Private token transfer receipt returned SUCCESS');
  wallet.consume(operator.accountId, split.inputHex);
  wallet.add(operator.accountId, {
    commitmentHex: split.changeCommitmentHex,
    amount: INITIAL_SUPPLY - transferAmount,
    note: 'Change commitment (value known locally; blinding derived on network)',
  });
  wallet.add(recipientId, {
    commitmentHex: split.recipientCommitmentHex,
    amount: transferAmount,
    blindingHex: split.recipientBlindingHex,
    note: 'Recipient commitment crafted locally',
  });

  await assertZeroBalance(client, operator.accountId, tokenId, 'Treasury public view after transfer');
  await assertZeroBalance(client, recipientId, tokenId, 'Recipient public view after transfer');
  logWalletBalance(wallet, operator.accountId, 'Treasury private view after transfer');
  logWalletBalance(wallet, recipientId, 'Recipient private view after transfer');

  await expectPublicTransferFailure(client, operator.accountId, recipientId, tokenId, transferAmount);

  await client.close();
  console.log('\nDemo complete: private wallet state reflects balances while the public ledger remains at zero.');
}

function ensurePrivateTokenType() {
  const current = (TokenType as any).FungiblePrivate;
  if (current) {
    return current as any;
  }
  const instance = new (TokenType as any)(2);
  (TokenType as any).FungiblePrivate = instance;
  const originalFromCode = TokenType._fromCode.bind(TokenType);
  TokenType._fromCode = (code: number) => (code === 2 ? instance : originalFromCode(code));
  return instance as any;
}

async function locateSoloDeployment(): Promise<SoloDeploymentInfo> {
  const override = process.env.SOLO_ONE_SHOT_DIR;
  const baseDir = override ?? path.join(os.homedir(), '.solo');
  const entries = await fsp.readdir(baseDir, {withFileTypes: true});
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('one-shot'))
    .map((entry) => path.join(baseDir, entry.name))
    .sort();
  if (!dirs.length) {
    throw new Error(`No one-shot Solo deployment directory found under ${baseDir}`);
  }
  const selectedDir = override ?? dirs[dirs.length - 1];
  const notes = await fsp.readFile(path.join(selectedDir, 'notes'), 'utf8');
  const namespace = matchLine(notes, /Namespace Name:\s*(\S+)/i);
  const deploymentName = matchLine(notes, /Deployment Name:\s*(\S+)/i);
  const forwards = await fsp.readFile(path.join(selectedDir, 'forwards'), 'utf8');
  const grpcPort = forwards.match(/gRPC port forward enabled on localhost:(\d+)/i)?.[1] ?? '50211';
  const podName = (await runCmd('kubectl', [
    '-n',
    namespace,
    'get',
    'pods',
    '-l',
    'solo.hedera.com/type=network-node',
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ])).trim();
  const accountsFile = path.join(selectedDir, 'accounts.json');
  return {
    namespace,
    deploymentName,
    grpcEndpoint: `127.0.0.1:${grpcPort}`,
    accountsFile,
    podName,
  };
}

async function loadOperatorCredentials(accountsFile: string): Promise<OperatorCredentials> {
  const contents = await fsp.readFile(accountsFile, 'utf8');
  const parsed = JSON.parse(contents);
  const operatorEntry = parsed.systemAccounts?.[0];
  if (!operatorEntry) {
    throw new Error(`No operator entry found inside ${accountsFile}`);
  }
  return {
    accountId: AccountId.fromString(operatorEntry.accountId),
    privateKey: PrivateKey.fromString(operatorEntry.privateKey),
  };
}

async function readInitialCommitmentHex(solo: SoloDeploymentInfo, tokenId: TokenId): Promise<string> {
  const searchToken = tokenId.toString();
  for (const logPath of NODE_LOG_PATHS) {
    const command = `grep -F "Initial private supply" ${logPath} | tail -n 50`;
    let output: string;
    try {
      output = await runCmd('kubectl', [
        '-n',
        solo.namespace,
        'exec',
        solo.podName,
        '-c',
        'root-container',
        '--',
        'sh',
        '-c',
        command,
      ]);
    } catch (error) {
      // ignore missing file/grep failures and try next log
      continue;
    }
    const lines = output.split('\n');
    for (const line of lines.reverse()) {
      if (!line.includes(searchToken)) {
        continue;
      }
      const match = line.match(/token\s+(\d+\.\d+\.\d+)\s+via\s+([0-9a-f]+)/i);
      if (match && match[1] === searchToken) {
        return match[2];
      }
    }
  }
  throw new Error(`Unable to find commitment for ${tokenId.toString()} inside node logs`);
}

function createCommitmentSplit(inputHex: string, transferAmount: number): CommitmentSplit {
  const inputPoint = PEDERSEN.decode(inputHex);
  const recipient = PEDERSEN.commit(transferAmount);
  const change = PEDERSEN.subtract(inputPoint, recipient.point);
  return {
    inputHex,
    recipientCommitmentHex: PEDERSEN.encode(recipient.point),
    changeCommitmentHex: PEDERSEN.encode(change),
    recipientBlindingHex: recipient.blinding.toArrayLike(Buffer, 'be', 32).toString('hex'),
  };
}

async function submitPrivateTransfer(args: {
  operator: OperatorCredentials;
  tokenId: TokenId;
  recipientId: AccountId;
  split: CommitmentSplit;
  client: Client;
  solo: SoloDeploymentInfo;
}): Promise<{transactionId: TransactionId}> {
  const {operator, tokenId, recipientId, split, solo} = args;
  const transactionId = TransactionId.generate(operator.accountId);
  const txBody = buildPrivateTransferBody({
    tokenId,
    recipientId,
    split,
    transactionId,
  });
  const bodyBytes = txBody.type.encode(txBody.message).finish();
  const signature = operator.privateKey.sign(bodyBytes);
  const sigMap = buildSignatureMap(operator.privateKey.publicKey.toBytesRaw(), signature);
  const signed = buildSignedTransaction(bodyBytes, sigMap);
  const signedBytes = signed.type.encode(signed.message).finish();
  const payload = buildTransactionEnvelope(signedBytes);

  const protoClient = createNetworkServiceClient(solo.grpcEndpoint);
  await new Promise<unknown>((resolve, reject) => {
    protoClient.uncheckedSubmit(payload, (err: grpc.ServiceError | null, value) => {
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    });
  });
  protoClient.close();
  return {transactionId};
}

function buildPrivateTransferBody(args: {
  tokenId: TokenId;
  recipientId: AccountId;
  split: CommitmentSplit;
  transactionId: TransactionId;
}) {
  const {tokenId, recipientId, split, transactionId} = args;
  const root = loadTransactionProto();
  const TransactionBody = root.lookupType('proto.TransactionBody');
  const PrivateTokenTransfer = root.lookupType('proto.PrivateTokenTransferTransactionBody');
  const privateBody = PrivateTokenTransfer.create({
    token: tokenId._toProtobuf(),
    inputs: [Buffer.from(split.inputHex, 'hex')],
    outputs: [
      {owner: recipientId._toProtobuf(), commitment: Buffer.from(split.recipientCommitmentHex, 'hex')},
      {owner: transactionId.accountId._toProtobuf(), commitment: Buffer.from(split.changeCommitmentHex, 'hex')},
    ],
    zkProof: new Uint8Array(),
  });
  const message = TransactionBody.create({
    transactionID: transactionId._toProtobuf(),
    nodeAccountID: DEFAULT_NODE_ID._toProtobuf(),
    transactionFee: Long.fromNumber(100_000_000),
    transactionValidDuration: {seconds: Long.fromNumber(120), nanos: 0},
    memo: 'private-token-transfer',
    privateTokenTransfer: privateBody,
  });
  return {type: TransactionBody, message};
}

function buildSignatureMap(pubKey: Uint8Array, signature: Uint8Array) {
  const root = loadTransactionProto();
  const SignatureMap = root.lookupType('proto.SignatureMap');
  return {
    type: SignatureMap,
    message: SignatureMap.create({
      sigPair: [
        {
          pubKeyPrefix: Buffer.from(pubKey),
          ed25519: Buffer.from(signature),
        },
      ],
    }),
  };
}

function buildSignedTransaction(bodyBytes: Uint8Array, sigMap: {type: protobuf.Type; message: protobuf.Message<{}>}) {
  const root = loadTransactionProto();
  const SignedTransaction = root.lookupType('proto.SignedTransaction');
  return {
    type: SignedTransaction,
    message: SignedTransaction.create({bodyBytes, sigMap: sigMap.message}),
  };
}

function buildTransactionEnvelope(signedTransactionBytes: Uint8Array) {
  const root = loadTransactionProto();
  const Transaction = root.lookupType('proto.Transaction');
  return Transaction.create({signedTransactionBytes});
}

function createNetworkServiceClient(endpoint: string) {
  const packageDefinition = protoLoader.loadSync([...TRANSACTION_PROTO, NETWORK_SERVICE_PROTO], {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: false,
    oneofs: true,
    includeDirs: protoIncludeDirs(),
  });
  const descriptor = grpc.loadPackageDefinition(packageDefinition) as any;
  const NetworkService = descriptor.proto.NetworkService;
  return new NetworkService(endpoint, grpc.credentials.createInsecure());
}

let cachedProtoRoot: protobuf.Root | null = null;
function loadTransactionProto() {
  if (cachedProtoRoot) {
    return cachedProtoRoot;
  }
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => {
    for (const dir of protoIncludeDirs()) {
      const candidate = path.join(dir, target);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    if (origin) {
      const candidate = path.join(path.dirname(origin), target);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return target;
  };
  cachedProtoRoot = protobuf.loadSync(TRANSACTION_PROTO, root);
  return cachedProtoRoot;
}

function protoIncludeDirs() {
  return [
    PROTO_ROOT,
    path.join(PROTO_ROOT, 'services'),
    path.join(PROTO_ROOT, 'platform'),
    path.join(PROTO_ROOT, 'streams'),
    path.join(PROTO_ROOT, 'fees'),
    path.join(PROTO_ROOT, 'sdk'),
    path.join(PROTO_ROOT, 'block'),
  ];
}

async function assertZeroBalance(
  client: Client,
  accountId: AccountId,
  tokenId: TokenId,
  label?: string,
) {
  const value = await logNetworkBalance(
    client,
    accountId,
    tokenId,
    label ?? `${accountId.toString()} public view`,
  );
  if (value !== 0) {
    throw new Error(`Expected zero visible balance for ${accountId.toString()}`);
  }
}

async function logNetworkBalance(
  client: Client,
  accountId: AccountId,
  tokenId: TokenId,
  label: string,
): Promise<number> {
  const balance = await new AccountBalanceQuery().setAccountId(accountId).execute(client);
  const value = normalizeLedgerBalance(balance.tokens?.get(tokenId) ?? 0);
  console.log(`[Public Ledger] ${label}: ${value}`);
  return value;
}

function logWalletBalance(wallet: PrivateWallet, accountId: AccountId, label: string) {
  console.log(`[Private Wallet] ${label}:\n${wallet.describe(accountId)}\n`);
}

function normalizeLedgerBalance(raw: number | Long | undefined): number {
  if (typeof raw === 'number') {
    return raw;
  }
  if (raw && typeof raw.toNumber === 'function') {
    return raw.toNumber();
  }
  return Number(raw ?? 0);
}

async function expectPublicTransferFailure(
  client: Client,
  operatorId: AccountId,
  recipientId: AccountId,
  tokenId: TokenId,
  amount: number,
) {
  try {
    await new TransferTransaction()
      .addTokenTransfer(tokenId, operatorId, -amount)
      .addTokenTransfer(tokenId, recipientId, amount)
      .execute(client)
      .then((tx) => tx.getReceipt(client));
    throw new Error('Public transfer unexpectedly succeeded');
  } catch (error) {
    const message = String(error);
    if (!message.includes('NOT_SUPPORTED')) {
      throw error;
    }
    console.log('Expected failure of public transfer:', message);
  }
}

function matchLine(source: string, pattern: RegExp) {
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Missing pattern ${pattern} in source`);
  }
  return match[1];
}

async function runCmd(command: string, args: string[]) {
  const {stdout, stderr} = await asyncExecFile(command, args, {encoding: 'utf8'});
  if (stderr?.length) {
    return stdout;
  }
  return stdout;
}

void main().catch((err) => {
  console.error('Private token spec failed:', err);
  process.exitCode = 1;
});
