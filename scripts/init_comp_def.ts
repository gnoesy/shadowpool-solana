import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  getMXEAccAddress,
  getLookupTableAddress,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";

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

async function main() {
  process.env.ARCIUM_CLUSTER_OFFSET = "456";

  const rpcUrl = process.env.ANCHOR_PROVIDER_URL || process.env.RPC_URL || "https://api.devnet.solana.com";
  const walletPath = process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/devnet.json`;
  const conn = new anchor.web3.Connection(rpcUrl, "confirmed");
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

  const idl = JSON.parse(fs.readFileSync("target/idl/shadowpool.json", "utf-8"));
  const program = new anchor.Program(idl, provider) as Program<any>;
  const arciumProgram = getArciumProgram(provider);

  console.log("Program ID:", program.programId.toString());

  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("match_order");
  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeed, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];
  console.log("Comp def PDA:", compDefPDA.toString());

  const mxeAccount = getMXEAccAddress(program.programId);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);

  try {
    const sig = await program.methods
      .initMatchOrderCompDef()
      .accounts({ compDefAccount: compDefPDA, payer: owner.publicKey, mxeAccount, addressLookupTable: lutAddress })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    console.log("init_match_order_comp_def sig:", sig);
  } catch (e: any) {
    console.log("Comp def already exists or error:", e.message || String(e));
  }

  console.log("Uploading circuit with throttled chunk size...");
  const rawCircuit = fs.readFileSync("build/match_order.arcis");
  await uploadCircuit(
    provider,
    "match_order",
    program.programId,
    rawCircuit,
    true,
    5,
    { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" },
  );
  console.log("Circuit uploaded!");
}

main().catch(e => { console.error("Fatal:", e.message || String(e)); process.exit(1); });
