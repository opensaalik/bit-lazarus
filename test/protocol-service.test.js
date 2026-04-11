import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { ProtocolService } from "../src/protocol-service.js";
import { MockWalletAuthVerifier } from "../src/wallet-auth-verifier.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-protocol-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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

test("protocol service creates delivery contracts and records funded bonds", async () => {
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

    const funded = await service.updateContractBondEscrows({
      contractId: "contract-2",
      payerUserId: "payer-2",
      payerBondEscrowId: "escrow-payer-bond",
      hunterBondEscrowId: "escrow-hunter-bond",
      payerBondStatus: "FUNDED",
      hunterBondStatus: "FUNDED",
    });

    assert.equal(funded.state, "DELIVERY_IN_PROGRESS");
  });
});

test("protocol service validates payer-signed piece receipts and marks contracts ready", async () => {
  await withTempDir(async (tempDir) => {
    const service = new ProtocolService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await service.init();

    await service.createVerificationSession({
      verificationSessionId: "session-3",
      bountyId: "bounty-3",
      payerUserId: "payer-3",
      hunterUserId: "hunter-3",
      pieceIndexes: [4],
      torrentInfoHash: "fedcba9876543210fedcba9876543210fedcba98",
    });
    await service.submitProofArtifacts({
      sessionId: "session-3",
      hunterUserId: "hunter-3",
      proofArtifacts: {
        proofs: [{ pieceIndex: 4, round70State: "proof" }],
      },
    });
    await service.markProofVerified({
      sessionId: "session-3",
      payerUserId: "payer-3",
      verifiedPieceIndexes: [4],
    });
    await service.createDeliveryContract({
      contractId: "contract-3",
      sessionId: "session-3",
      bountyId: "bounty-3",
      payerUserId: "payer-3",
      hunterUserId: "hunter-3",
      payerWalletAddress: "tb1qpayer3",
      hunterWalletAddress: "tb1qhunter3",
      pieceIndexes: [4],
      rewardEscrowId: "escrow-bounty-3",
    });
    await service.updateContractBondEscrows({
      contractId: "contract-3",
      payerUserId: "payer-3",
      payerBondStatus: "FUNDED",
      hunterBondStatus: "FUNDED",
    });

    const receiptMessage = "deliveryContractId=contract-3|pieceIndex=4|pieceHash=abc";
    const receipt = await service.submitPieceReceipt({
      contractId: "contract-3",
      payerUserId: "payer-3",
      receiptSignerWalletAddress: "tb1qpayer3",
      pieceIndex: 4,
      receiptMessage,
      receiptSignature: `mock-signature:tb1qpayer3:${receiptMessage}`,
    });

    const contract = service.getDeliveryContract("contract-3");

    assert.equal(receipt.pieceIndex, 4);
    assert.equal(contract.state, "DELIVERY_VERIFIED");
    assert.equal(contract.resolutionReadiness, "READY_FOR_RESOLUTION_SUCCESS");
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
