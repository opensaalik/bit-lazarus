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
      title: "Need the last 3 pieces",
      description: "Seed the missing pieces for a recovery torrent",
      torrentInfoHash: "0123456789abcdef0123456789abcdef01234567",
      torrentName: "archive.iso.torrent",
      rewardSats: 25_000,
      missingPieces: [12, 15, 18, 12],
      tags: ["Linux", "Archive"],
    });

    assert.equal(bounty.creatorUserId, "user-creator");
    assert.equal(bounty.status, "OPEN");
    assert.deepEqual(bounty.missingPieces, [12, 15, 18]);
    assert.deepEqual(bounty.tags, ["linux", "archive"]);
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
      title: "Need pieces for torrent A",
      description: "Missing pieces for torrent A",
      torrentInfoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rewardSats: 3_000,
    });
    await service.createBounty({
      bountyId: "bounty-5",
      creatorUserId: "user-creator-b",
      title: "Need pieces for torrent B",
      description: "Missing pieces for torrent B",
      torrentInfoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      rewardSats: 4_000,
    });

    await service.joinBounty({
      bountyId: "bounty-5",
      userId: "user-hunter-b",
    });

    assert.equal(service.listBounties({ creatorUserId: "user-creator-a" }).length, 1);
    assert.equal(service.listBounties({ hunterUserId: "user-hunter-b" }).length, 1);
  });
});
