import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { ProtocolService } from "../src/protocol-service.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-protocol-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function createReadyContract(tempDir, suffix, options = {}) {
  const protocolService = new ProtocolService({
    dataDir: tempDir,
    ...options,
  });
  await protocolService.init();

  const contract = await protocolService.createDeliveryContract({
    contractId: `contract-${suffix}`,
    bountyId: `bounty-${suffix}`,
    payerUserId: `payer-${suffix}`,
    hunterUserId: `hunter-${suffix}`,
    payerWalletAddress: `0x00000000000000000000000000000000000000a${suffix}`,
    hunterWalletAddress: `0x00000000000000000000000000000000000000b${suffix}`,
    rewardEscrowId: `arc-escrow-${suffix}`,
    rewardAmountUnits: 25_000_000,
  });

  return {
    protocolService,
    contract,
  };
}

test("protocol service creates delivery contracts directly from a funded Arc bounty", async () => {
  await withTempDir(async (tempDir) => {
    const service = new ProtocolService({ dataDir: tempDir });
    await service.init();

    const contract = await service.createDeliveryContract({
      contractId: "contract-1",
      bountyId: "bounty-1",
      payerUserId: "payer-1",
      hunterUserId: "hunter-1",
      payerWalletAddress: "0x00000000000000000000000000000000000000a1",
      hunterWalletAddress: "0x00000000000000000000000000000000000000b1",
      rewardEscrowId: "arc-escrow-1",
      rewardAmountUnits: 25_000_000,
    });

    assert.equal(contract.state, "DELIVERY_IN_PROGRESS");
    assert.equal(contract.payerUserId, "payer-1");
    assert.equal(contract.hunterUserId, "hunter-1");
    assert.equal(contract.rewardToken, "USDC");
    assert.equal(contract.deliveryHashStatus, "PENDING");
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

test("protocol service deletes local delivery contracts", async () => {
  await withTempDir(async (tempDir) => {
    const { protocolService, contract } = await createReadyContract(tempDir, "8");

    const deletedContract = await protocolService.deleteDeliveryContract(contract.id);

    assert.equal(deletedContract.id, contract.id);
    assert.equal(protocolService.getDeliveryContract(contract.id), null);
    assert.equal(protocolService.listDeliveryContracts({ bountyId: contract.bountyId }).length, 0);
  });
});

test("protocol service bulk deletes stale requester delivery contracts", async () => {
  await withTempDir(async (tempDir) => {
    const service = new ProtocolService({ dataDir: tempDir });
    await service.init();

    await service.createDeliveryContract({
      contractId: "stale-active",
      bountyId: "bounty-shared",
      payerUserId: "payer-shared",
      hunterUserId: "hunter-a",
      payerWalletAddress: "0x00000000000000000000000000000000000000a1",
      hunterWalletAddress: "0x00000000000000000000000000000000000000b1",
      rewardEscrowId: "arc-escrow-shared",
      rewardAmountUnits: 1_000_000,
    });
    await service.createDeliveryContract({
      contractId: "successful",
      bountyId: "bounty-shared",
      payerUserId: "payer-shared",
      hunterUserId: "hunter-b",
      payerWalletAddress: "0x00000000000000000000000000000000000000a1",
      hunterWalletAddress: "0x00000000000000000000000000000000000000b2",
      rewardEscrowId: "arc-escrow-shared",
      rewardAmountUnits: 1_000_000,
    });
    await service.resolveContract({ contractId: "successful", outcome: "SUCCESS" });
    await service.createDeliveryContract({
      contractId: "other-requester",
      bountyId: "bounty-shared",
      payerUserId: "payer-other",
      hunterUserId: "hunter-c",
      payerWalletAddress: "0x00000000000000000000000000000000000000a2",
      hunterWalletAddress: "0x00000000000000000000000000000000000000b3",
      rewardEscrowId: "arc-escrow-shared",
      rewardAmountUnits: 1_000_000,
    });

    const deletedContracts = await service.deleteStaleDeliveryContracts({
      bountyId: "bounty-shared",
      requesterUserId: "payer-shared",
    });

    assert.deepEqual(deletedContracts.map((contract) => contract.id), ["stale-active"]);
    assert.equal(service.getDeliveryContract("stale-active"), null);
    assert.equal(service.getDeliveryContract("successful").state, "RESOLVED_SUCCESS");
    assert.equal(service.getDeliveryContract("other-requester").state, "DELIVERY_IN_PROGRESS");
  });
});

test("protocol service deletes delivery contracts for deleted bounties", async () => {
  await withTempDir(async (tempDir) => {
    const service = new ProtocolService({ dataDir: tempDir });
    await service.init();

    await service.createDeliveryContract({
      contractId: "old-contract",
      bountyId: "old-bounty",
      payerUserId: "payer-old",
      hunterUserId: "hunter-old",
      payerWalletAddress: "0x00000000000000000000000000000000000000a1",
      hunterWalletAddress: "0x00000000000000000000000000000000000000b1",
      rewardEscrowId: "old-escrow",
      rewardAmountUnits: 1_000_000,
    });
    await service.createDeliveryContract({
      contractId: "current-contract",
      bountyId: "current-bounty",
      payerUserId: "payer-current",
      hunterUserId: "hunter-current",
      payerWalletAddress: "0x00000000000000000000000000000000000000a2",
      hunterWalletAddress: "0x00000000000000000000000000000000000000b2",
      rewardEscrowId: "current-escrow",
      rewardAmountUnits: 1_000_000,
    });

    const deletedContracts = await service.deleteDeliveryContractsByBountyIds({
      bountyIds: ["old-bounty"],
    });

    assert.deepEqual(deletedContracts.map((contract) => contract.id), ["old-contract"]);
    assert.equal(service.getDeliveryContract("old-contract"), null);
    assert.equal(service.getDeliveryContract("current-contract").id, "current-contract");
  });
});

test("protocol service sweeps expired contracts", async () => {
  await withTempDir(async (tempDir) => {
    let now = "2026-04-11T10:00:00.000Z";
    const service = new ProtocolService({
      dataDir: tempDir,
      now: () => now,
      deliveryDeadlineMs: 1000,
    });
    await service.init();

    await service.createDeliveryContract({
      contractId: "contract-7",
      bountyId: "bounty-7",
      payerUserId: "payer-7",
      hunterUserId: "hunter-7",
      payerWalletAddress: "0x00000000000000000000000000000000000000a7",
      hunterWalletAddress: "0x00000000000000000000000000000000000000b7",
      rewardEscrowId: "arc-escrow-7",
      rewardAmountUnits: 1_000_000,
    });

    now = "2026-04-11T10:00:03.000Z";
    await service.sweepExpiredStates();

    assert.equal(service.getDeliveryContract("contract-7").state, "RESOLVED_EXPIRED");
  });
});
