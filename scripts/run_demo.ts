/**
 * shadowpool-solana demo
 * Confidential dark-pool style order matching via Arcium MXE.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getClockAccAddress,
  getCompDefAccOffset,
  getClusterAccAddress,
  getCompDefAccAddress,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getFeePoolAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  x25519,
} from "@arcium-hq/client";

const PROGRAM_ID = new PublicKey("9Pwn25dobepgerar43d2GgXuNmKFcYYEoJwMjULwakUG");
const SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");
const EVIDENCE_LOG = path.join(__dirname, "../evidence/mxe_runs.jsonl");

function log(event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ event, ...data, ts: new Date().toISOString() });
  fs.mkdirSync(path.dirname(EVIDENCE_LOG), { recursive: true });
  fs.appendFileSync(EVIDENCE_LOG, line + "\n");
  console.log(line);
}

async function withRpcRetry<T>(fn: () => Promise<T>, retries = 8): Promise<T> {
  let delayMs = 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const message = error?.message || String(error);
      if (attempt >= retries || !message.includes("429")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
}

async function confirmSignatureByPolling(
  connection: anchor.web3.Connection,
  signature: string,
  lastValidBlockHeight: number,
  commitment: anchor.web3.Commitment,
): Promise<void> {
  for (;;) {
    const [{ value: statuses }, currentBlockHeight] = await Promise.all([
      withRpcRetry(() => connection.getSignatureStatuses([signature])),
      withRpcRetry(() => connection.getBlockHeight(commitment)),
    ]);

    const status = statuses[0];
    if (status?.err) {
      throw new Error(`Signature ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (
      status &&
      (status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized")
    ) {
      return;
    }
    if (currentBlockHeight > lastValidBlockHeight) {
      throw new Error(`Signature ${signature} has expired: block height exceeded.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function sendAndConfirmCompat(
  provider: anchor.AnchorProvider,
  tx: anchor.web3.Transaction,
  signers: anchor.web3.Signer[] = [],
  opts: anchor.web3.ConfirmOptions = {},
): Promise<string> {
  const commitment = opts.commitment || opts.preflightCommitment || "confirmed";
  const latest = await withRpcRetry(() =>
    provider.connection.getLatestBlockhash({ commitment }),
  );

  tx.feePayer ||= provider.publicKey;
  tx.recentBlockhash ||= latest.blockhash;
  tx.lastValidBlockHeight ||= latest.lastValidBlockHeight;

  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  const signed = await provider.wallet.signTransaction(tx);
  const sig = await withRpcRetry(() =>
    provider.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: opts.skipPreflight,
      preflightCommitment: opts.preflightCommitment || commitment,
      maxRetries: opts.maxRetries,
    }),
  );

  await withRpcRetry(() =>
    confirmSignatureByPolling(
      provider.connection,
      sig,
      tx.lastValidBlockHeight!,
      commitment,
    ),
  );

  return sig;
}

async function getMxePublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  retries = 8,
  delayMs = 1000,
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const key = await getMXEPublicKey(provider, programId);
    if (key) {
      return key;
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`MXE public key unavailable for program ${programId.toString()}`);
}

async function main() {
  process.env.ARCIUM_CLUSTER_OFFSET = "456";

  const walletPath = process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/devnet.json`;
  const conn = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || process.env.RPC_URL || "https://api.devnet.solana.com",
    {
      commitment: "confirmed",
      wsEndpoint: process.env.WS_RPC_URL,
    },
  );
  const owner = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath).toString())),
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(owner), {
    commitment: "confirmed",
    skipPreflight: true,
  });
  provider.sendAndConfirm = (
    tx: anchor.web3.Transaction,
    signers?: anchor.web3.Signer[],
    opts?: anchor.web3.ConfirmOptions,
  ) => sendAndConfirmCompat(provider, tx, signers || [], opts || {});
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/shadowpool.json"), "utf-8"));
  const program = new anchor.Program(idl, provider) as anchor.Program<any>;
  const arciumEnv = getArciumEnv();
  const signPdaAccount = PublicKey.findProgramAddressSync([SIGN_PDA_SEED], PROGRAM_ID)[0];

  log("demo_start", {
    program: PROGRAM_ID.toString(),
    wallet: owner.publicKey.toString(),
    description: "Encrypted dark-pool order match via MXE",
  });

  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const mxePublicKey = await getMxePublicKeyWithRetry(provider, PROGRAM_ID);

  const bid = BigInt(Math.floor(Math.random() * 200) + 100);
  const ask = BigInt(Math.floor(Math.random() * 200) + 50);
  log("orders_prepared", {
    bid: "encrypted",
    ask: "encrypted",
    note: `Local sample prices prepared for private match (${bid.toString()}, ${ask.toString()})`,
  });

  const nonce = randomBytes(16);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  const ciphertext = cipher.encrypt([bid, ask], nonce);

  const computationOffset = new anchor.BN(randomBytes(8), "hex");
  const clusterOffset = arciumEnv.arciumClusterOffset;

  try {
    const sig = await program.methods
      .matchOrder(
        computationOffset,
        Array.from(ciphertext[0]),
        Array.from(ciphertext[1]),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString()),
      )
      .accountsPartial({
        payer: owner.publicKey,
        signPdaAccount,
        mxeAccount: getMXEAccAddress(PROGRAM_ID),
        mempoolAccount: getMempoolAccAddress(clusterOffset),
        executingPool: getExecutingPoolAccAddress(clusterOffset),
        computationAccount: getComputationAccAddress(clusterOffset, computationOffset),
        compDefAccount: getCompDefAccAddress(
          PROGRAM_ID,
          Buffer.from(getCompDefAccOffset("match_order")).readUInt32LE(),
        ),
        clusterAccount: getClusterAccAddress(clusterOffset),
        poolAccount: getFeePoolAccAddress(),
        clockAccount: getClockAccAddress(),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    log("match_order_queued", {
      sig,
      explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    });

    const finalizeSig = await Promise.race([
      awaitComputationFinalization(provider, computationOffset, PROGRAM_ID, "confirmed"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 90_000)),
    ]);

    log("match_order_success", {
      queueSig: sig,
      finalizeSig,
      clusterOffset,
    });
  } catch (e: any) {
    log("match_order_fail", {
      message: e.message || String(e),
      logs: e.logs || [],
      code: e.code,
      raw: (() => { try { return JSON.stringify(e); } catch { return String(e); } })(),
    });
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ event: "fatal", message: e.message }));
  process.exit(1);
});
