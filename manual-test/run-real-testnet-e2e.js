import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startServer } from "../src/server.js";
import { generatePieceProof, parseTorrentMetadata, verifyPieceProofFromRound } from "../src/torrent-piece-proof.js";

const execFileAsync = promisify(execFile);

const bitcoinCliPath = process.env.BITCOIN_CLI_PATH ?? "bitcoin-cli";
const bitcoinCliDatadir = process.env.BITCOIN_CLI_DATADIR ?? path.resolve(".bitcoin-testnet");
const bitcoinCliChain = process.env.BITCOIN_CLI_CHAIN ?? "testnet4";
const payerWalletName = process.env.E2E_PAYER_WALLET ?? "bit-lazarus-e2e-payer";
const hunterWalletName = process.env.E2E_HUNTER_WALLET ?? "bit-lazarus-e2e-hunter";
const hunterPayoutPaymentRequestFromEnv = process.env.E2E_HUNTER_PAYOUT_PAYMENT_REQUEST ?? null;
const host = "127.0.0.1";
const port = Number.parseInt(process.env.E2E_PORT ?? "3100", 10);
const fixtureRoot = path.resolve("manual-test");

function logStep(message) {
  console.log(`\n[step] ${message}`);
}

function reportResult(name, status, details = {}) {
  return { name, status, details };
}

async function runBitcoinCli(args) {
  const baseArgs = [`-datadir=${bitcoinCliDatadir}`, `-${bitcoinCliChain}`];
  const { stdout } = await execFileAsync(bitcoinCliPath, [...baseArgs, ...args]);
  return stdout.trim();
}

async function ensureWallet(walletName) {
  const listOutput = await runBitcoinCli(["listwallets"]);
  const loadedWallets = listOutput ? JSON.parse(listOutput) : [];

  if (!loadedWallets.includes(walletName)) {
    try {
      await runBitcoinCli(["loadwallet", walletName]);
    } catch (_error) {
      await runBitcoinCli(["createwallet", walletName]);
    }
  }
}

async function assertBitcoinRpcReady() {
  try {
    const blockchainInfo = await runBitcoinCli(["getblockchaininfo"]);
    const parsed = JSON.parse(blockchainInfo);

    return {
      chain: parsed.chain,
      blocks: parsed.blocks,
      headers: parsed.headers,
    };
  } catch (error) {
    throw new Error(
      `bitcoin-cli could not reach the local ${bitcoinCliChain} RPC. Start bitcoind with the same datadir first. Original error: ${error.message}`,
    );
  }
}

async function getLegacyAddress(walletName) {
  return runBitcoinCli([`-rpcwallet=${walletName}`, "getnewaddress", "", "legacy"]);
}

async function signMessage(walletName, walletAddress, message) {
  return runBitcoinCli([`-rpcwallet=${walletName}`, "signmessage", walletAddress, message]);
}

async function requestJson(url, { method = "GET", body, token } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `request failed with status ${response.status}`);
  }

  return payload;
}

async function authenticateUser(baseUrl, walletName, displayName) {
  await ensureWallet(walletName);
  const walletAddress = await getLegacyAddress(walletName);
  const challengePayload = await requestJson(`${baseUrl}/auth/challenges`, {
    method: "POST",
    body: { walletAddress },
  });
  const signature = await signMessage(walletName, walletAddress, challengePayload.challenge.message);
  const verifyPayload = await requestJson(`${baseUrl}/auth/verify`, {
    method: "POST",
    body: {
      challengeId: challengePayload.challenge.id,
      walletAddress,
      signature,
      displayName,
    },
  });

  return {
    walletAddress,
    token: verifyPayload.session.token,
    user: verifyPayload.user,
  };
}

async function loadFixture(name) {
  const torrentBuffer = await readFile(path.join(fixtureRoot, "torrents", `${name}.torrent`));
  const contentBuffer = await readFile(path.join(fixtureRoot, "content", `${name}.bin`));
  const metadata = parseTorrentMetadata(torrentBuffer);

  return {
    torrentBuffer,
    contentBuffer,
    metadata,
  };
}

