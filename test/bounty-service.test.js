import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { BountyService } from "../src/bounty-service.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-bounty-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("bounty service saves torrent bounties", async () => {
  await withTempDir(async (tempDir) => {
    const service = new BountyService({ dataDir: tempDir });
    await service.init();

    const bounty = await service.createBounty({
      bountyId: "bounty-1",
      creatorUserId: "user-creator",
      title: "Need archive recovery",
      description: "Seed the file for a recovery torrent",
      torrentInfoHash: "0123456789abcdef0123456789abcdef01234567",
      torrentName: "archive.iso.torrent",
      rewardAmountUnits: 25_000_000,
      tags: ["Linux", "Archive"],
      escrowId: "escrow-bounty-1",
      escrowStatus: "AWAITING_FUNDING",
      funding: { chain: "arc", token: "USDC" },
      resourceLocator: {
        ensName: "btih-0123456789abcdef0123456789abcdef01234567.bitlazarus.eth",
        locatorStatus: "PENDING_RECOVERY",
      },
      pieceCount: 2048,
    });

    assert.equal(bounty.creatorUserId, "user-creator");
    assert.equal(bounty.status, "AWAITING_FUNDING");
    assert.deepEqual(bounty.tags, ["linux", "archive"]);
    assert.equal(bounty.escrowId, "escrow-bounty-1");
    assert.equal(bounty.rewardAmountUnits, 25_000_000);
    assert.equal(bounty.rewardToken, "USDC");
    assert.equal(bounty.resourceLocator.ensName, "btih-0123456789abcdef0123456789abcdef01234567.bitlazarus.eth");
    assert.equal(bounty.torrentMeta.pieceCount, 2048);
  });
});

test("bounty service lets hunters join open bounties", async () => {
  await withTempDir(async (tempDir) => {
    const service = new BountyService({ dataDir: tempDir });
    await service.init();

    const bounty = await service.createBounty({
      bountyId: "bounty-2",
      creatorUserId: "user-creator",
      title: "Seed a missing TV episode",
      description: "Need a partial reseed",
      torrentInfoHash: "89abcdef0123456789abcdef0123456789abcdef",
      rewardAmountUnits: 5_000_000,
      escrowId: "escrow-bounty-2",
      escrowStatus: "FUNDED",
    });

    const joinedBounty = await service.joinBounty({
      bountyId: bounty.id,
      userId: "user-hunter",
    });

    assert.equal(joinedBounty.hunters.length, 1);
    assert.equal(joinedBounty.hunters[0].userId, "user-hunter");
  });
});

test("bounty service prevents creators from joining their own bounties", async () => {
  await withTempDir(async (tempDir) => {
    const service = new BountyService({ dataDir: tempDir });
    await service.init();

    const bounty = await service.createBounty({
      bountyId: "bounty-3",
      creatorUserId: "user-creator",
      title: "Need old dataset pieces",
      description: "Recover a research torrent",
      torrentInfoHash: "fedcba9876543210fedcba9876543210fedcba98",
      rewardAmountUnits: 9_000_000,
      escrowId: "escrow-bounty-3",
      escrowStatus: "FUNDED",
    });

    await assert.rejects(
      service.joinBounty({
        bountyId: bounty.id,
        userId: "user-creator",
      }),
      /cannot join their own bounty/,
    );
  });
});

test("bounty service filters by creator and hunter", async () => {
  await withTempDir(async (tempDir) => {
    const service = new BountyService({ dataDir: tempDir });
    await service.init();

    await service.createBounty({
      bountyId: "bounty-4",
      creatorUserId: "user-creator-a",
      title: "Need file for torrent A",
      description: "Recover file for torrent A",
      torrentInfoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rewardAmountUnits: 3_000_000,
      escrowId: "escrow-bounty-4",
      escrowStatus: "AWAITING_FUNDING",
    });
    await service.createBounty({
      bountyId: "bounty-5",
      creatorUserId: "user-creator-b",
      title: "Need file for torrent B",
      description: "Recover file for torrent B",
      torrentInfoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      rewardAmountUnits: 4_000_000,
      escrowId: "escrow-bounty-5",
      escrowStatus: "FUNDED",
    });

    await service.joinBounty({
      bountyId: "bounty-5",
      userId: "user-hunter-b",
    });

    assert.equal(service.listBounties({ creatorUserId: "user-creator-a" }).length, 1);
    assert.equal(service.listBounties({ hunterUserId: "user-hunter-b" }).length, 1);
  });
});

