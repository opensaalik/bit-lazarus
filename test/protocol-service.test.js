import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ProtocolService } from "../src/protocol-service.js";
import { EscrowService } from "../src/escrow-service.js";
import { MockLightningClient } from "../src/lightning-client.js";
import { MockWalletAuthVerifier } from "../src/wallet-auth-verifier.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-protocol-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function setupProtocolWithEscrow(tempDir) {
  const lightningClient = new MockLightningClient();
  const escrowService = new EscrowService({
    dataDir: path.join(tempDir, "escrow"),
    lightningClient,
  });
  await escrowService.init();

  const protocolService = new ProtocolService({
    dataDir: path.join(tempDir, "protocol"),
    verifier: new MockWalletAuthVerifier(),
    escrowService,
  });
  await protocolService.init();

  return { lightningClient, escrowService, protocolService };
}

function createSignedNostrEvent(privKey, { kind = 27235, tags = [], content }) {
  const pubkey = Buffer.from(schnorr.getPublicKey(privKey)).toString("hex");
  const created_at = Math.floor(Date.now() / 1000);
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const id = crypto.createHash("sha256").update(serialized).digest("hex");
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), privKey)).toString("hex");

  return { id, pubkey, created_at, kind, tags, content, sig };
}

test("protocol service creates and verifies proof sessions", async () => {
  await withTempDir(async (tempDir) => {
    const service = new ProtocolService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await service.init();

    const session = await service.createVerificationSession({
      verificationSessionId: "session-1",
      bountyId: "bounty-1",
      payerUserId: "payer-1",
      hunterUserId: "hunter-1",
      pieceIndexes: [12, 18],
      torrentInfoHash: "0123456789abcdef0123456789abcdef01234567",
    });

    assert.equal(session.status, "PROOF_CHALLENGE_OPEN");

    const submitted = await service.submitProofArtifacts({
      sessionId: session.id,
      hunterUserId: "hunter-1",
      proofArtifacts: {
        proofs: [{ pieceIndex: 12, round70State: "proof" }],
      },
    });
    assert.equal(submitted.status, "PROOF_SUBMITTED");

    const verified = await service.markProofVerified({
      sessionId: session.id,
      payerUserId: "payer-1",
      verifiedPieceIndexes: [12],
      verificationSummary: "round 70 to 79 state transition matched",
    });
    assert.equal(verified.status, "PROOF_VERIFIED");
    assert.deepEqual(verified.verifiedPieceIndexes, [12]);
  });
});

test("protocol service rejects manual bond status overrides", async () => {
  await withTempDir(async (tempDir) => {
    const service = new ProtocolService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await service.init();

    await service.createVerificationSession({
      verificationSessionId: "session-2",
      bountyId: "bounty-2",
      payerUserId: "payer-2",
      hunterUserId: "hunter-2",
      pieceIndexes: [7, 8],
      torrentInfoHash: "89abcdef0123456789abcdef0123456789abcdef",
    });
    await service.submitProofArtifacts({
      sessionId: "session-2",
      hunterUserId: "hunter-2",
      proofArtifacts: {
        proofs: [{ pieceIndex: 7, round70State: "proof" }],
      },
    });
    await service.markProofVerified({
      sessionId: "session-2",
      payerUserId: "payer-2",
      verifiedPieceIndexes: [7, 8],
    });

    const contract = await service.createDeliveryContract({
      contractId: "contract-2",
      sessionId: "session-2",
      bountyId: "bounty-2",
      payerUserId: "payer-2",
      hunterUserId: "hunter-2",
      payerWalletAddress: "tb1qpayer",
      hunterWalletAddress: "tb1qhunter",
      pieceIndexes: [7, 8],
      rewardEscrowId: "escrow-bounty-2",
    });

    assert.equal(contract.state, "BOND_PENDING");

    await assert.rejects(
      service.updateContractBondEscrows({
        contractId: "contract-2",
        payerUserId: "payer-2",
        payerBondStatus: "FUNDED",
      }),
      /can no longer be set manually/,
    );
  });
});

