import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { EscrowService } from "../src/escrow-service.js";
import { MockLightningClient } from "../src/lightning-client.js";
import { ProtocolService } from "../src/protocol-service.js";
import { MockWalletAuthVerifier } from "../src/wallet-auth-verifier.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-bond-"));
  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function setupServices(tempDir) {
  const lightningClient = new MockLightningClient();
  const escrowService = new EscrowService({
    dataDir: path.join(tempDir, "escrow"),
    lightningClient,
  });
  await escrowService.init();

  const verifier = new MockWalletAuthVerifier();
  const protocolService = new ProtocolService({
    dataDir: path.join(tempDir, "protocol"),
    verifier,
    escrowService,
    bondDeadlineMs: 500,
    deliveryDeadlineMs: 1000,
    receiptDeadlineMs: 500,
  });
  await protocolService.init();

  return { lightningClient, escrowService, protocolService, verifier };
}

async function createContractWithBonds(tempDir) {
  const { lightningClient, escrowService, protocolService } = await setupServices(tempDir);

  const rewardEscrow = await escrowService.createEscrow({
    escrowId: "reward-1",
    buyerId: "payer",
    sellerId: "bounty:b1",
    amountSats: 10_000,
  });

  const session = await protocolService.createVerificationSession({
    bountyId: "b1",
    payerUserId: "payer",
    hunterUserId: "hunter",
    pieceIndexes: [0, 1, 2],
    torrentInfoHash: "a".repeat(40),
  });

  await protocolService.submitProofArtifacts({
    sessionId: session.id,
    hunterUserId: "hunter",
    proofArtifacts: { proofs: [{ pieceIndex: 0 }, { pieceIndex: 1 }, { pieceIndex: 2 }] },
  });

  await protocolService.markProofVerified({
    sessionId: session.id,
    payerUserId: "payer",
    verifiedPieceIndexes: [0, 1, 2],
  });

  const contract = await protocolService.createDeliveryContract({
    sessionId: session.id,
    bountyId: "b1",
    payerUserId: "payer",
    hunterUserId: "hunter",
    payerWalletAddress: "payer-wallet",
    hunterWalletAddress: "hunter-wallet",
    pieceIndexes: [0, 1, 2],
    rewardEscrowId: rewardEscrow.id,
  });

  const bondResult = await protocolService.createBondEscrows({
    contractId: contract.id,
    bondAmountSats: 1000,
  });

  return { lightningClient, escrowService, protocolService, rewardEscrow, contract: bondResult.contract, bondResult };
}

test("createBondEscrows creates payer and hunter bond escrows", async () => {
  await withTempDir(async (tempDir) => {
    const { contract, bondResult, escrowService } = await createContractWithBonds(tempDir);

    assert.ok(contract.payerBondEscrowId);
    assert.ok(contract.hunterBondEscrowId);
    assert.equal(contract.payerBondStatus, "AWAITING_FUNDING");
    assert.equal(contract.hunterBondStatus, "AWAITING_FUNDING");
    assert.equal(contract.bondAmountSats, 1000);

    const payerBond = escrowService.getEscrow(contract.payerBondEscrowId);
    assert.equal(payerBond.amountSats, 1000);
    assert.equal(payerBond.buyerId, "payer");

    const hunterBond = escrowService.getEscrow(contract.hunterBondEscrowId);
    assert.equal(hunterBond.amountSats, 1000);
    assert.equal(hunterBond.buyerId, "hunter");
  });
});

test("syncBondStatus transitions to DELIVERY_IN_PROGRESS when both bonds funded", async () => {
  await withTempDir(async (tempDir) => {
    const { lightningClient, protocolService, contract } = await createContractWithBonds(tempDir);

    const payerBondHash = lightningClient.invoices.values().next().value;
    for (const [hash] of lightningClient.invoices) {
      await lightningClient.acceptHoldInvoice({ paymentHashHex: hash });
    }

    const synced = await protocolService.syncBondStatus({ contractId: contract.id });
    assert.equal(synced.payerBondStatus, "FUNDED");
    assert.equal(synced.hunterBondStatus, "FUNDED");
    assert.equal(synced.state, "DELIVERY_IN_PROGRESS");
  });
});

