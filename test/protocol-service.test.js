import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { ProtocolService } from "../src/protocol-service.js";
import { EscrowService } from "../src/escrow-service.js";
import { MockLightningClient } from "../src/lightning-client.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-protocol-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function setupProtocolWithEscrow(tempDir, options = {}) {
  const lightningClient = new MockLightningClient();
  const escrowService = new EscrowService({
    dataDir: path.join(tempDir, "escrow"),
    lightningClient,
  });
  await escrowService.init();

  const protocolService = new ProtocolService({
    dataDir: path.join(tempDir, "protocol"),
    escrowService,
    ...options,
  });
  await protocolService.init();

  return { lightningClient, escrowService, protocolService };
}

async function createReadyContract(tempDir, suffix, options = {}) {
  const { lightningClient, escrowService, protocolService } = await setupProtocolWithEscrow(tempDir, options);

  const rewardEscrow = await escrowService.createEscrow({
    escrowId: `reward-${suffix}`,
    buyerId: `payer-${suffix}`,
    sellerId: `bounty:bounty-${suffix}`,
    amountSats: 25_000,
  });

  const contract = await protocolService.createDeliveryContract({
    contractId: `contract-${suffix}`,
    bountyId: `bounty-${suffix}`,
    payerUserId: `payer-${suffix}`,
    hunterUserId: `hunter-${suffix}`,
    payerWalletAddress: `payer-wallet-${suffix}`,
    hunterWalletAddress: `hunter-wallet-${suffix}`,
    rewardEscrowId: rewardEscrow.id,
  });

  const { payerBondEscrow, hunterBondEscrow } = await protocolService.createBondEscrows({
    contractId: contract.id,
    bondAmountSats: 2500,
  });

  const hunterPayoutInvoice = await lightningClient.createInvoice({
    amountSats: 25_000,
    memo: `hunter payout ${suffix}`,
  });
  await protocolService.registerContractPayoutInvoice({
    contractId: contract.id,
    userId: `hunter-${suffix}`,
    paymentRequest: hunterPayoutInvoice.paymentRequest,
  });

  await lightningClient.acceptHoldInvoice({ paymentHashHex: rewardEscrow.funding.paymentHashHex });
  await lightningClient.acceptHoldInvoice({ paymentHashHex: payerBondEscrow.funding.paymentHashHex });
  await lightningClient.acceptHoldInvoice({ paymentHashHex: hunterBondEscrow.funding.paymentHashHex });
  await protocolService.syncBondStatus({ contractId: contract.id });

  return {
    lightningClient,
    escrowService,
    protocolService,
    rewardEscrow,
    contract: protocolService.getDeliveryContract(contract.id),
  };
}

test("protocol service creates delivery contracts directly from a bounty", async () => {
  await withTempDir(async (tempDir) => {
    const service = new ProtocolService({ dataDir: tempDir });
    await service.init();

    const contract = await service.createDeliveryContract({
      contractId: "contract-1",
      bountyId: "bounty-1",
      payerUserId: "payer-1",
      hunterUserId: "hunter-1",
      payerWalletAddress: "payer-wallet-1",
      hunterWalletAddress: "hunter-wallet-1",
      rewardEscrowId: "reward-1",
    });

    assert.equal(contract.state, "BOND_PENDING");
    assert.equal(contract.payerUserId, "payer-1");
    assert.equal(contract.hunterUserId, "hunter-1");
    assert.equal(contract.deliveryHashStatus, "PENDING");
  });
});

test("protocol service rejects manual bond status overrides", async () => {
  await withTempDir(async (tempDir) => {
    const service = new ProtocolService({ dataDir: tempDir });
    await service.init();

    await service.createDeliveryContract({
      contractId: "contract-2",
      bountyId: "bounty-2",
      payerUserId: "payer-2",
      hunterUserId: "hunter-2",
      payerWalletAddress: "payer-wallet-2",
      hunterWalletAddress: "hunter-wallet-2",
      rewardEscrowId: "reward-2",
    });

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

test("torrent-hash delivery contracts resolve successfully when requester and hunter hashes match", async () => {
  await withTempDir(async (tempDir) => {
    const { protocolService, contract } = await createReadyContract(tempDir, "5");

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

    assert.equal(updatedContract.deliveryHashStatus, "MATCHED");
    assert.equal(updatedContract.state, "RESOLVED_SUCCESS");
    assert.equal(updatedContract.resolutionReadiness, "RESOLVED");
  });
});

test("torrent-hash delivery contracts keep the contract open on hash mismatch", async () => {
  await withTempDir(async (tempDir) => {
    const { protocolService, contract } = await createReadyContract(tempDir, "6");

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

test("protocol service sweeps expired contracts", async () => {
  await withTempDir(async (tempDir) => {
    let now = "2026-04-11T10:00:00.000Z";
    const service = new ProtocolService({
      dataDir: tempDir,
      now: () => now,
      bondDeadlineMs: 1000,
    });
    await service.init();

    await service.createDeliveryContract({
      contractId: "contract-7",
      bountyId: "bounty-7",
      payerUserId: "payer-7",
      hunterUserId: "hunter-7",
      payerWalletAddress: "payer-wallet-7",
      hunterWalletAddress: "hunter-wallet-7",
      rewardEscrowId: "reward-7",
    });

    now = "2026-04-11T10:00:03.000Z";
    await service.sweepExpiredStates();

    assert.equal(service.getDeliveryContract("contract-7").state, "EXPIRED");
  });
});