test("protocol service validates payer-signed piece receipts and marks contracts ready", async () => {
  await withTempDir(async (tempDir) => {
    const { lightningClient, escrowService, protocolService } = await setupProtocolWithEscrow(tempDir);

    const rewardEscrow = await escrowService.createEscrow({
      escrowId: "reward-3",
      buyerId: "payer-3",
      sellerId: "bounty:bounty-3",
      amountSats: 25_000,
    });

    await protocolService.createVerificationSession({
      verificationSessionId: "session-3",
      bountyId: "bounty-3",
      payerUserId: "payer-3",
      hunterUserId: "hunter-3",
      pieceIndexes: [4],
      torrentInfoHash: "fedcba9876543210fedcba9876543210fedcba98",
    });
    await protocolService.submitProofArtifacts({
      sessionId: "session-3",
      hunterUserId: "hunter-3",
      proofArtifacts: {
        proofs: [{ pieceIndex: 4, round70State: "proof" }],
      },
    });
    await protocolService.markProofVerified({
      sessionId: "session-3",
      payerUserId: "payer-3",
      verifiedPieceIndexes: [4],
    });
    const contract = await protocolService.createDeliveryContract({
      contractId: "contract-3",
      sessionId: "session-3",
      bountyId: "bounty-3",
      payerUserId: "payer-3",
      hunterUserId: "hunter-3",
      payerWalletAddress: "tb1qpayer3",
      hunterWalletAddress: "tb1qhunter3",
      pieceIndexes: [4],
      rewardEscrowId: rewardEscrow.id,
    });

    const { payerBondEscrow, hunterBondEscrow } = await protocolService.createBondEscrows({
      contractId: contract.id,
      bondAmountSats: 2500,
    });

    const hunterPayoutInvoice = await lightningClient.createInvoice({
      amountSats: 25_000,
      memo: "hunter payout",
    });
    await protocolService.registerContractPayoutInvoice({
      contractId: contract.id,
      userId: "hunter-3",
      paymentRequest: hunterPayoutInvoice.paymentRequest,
    });

    await lightningClient.acceptHoldInvoice({ paymentHashHex: rewardEscrow.funding.paymentHashHex });
    await lightningClient.acceptHoldInvoice({ paymentHashHex: payerBondEscrow.funding.paymentHashHex });
    await lightningClient.acceptHoldInvoice({ paymentHashHex: hunterBondEscrow.funding.paymentHashHex });
    await protocolService.syncBondStatus({ contractId: contract.id });

    const receiptMessage = "deliveryContractId=contract-3|pieceIndex=4|pieceHash=abc";
    const receipt = await protocolService.submitPieceReceipt({
      contractId: "contract-3",
      payerUserId: "payer-3",
      receiptSignerWalletAddress: "tb1qpayer3",
      pieceIndex: 4,
      receiptMessage,
      receiptSignature: `mock-signature:tb1qpayer3:${receiptMessage}`,
    });

    const updatedContract = protocolService.getDeliveryContract("contract-3");

    assert.equal(receipt.pieceIndex, 4);
    assert.equal(updatedContract.state, "RESOLVED_SUCCESS");
    assert.equal(updatedContract.resolutionReadiness, "RESOLVED");
  });
});

test("protocol service accepts nostr-signed piece receipts", async () => {
  await withTempDir(async (tempDir) => {
    const { lightningClient, escrowService, protocolService } = await setupProtocolWithEscrow(tempDir);
    const payerPrivKey = schnorr.utils.randomSecretKey();
    const payerPubkey = Buffer.from(schnorr.getPublicKey(payerPrivKey)).toString("hex");

    const rewardEscrow = await escrowService.createEscrow({
      escrowId: "reward-4",
      buyerId: "payer-4",
      sellerId: "bounty:bounty-4",
      amountSats: 25_000,
    });

    await protocolService.createVerificationSession({
      verificationSessionId: "session-4",
      bountyId: "bounty-4",
      payerUserId: "payer-4",
      hunterUserId: "hunter-4",
      pieceIndexes: [9],
      torrentInfoHash: "00112233445566778899aabbccddeeff00112233",
    });
    await protocolService.submitProofArtifacts({
      sessionId: "session-4",
      hunterUserId: "hunter-4",
      proofArtifacts: {
        proofs: [{ pieceIndex: 9, round70State: "proof" }],
      },
    });
    await protocolService.markProofVerified({
      sessionId: "session-4",
      payerUserId: "payer-4",
      verifiedPieceIndexes: [9],
    });
    const contract = await protocolService.createDeliveryContract({
      contractId: "contract-4",
      sessionId: "session-4",
      bountyId: "bounty-4",
      payerUserId: "payer-4",
      hunterUserId: "hunter-4",
      payerWalletAddress: payerPubkey,
      hunterWalletAddress: "02hunterwallet",
      pieceIndexes: [9],
      rewardEscrowId: rewardEscrow.id,
    });

    const { payerBondEscrow, hunterBondEscrow } = await protocolService.createBondEscrows({
      contractId: contract.id,
      bondAmountSats: 2500,
    });

    const hunterPayoutInvoice = await lightningClient.createInvoice({
      amountSats: 25_000,
      memo: "hunter payout nostr",
    });
    await protocolService.registerContractPayoutInvoice({
      contractId: contract.id,
      userId: "hunter-4",
      paymentRequest: hunterPayoutInvoice.paymentRequest,
    });

    await lightningClient.acceptHoldInvoice({ paymentHashHex: rewardEscrow.funding.paymentHashHex });
    await lightningClient.acceptHoldInvoice({ paymentHashHex: payerBondEscrow.funding.paymentHashHex });
    await lightningClient.acceptHoldInvoice({ paymentHashHex: hunterBondEscrow.funding.paymentHashHex });
    await protocolService.syncBondStatus({ contractId: contract.id });

    const receiptMessage = "deliveryContractId=contract-4|pieceIndex=9|pieceHash=nostr";
    const receiptSignedEvent = createSignedNostrEvent(payerPrivKey, {
      content: receiptMessage,
      tags: [
        ["bit-lazarus", "piece-receipt"],
        ["contract", contract.id],
        ["piece", "9"],
      ],
    });

    const receipt = await protocolService.submitPieceReceipt({
      contractId: contract.id,
      payerUserId: "payer-4",
      receiptSignerWalletAddress: payerPubkey,
      pieceIndex: 9,
      receiptMessage,
      receiptSignedEvent,
    });

    const updatedContract = protocolService.getDeliveryContract(contract.id);

    assert.equal(receipt.receiptSignature, null);
    assert.deepEqual(receipt.receiptSignedEvent, receiptSignedEvent);
    assert.equal(updatedContract.state, "RESOLVED_SUCCESS");
  });
});