test("bounty service syncs bounty state from Arc escrow state", async () => {
  await withTempDir(async (tempDir) => {
    const service = new BountyService({ dataDir: tempDir });
    await service.init();

    await service.createBounty({
      bountyId: "bounty-6",
      creatorUserId: "user-creator",
      title: "Need a funded bounty",
      description: "Awaiting escrow funding",
      torrentInfoHash: "cccccccccccccccccccccccccccccccccccccccc",
      rewardAmountUnits: 6_000_000,
      escrowId: "escrow-bounty-6",
      escrowStatus: "AWAITING_FUNDING",
    });

    const openBounty = await service.syncBountyEscrow({
      bountyId: "bounty-6",
      escrowId: "escrow-bounty-6",
      escrowStatus: "FUNDED",
      funding: { chain: "arc", token: "USDC" },
    });

    assert.equal(openBounty.status, "OPEN");
    assert.equal(openBounty.escrowStatus, "FUNDED");
  });
});

test("bounty service unregisters deleted delivery contracts", async () => {
  await withTempDir(async (tempDir) => {
    const service = new BountyService({ dataDir: tempDir });
    await service.init();

    const bounty = await service.createBounty({
      bountyId: "bounty-7",
      creatorUserId: "user-creator",
      title: "Need cleanup",
      description: "Clear a stuck local contract",
      torrentInfoHash: "dddddddddddddddddddddddddddddddddddddddd",
      rewardAmountUnits: 1_000_000,
      escrowId: "escrow-bounty-7",
      escrowStatus: "FUNDED",
    });

    await service.registerDeliveryContract({
      bountyId: bounty.id,
      contractId: "contract-stuck",
    });

    const cleanedBounty = await service.unregisterDeliveryContract({
      bountyId: bounty.id,
      contractId: "contract-stuck",
    });

    assert.deepEqual(cleanedBounty.activeContractIds, []);
    assert.equal(cleanedBounty.deliveryStatus, "IDLE");
    assert.equal(cleanedBounty.completionReadiness, "PENDING");
  });
});

test("bounty service deletes bounties from older Arc escrow contracts", async () => {
  await withTempDir(async (tempDir) => {
    const service = new BountyService({ dataDir: tempDir });
    await service.init();

    await service.createBounty({
      bountyId: "old-bounty",
      creatorUserId: "user-creator",
      title: "Old escrow",
      description: "Clear this bounty after redeploying escrow",
      torrentInfoHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      rewardAmountUnits: 1_000_000,
      escrowId: "old-tx",
      escrowStatus: "FUNDED",
      funding: {
        chain: "arc",
        escrowContractAddress: "0x00000000000000000000000000000000000000aa",
      },
    });
    await service.createBounty({
      bountyId: "current-bounty",
      creatorUserId: "user-creator",
      title: "Current escrow",
      description: "Keep this bounty",
      torrentInfoHash: "ffffffffffffffffffffffffffffffffffffffff",
      rewardAmountUnits: 1_000_000,
      escrowId: "current-tx",
      escrowStatus: "FUNDED",
      funding: {
        chain: "arc",
        escrowContractAddress: "0x00000000000000000000000000000000000000bb",
      },
    });

    const deletedBounties = await service.deleteBountiesForOtherEscrowContract({
      escrowContractAddress: "0x00000000000000000000000000000000000000BB",
    });

    assert.deepEqual(deletedBounties.map((bounty) => bounty.id), ["old-bounty"]);
    assert.equal(service.getBounty("old-bounty"), null);
    assert.equal(service.getBounty("current-bounty").id, "current-bounty");
  });
});