test("resolveContract SUCCESS releases reward and cancels both bonds", async () => {
  await withTempDir(async (tempDir) => {
    const { lightningClient, escrowService, protocolService, contract, rewardEscrow } =
      await createContractWithBonds(tempDir);

    for (const [hash] of lightningClient.invoices) {
      await lightningClient.acceptHoldInvoice({ paymentHashHex: hash });
    }
    await protocolService.syncBondStatus({ contractId: contract.id });

    const resolved = await protocolService.resolveContract({
      contractId: contract.id,
      outcome: "SUCCESS",
    });

    assert.equal(resolved.state, "RESOLVED_SUCCESS");

    const reward = escrowService.getEscrow(rewardEscrow.id);
    assert.equal(reward.status, "RELEASED");

    const payerBond = escrowService.getEscrow(contract.payerBondEscrowId);
    assert.equal(payerBond.status, "CANCELED");

    const hunterBond = escrowService.getEscrow(contract.hunterBondEscrowId);
    assert.equal(hunterBond.status, "CANCELED");
  });
});

test("resolveContract HUNTER_FAULT slashes hunter bond and refunds payer", async () => {
  await withTempDir(async (tempDir) => {
    const { lightningClient, escrowService, protocolService, contract, rewardEscrow } =
      await createContractWithBonds(tempDir);

    for (const [hash] of lightningClient.invoices) {
      await lightningClient.acceptHoldInvoice({ paymentHashHex: hash });
    }
    await protocolService.syncBondStatus({ contractId: contract.id });

    const resolved = await protocolService.resolveContract({
      contractId: contract.id,
      outcome: "HUNTER_FAULT",
    });

    assert.equal(resolved.state, "RESOLVED_HUNTER_FAULT");

    const reward = escrowService.getEscrow(rewardEscrow.id);
    assert.equal(reward.status, "CANCELED");

    const payerBond = escrowService.getEscrow(contract.payerBondEscrowId);
    assert.equal(payerBond.status, "CANCELED");

    const hunterBond = escrowService.getEscrow(contract.hunterBondEscrowId);
    assert.equal(hunterBond.status, "RELEASED");
  });
});

test("resolveContract PAYER_FAULT slashes payer bond and pays hunter", async () => {
  await withTempDir(async (tempDir) => {
    const { lightningClient, escrowService, protocolService, contract, rewardEscrow } =
      await createContractWithBonds(tempDir);

    for (const [hash] of lightningClient.invoices) {
      await lightningClient.acceptHoldInvoice({ paymentHashHex: hash });
    }
    await protocolService.syncBondStatus({ contractId: contract.id });

    const resolved = await protocolService.resolveContract({
      contractId: contract.id,
      outcome: "PAYER_FAULT",
    });

    assert.equal(resolved.state, "RESOLVED_PAYER_FAULT");

    const reward = escrowService.getEscrow(rewardEscrow.id);
    assert.equal(reward.status, "RELEASED");

    const payerBond = escrowService.getEscrow(contract.payerBondEscrowId);
    assert.equal(payerBond.status, "RELEASED");

    const hunterBond = escrowService.getEscrow(contract.hunterBondEscrowId);
    assert.equal(hunterBond.status, "CANCELED");
  });
});

test("resolveContract EXPIRED cancels everything", async () => {
  await withTempDir(async (tempDir) => {
    const { escrowService, protocolService, contract, rewardEscrow } =
      await createContractWithBonds(tempDir);

    const resolved = await protocolService.resolveContract({
      contractId: contract.id,
      outcome: "EXPIRED",
    });

    assert.equal(resolved.state, "RESOLVED_EXPIRED");

    const reward = escrowService.getEscrow(rewardEscrow.id);
    assert.equal(reward.status, "CANCELED");

    const payerBond = escrowService.getEscrow(contract.payerBondEscrowId);
    assert.equal(payerBond.status, "CANCELED");

    const hunterBond = escrowService.getEscrow(contract.hunterBondEscrowId);
    assert.equal(hunterBond.status, "CANCELED");
  });
});