test("torrent-hash delivery contracts resolve successfully when requester and hunter hashes match", async () => {
  await withTempDir(async (tempDir) => {
    const { lightningClient, escrowService, protocolService } = await setupProtocolWithEscrow(tempDir);

    const rewardEscrow = await escrowService.createEscrow({
      escrowId: "reward-5",
      buyerId: "payer-5",
      sellerId: "bounty:bounty-5",
      amountSats: 25_000,
    });

    await protocolService.createVerificationSession({
      verificationSessionId: "session-5",
      bountyId: "bounty-5",
      payerUserId: "payer-5",
      hunterUserId: "hunter-5",
      pieceIndexes: [3],
      torrentInfoHash: "11223344556677889900aabbccddeeff00112233",
    });
    await protocolService.submitProofArtifacts({
      sessionId: "session-5",
      hunterUserId: "hunter-5",
      proofArtifacts: {
        proofs: [{ pieceIndex: 3, round70State: "proof" }],
      },
    });
    await protocolService.markProofVerified({
      sessionId: "session-5",
      payerUserId: "payer-5",
      verifiedPieceIndexes: [3],
    });

    const contract = await protocolService.createDeliveryContract({
      contractId: "contract-5",
      sessionId: "session-5",
      bountyId: "bounty-5",
      payerUserId: "payer-5",
      hunterUserId: "hunter-5",
      payerWalletAddress: "tb1qpayer5",
      hunterWalletAddress: "tb1qhunter5",
      pieceIndexes: [3],
      rewardEscrowId: rewardEscrow.id,
      deliveryVerificationMode: "torrent-hash",
    });

    const { payerBondEscrow, hunterBondEscrow } = await protocolService.createBondEscrows({
      contractId: contract.id,
      bondAmountSats: 2500,
    });

    const hunterPayoutInvoice = await lightningClient.createInvoice({
      amountSats: 25_000,
      memo: "hunter payout hash mode",
    });
    await protocolService.registerContractPayoutInvoice({
      contractId: contract.id,
      userId: "hunter-5",
      paymentRequest: hunterPayoutInvoice.paymentRequest,
    });

    await lightningClient.acceptHoldInvoice({ paymentHashHex: rewardEscrow.funding.paymentHashHex });
    await lightningClient.acceptHoldInvoice({ paymentHashHex: payerBondEscrow.funding.paymentHashHex });
    await lightningClient.acceptHoldInvoice({ paymentHashHex: hunterBondEscrow.funding.paymentHashHex });
    await protocolService.syncBondStatus({ contractId: contract.id });

    await protocolService.registerHunterDeliveryFile({
      contractId: contract.id,
      hunterUserId: "hunter-5",
      fileSha256: "a".repeat(64),
      fileName: "fixture-a.bin",
      fileSize: 1024,
    });

    const updatedContract = await protocolService.confirmRequesterDeliveryFile({
      contractId: contract.id,
      payerUserId: "payer-5",
      fileSha256: "a".repeat(64),
    });

    assert.equal(updatedContract.deliveryVerificationMode, "torrent-hash");
    assert.equal(updatedContract.deliveryHashStatus, "MATCHED");
    assert.equal(updatedContract.state, "RESOLVED_SUCCESS");
    assert.equal(updatedContract.resolutionReadiness, "RESOLVED");
  });
});