async function main() {
  const results = [];
  let tempDataDir;
  let serverHandle;

  try {
    logStep("loading real torrent fixtures");
    const fixture = await loadFixture("fixture-a");
    results.push(
      reportResult("fixture-load", "PASS", {
        infoHash: fixture.metadata.infoHash,
        pieceCount: fixture.metadata.pieceCount,
      }),
    );

    logStep("checking local bitcoin core rpc");
    const rpcInfo = await assertBitcoinRpcReady();
    results.push(reportResult("bitcoin-rpc", "PASS", rpcInfo));

    logStep("starting server on a fresh data directory");
    tempDataDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-e2e-"));
    const previousEnv = {
      WALLET_AUTH_BACKEND: process.env.WALLET_AUTH_BACKEND,
      BITCOIN_CLI_PATH: process.env.BITCOIN_CLI_PATH,
      BITCOIN_CLI_DATADIR: process.env.BITCOIN_CLI_DATADIR,
      BITCOIN_CLI_CHAIN: process.env.BITCOIN_CLI_CHAIN,
      LIGHTNING_BACKEND: process.env.LIGHTNING_BACKEND,
    };

    process.env.WALLET_AUTH_BACKEND = "bitcoin-cli";
    process.env.BITCOIN_CLI_PATH = bitcoinCliPath;
    process.env.BITCOIN_CLI_DATADIR = bitcoinCliDatadir;
    process.env.BITCOIN_CLI_CHAIN = bitcoinCliChain;
    process.env.LIGHTNING_BACKEND = process.env.LIGHTNING_BACKEND ?? "mock";

    serverHandle = await startServer({
      host,
      port,
      dataDir: tempDataDir,
      bountyEscrowSyncIntervalMs: 60_000,
    });

    process.env.WALLET_AUTH_BACKEND = previousEnv.WALLET_AUTH_BACKEND;
    process.env.BITCOIN_CLI_PATH = previousEnv.BITCOIN_CLI_PATH;
    process.env.BITCOIN_CLI_DATADIR = previousEnv.BITCOIN_CLI_DATADIR;
    process.env.BITCOIN_CLI_CHAIN = previousEnv.BITCOIN_CLI_CHAIN;
    process.env.LIGHTNING_BACKEND = previousEnv.LIGHTNING_BACKEND;

    const baseUrl = `http://${host}:${port}`;
    results.push(reportResult("server-start", "PASS", { baseUrl, dataDir: tempDataDir }));

    logStep("authenticating payer and hunter with real bitcoin-cli signatures");
    const payer = await authenticateUser(baseUrl, payerWalletName, "E2E Payer");
    const hunter = await authenticateUser(baseUrl, hunterWalletName, "E2E Hunter");
    results.push(
      reportResult("wallet-auth", "PASS", {
        payerWalletAddress: payer.walletAddress,
        hunterWalletAddress: hunter.walletAddress,
      }),
    );

    logStep("creating a bounty from the real fixture info hash");
    const bountyPayload = await requestJson(`${baseUrl}/bounties`, {
      method: "POST",
      token: payer.token,
      body: {
        title: "Fixture A recovery",
        description: "Automated real-signature proof flow",
        torrentInfoHash: fixture.metadata.infoHash,
        torrentName: "fixture-a.torrent",
        rewardSats: 25_000,
        missingPieces: [0],
        tags: ["e2e", "fixture-a"],
      },
    });
    let bounty = bountyPayload.bounty;

    if (serverHandle.escrowService.lightningClient.acceptHoldInvoice) {
      await serverHandle.escrowService.lightningClient.acceptHoldInvoice({
        paymentHashHex: bounty.funding.paymentHashHex,
      });
      const syncPayload = await requestJson(`${baseUrl}/bounties/${bounty.id}/sync-escrow`, {
        method: "POST",
        token: payer.token,
      });
      bounty = syncPayload.bounty;
    }

    results.push(
      reportResult("bounty-create", bounty.status === "OPEN" ? "PASS" : "WARN", {
        bountyId: bounty.id,
        escrowId: bounty.escrowId,
        escrowStatus: bounty.escrowStatus,
        fundingMode:
          serverHandle.escrowService.lightningClient.acceptHoldInvoice ? "mock-funded-for-e2e" : "external-lightning",
      }),
    );

    if (bounty.status !== "OPEN") {
      throw new Error("bounty did not reach OPEN status; real Lightning funding is required for further protocol steps");
    }

    logStep("joining the bounty as the hunter");
    await requestJson(`${baseUrl}/bounties/${bounty.id}/hunt`, {
      method: "POST",
      token: hunter.token,
    });
    results.push(reportResult("bounty-hunt", "PASS", { bountyId: bounty.id }));

    logStep("opening a verification session");
    const sessionPayload = await requestJson(`${baseUrl}/bounties/${bounty.id}/verification-sessions`, {
      method: "POST",
      token: hunter.token,
      body: {
        pieceIndexes: [0],
      },
    });
    let session = sessionPayload.verificationSession;
    results.push(reportResult("verification-session", "PASS", { sessionId: session.id }));

    logStep("generating a real piece proof from fixture content");
    const proof = await generatePieceProof({
      torrentBuffer: fixture.torrentBuffer,
      contentBuffer: fixture.contentBuffer,
      pieceIndex: 0,
      revealRound: 70,
    });
    const localVerification = verifyPieceProofFromRound({
      pieceHashHex: proof.pieceHashHex,
      revealRound: proof.revealRound,
      preBlockState: proof.preBlockState,
      roundRevealState: proof.roundRevealState,
      remainingScheduleWords: proof.remainingScheduleWords,
    });

    if (!localVerification.valid) {
      throw new Error("local proof verification failed");
    }

    results.push(
      reportResult("piece-proof", "PASS", {
        pieceIndex: proof.pieceIndex,
        pieceHashHex: proof.pieceHashHex,
      }),
    );

    logStep("submitting the proof artifacts through the API");
    const submittedSessionPayload = await requestJson(`${baseUrl}/verification-sessions/${session.id}/proof`, {
      method: "POST",
      token: hunter.token,
      body: {
        proofArtifacts: {
          torrentInfoHash: fixture.metadata.infoHash,
          torrentName: fixture.metadata.name,
          proofs: [proof],
        },
      },
    });
    session = submittedSessionPayload.verificationSession;
    results.push(reportResult("proof-submit", session.status === "PROOF_SUBMITTED" ? "PASS" : "FAIL", { status: session.status }));

    logStep("recording payer-side proof verification");
    const verifiedSessionPayload = await requestJson(`${baseUrl}/verification-sessions/${session.id}/verify`, {
      method: "POST",
      token: payer.token,
      body: {
        verifiedPieceIndexes: [0],
        verificationSummary: "automated e2e verification",
      },
    });
    session = verifiedSessionPayload.verificationSession;
    results.push(reportResult("proof-verify", session.status === "PROOF_VERIFIED" ? "PASS" : "FAIL", { status: session.status }));

    logStep("creating a delivery contract");
    const contractPayload = await requestJson(`${baseUrl}/verification-sessions/${session.id}/contracts`, {
      method: "POST",
      token: payer.token,
      body: {
        pieceIndexes: [0],
      },
    });
    let contract = contractPayload.contract;
    const payerBondEscrow = contractPayload.payerBondEscrow;
    const hunterBondEscrow = contractPayload.hunterBondEscrow;
    results.push(reportResult("contract-create", contract.state === "BOND_PENDING" ? "PASS" : "FAIL", { contractId: contract.id, state: contract.state }));

    logStep("registering the hunter payout invoice");
    let hunterPayoutPaymentRequest = hunterPayoutPaymentRequestFromEnv;

    if (!hunterPayoutPaymentRequest && serverHandle.escrowService.lightningClient.createInvoice) {
      const payoutInvoice = await serverHandle.escrowService.lightningClient.createInvoice({
        amountSats: bounty.rewardSats + bounty.bondAmountSats,
        memo: `hunter payout for ${contract.id}`,
      });
      hunterPayoutPaymentRequest = payoutInvoice.paymentRequest;
    }

    if (!hunterPayoutPaymentRequest) {
      throw new Error("hunter payout invoice is required; set E2E_HUNTER_PAYOUT_PAYMENT_REQUEST for real Lightning runs");
    }

    await requestJson(`${baseUrl}/contracts/${contract.id}/payout-invoice`, {
      method: "POST",
      token: hunter.token,
      body: {
        paymentRequest: hunterPayoutPaymentRequest,
      },
    });

    logStep("funding both bonds");
    if (serverHandle.escrowService.lightningClient.acceptHoldInvoice) {
      await serverHandle.escrowService.lightningClient.acceptHoldInvoice({
        paymentHashHex: payerBondEscrow.funding.paymentHashHex,
      });
      await serverHandle.escrowService.lightningClient.acceptHoldInvoice({
        paymentHashHex: hunterBondEscrow.funding.paymentHashHex,
      });
    } else {
      throw new Error("real Lightning bond funding must be performed externally before the bond sync step");
    }

    const fundedContractPayload = await requestJson(`${baseUrl}/contracts/${contract.id}/sync-bonds`, {
      method: "POST",
      token: payer.token,
    });
    contract = fundedContractPayload.contract;
    results.push(reportResult("bond-fund", contract.state === "DELIVERY_IN_PROGRESS" ? "PASS" : "FAIL", { state: contract.state }));

    logStep("signing and submitting a real payer receipt");
    const receiptMessage = `deliveryContractId=${contract.id}|pieceIndex=0|pieceHash=${fixture.metadata.pieces[0]}`;
    const receiptSignature = await signMessage(payerWalletName, payer.walletAddress, receiptMessage);
    const receiptPayload = await requestJson(`${baseUrl}/contracts/${contract.id}/receipts`, {
      method: "POST",
      token: payer.token,
      body: {
        pieceIndex: 0,
        receiptMessage,
        receiptSignature,
        receiptSignerWalletAddress: payer.walletAddress,
      },
    });
    contract = receiptPayload.contract;
    results.push(
      reportResult(
        "receipt-submit",
        contract.state === "RESOLVED_SUCCESS" && contract.resolutionReadiness === "RESOLVED"
          ? "PASS"
          : "FAIL",
        {
          state: contract.state,
          resolutionReadiness: contract.resolutionReadiness,
        },
      ),
    );

    console.log(
      `\n[summary] ${results.filter((result) => result.status === "PASS").length}/${results.length} checks passed`,
    );
    console.log(JSON.stringify({ ok: true, results }, null, 2));
  } catch (error) {
    results.push(reportResult("runner", "FAIL", { message: error.message }));
    console.error(`\n[summary] automated e2e run failed: ${error.message}`);
    console.error(JSON.stringify({ ok: false, results }, null, 2));
    process.exitCode = 1;
  } finally {
    if (serverHandle?.server) {
      await new Promise((resolve, reject) => {
        serverHandle.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }).catch(() => {});
    }

    if (tempDataDir) {
      await rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

await main();
