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
      rewardSats: 25_000,
      tags: ["Linux", "Archive"],
      escrowId: "escrow-bounty-1",
      escrowStatus: "AWAITING_FUNDING",
      funding: { paymentRequest: "lnmocktestnet-example" },
      resourceLocator: {
        ensName: "b-0123456789abcdef.lazarus.eth",
        locatorStatus: "PENDING_RECOVERY",
      },
      pieceCount: 2048,
    });

    assert.equal(bounty.creatorUserId, "user-creator");
    assert.equal(bounty.status, "AWAITING_FUNDING");
    assert.deepEqual(bounty.tags, ["linux", "archive"]);
    assert.equal(bounty.escrowId, "escrow-bounty-1");
    assert.equal(bounty.bondAmountSats, 7500);
    assert.equal(bounty.resourceLocator.ensName, "b-0123456789abcdef.lazarus.eth");
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
      rewardSats: 5_000,
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
      rewardSats: 9_000,
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
      rewardSats: 3_000,
      escrowId: "escrow-bounty-4",
      escrowStatus: "AWAITING_FUNDING",
    });
    await service.createBounty({
      bountyId: "bounty-5",
      creatorUserId: "user-creator-b",
      title: "Need file for torrent B",
      description: "Recover file for torrent B",
      torrentInfoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      rewardSats: 4_000,
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

test("bounty service syncs bounty state from escrow state", async () => {
  await withTempDir(async (tempDir) => {
    const service = new BountyService({ dataDir: tempDir });
    await service.init();

    await service.createBounty({
      bountyId: "bounty-6",
      creatorUserId: "user-creator",
      title: "Need a funded bounty",
      description: "Awaiting escrow funding",
      torrentInfoHash: "cccccccccccccccccccccccccccccccccccccccc",
      rewardSats: 6_000,
      escrowId: "escrow-bounty-6",
      escrowStatus: "AWAITING_FUNDING",
    });

    const openBounty = await service.syncBountyEscrow({
      bountyId: "bounty-6",
      escrowId: "escrow-bounty-6",
      escrowStatus: "FUNDED",
      funding: { paymentRequest: "lnmocktestnet-bounty-6" },
    });

    assert.equal(openBounty.status, "OPEN");
    assert.equal(openBounty.escrowStatus, "FUNDED");
  });
});