test("torrent-hash delivery contracts keep the contract open on hash mismatch", async () => {
  await withTempDir(async (tempDir) => {
    const { lightningClient, escrowService, protocolService } = await setupProtocolWithEscrow(tempDir);

    const rewardEscrow = await escrowService.createEscrow({
      escrowId: "reward-6",
      buyerId: "payer-6",
      sellerId: "bounty:bounty-6",
      amountSats: 25_000,
    });

    await protocolService.createVerificationSession({
      verificationSessionId: "session-6",
      bountyId: "bounty-6",
      payerUserId: "payer-6",
      hunterUserId: "hunter-6",
      pieceIndexes: [1],
      torrentInfoHash: "99887766554433221100ffeeddccbbaa00112233",
    });
    await protocolService.submitProofArtifacts({
      sessionId: "session-6",
      hunterUserId: "hunter-6",
      proofArtifacts: {
        proofs: [{ pieceIndex: 1, round70State: "proof" }],
      },
    });
    await protocolService.markProofVerified({
      sessionId: "session-6",
      payerUserId: "payer-6",
      verifiedPieceIndexes: [1],
    });

    const contract = await protocolService.createDeliveryContract({
      contractId: "contract-6",
      sessionId: "session-6",
      bountyId: "bounty-6",
      payerUserId: "payer-6",
      hunterUserId: "hunter-6",
      payerWalletAddress: "tb1qpayer6",
      hunterWalletAddress: "tb1qhunter6",
      pieceIndexes: [1],
      rewardEscrowId: rewardEscrow.id,
      deliveryVerificationMode: "torrent-hash",
    });

    const { payerBondEscrow, hunterBondEscrow } = await protocolService.createBondEscrows({
      contractId: contract.id,
      bondAmountSats: 2500,
    });

    await lightningClient.acceptHoldInvoice({ paymentHashHex: rewardEscrow.funding.paymentHashHex });
    await lightningClient.acceptHoldInvoice({ paymentHashHex: payerBondEscrow.funding.paymentHashHex });
    await lightningClient.acceptHoldInvoice({ paymentHashHex: hunterBondEscrow.funding.paymentHashHex });
    await protocolService.syncBondStatus({ contractId: contract.id });

    await protocolService.registerHunterDeliveryFile({
      contractId: contract.id,
      hunterUserId: "hunter-6",
      fileSha256: "b".repeat(64),
      fileName: "fixture-a.bin",
      fileSize: 1024,
    });

    const updatedContract = await protocolService.confirmRequesterDeliveryFile({
      contractId: contract.id,
      payerUserId: "payer-6",
      fileSha256: "c".repeat(64),
    });

    assert.equal(updatedContract.state, "DELIVERY_IN_PROGRESS");
    assert.equal(updatedContract.deliveryHashStatus, "MISMATCHED");
    assert.equal(updatedContract.resolutionReadiness, "PENDING_HASH_MISMATCH");
    assert.equal(updatedContract.requesterDeliveryFileSha256, "c".repeat(64));
  });
});

test("protocol service sweeps expired sessions and contracts", async () => {
  await withTempDir(async (tempDir) => {
    let now = "2026-04-11T10:00:00.000Z";
    const service = new ProtocolService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
      now: () => now,
      verificationSessionTtlMs: 1000,
      bondDeadlineMs: 1000,
    });
    await service.init();

    await service.createVerificationSession({
      verificationSessionId: "session-4",
      bountyId: "bounty-4",
      payerUserId: "payer-4",
      hunterUserId: "hunter-4",
      pieceIndexes: [1],
      torrentInfoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    await service.createVerificationSession({
      verificationSessionId: "session-5",
      bountyId: "bounty-5",
      payerUserId: "payer-5",
      hunterUserId: "hunter-5",
      pieceIndexes: [2],
      torrentInfoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    await service.submitProofArtifacts({
      sessionId: "session-5",
      hunterUserId: "hunter-5",
      proofArtifacts: { proofs: [{ pieceIndex: 2, round70State: "proof" }] },
    });
    await service.markProofVerified({
      sessionId: "session-5",
      payerUserId: "payer-5",
      verifiedPieceIndexes: [2],
    });
    await service.createDeliveryContract({
      contractId: "contract-5",
      sessionId: "session-5",
      bountyId: "bounty-5",
      payerUserId: "payer-5",
      hunterUserId: "hunter-5",
      payerWalletAddress: "tb1qpayer5",
      hunterWalletAddress: "tb1qhunter5",
      pieceIndexes: [2],
      rewardEscrowId: "escrow-bounty-5",
    });

    now = "2026-04-11T10:00:03.000Z";
    await service.sweepExpiredStates();

    assert.equal(service.getVerificationSession("session-4").status, "EXPIRED");
    assert.equal(service.getDeliveryContract("contract-5").state, "EXPIRED");
  });
});
