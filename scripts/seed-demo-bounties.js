import bencode from "bencode";
import crypto from "node:crypto";
import path from "node:path";
import { BountyService } from "../src/bounty-service.js";
import { ResourceLocatorService } from "../src/resource-locator-service.js";

const DEFAULT_ARC_ESCROW_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";
const DEFAULT_PARENT_NAME = "bitlazarus.eth";
const DEFAULT_WALRUS_GATEWAY_BASE_URL = "https://aggregator.walrus-testnet.walrus.space/v1/blobs";
const DEFAULT_TRACKER_URL = "wss://bit-lazarus.onrender.com/tracker";
const DEMO_CREATOR_USER_ID = "demo-requester";
const PIECE_LENGTH = 16 * 1024;

const DEMO_BOUNTIES = [
  {
    id: "demo-infinite-garden-workprint",
    title: "Infinite Garden workprint reel",
    description: "A private tracker copy of an early community documentary workprint went dark years ago. Looking for the original reel bundle with cue sheet and checksum notes.",
    rewardUsdc: 18,
    status: "OPEN",
    tags: ["video", "workprint", "ethereum"],
    files: [
      { path: "infinite-garden-workprint/reel-a.mkv", size: 82_944 },
      { path: "infinite-garden-workprint/notes/devcon-screening-checksums.txt", size: 2_048 },
      { path: "infinite-garden-workprint/production/regen-vibes-cutlist.pdf", size: 12_288 },
    ],
  },
  {
    id: "demo-yellow-paper-annotations",
    title: "Yellow Paper annotation pack",
    description: "Need a verified copy of an old annotated Yellow Paper reading-group archive. Partial magnets exist, but no complete seed has appeared this year.",
    rewardUsdc: 25,
    status: "OPEN",
    tags: ["pdf", "ethereum", "research"],
    files: [
      { path: "yellow-paper-reading-group/yellow-paper-annotated.pdf", size: 65_536 },
      { path: "yellow-paper-reading-group/eip-cross-reference.pdf", size: 49_152 },
      { path: "yellow-paper-reading-group/readme-gas-schedule-notes.nfo", size: 1_536 },
    ],
  },
  {
    id: "demo-blobspace-mixtape-stems",
    title: "Blobspace mixtape stems",
    description: "Recover the stem archive from a tiny Ethereum meetup remix contest. Original forum links are dead and only the magnet remains.",
    rewardUsdc: 12,
    status: "OPEN",
    tags: ["audio", "stems", "eip-4844"],
    files: [
      { path: "blobspace-mixtape-stems/drums.flac", size: 32_768 },
      { path: "blobspace-mixtape-stems/synths.flac", size: 35_840 },
      { path: "blobspace-mixtape-stems/vocals-ultrasound.flac", size: 28_672 },
      { path: "blobspace-mixtape-stems/session-info-4844.txt", size: 1_024 },
    ],
  },
  {
    id: "demo-solidity-optimism-workshop",
    title: "Solidity workshop VM image",
    description: "Looking for a missing workshop image from a rollup-focused Solidity session, including examples and old patch notes.",
    rewardUsdc: 9,
    status: "OPEN",
    tags: ["solidity", "rollups", "tools"],
    files: [
      { path: "solidity-workshop/bin/foundry-lab-image.qcow2", size: 40_960 },
      { path: "solidity-workshop/examples/l2-escrow-example.sol", size: 24_576 },
      { path: "solidity-workshop/docs/based-rollup-notes.pdf", size: 4_096 },
    ],
  },
  {
    id: "demo-ethereum-magicians-zine",
    title: "Ethereum Magicians zine scans",
    description: "A scan pack for issues 1-6 used to circulate by torrent only. Need a clean copy with the original directory layout.",
    rewardUsdc: 7,
    status: "OPEN",
    tags: ["zine", "ethereum", "scans"],
    files: [
      { path: "magicians-zine/issue-01-rough-consensus.cbz", size: 45_056 },
      { path: "magicians-zine/issue-02-allcoredevs.cbz", size: 43_008 },
      { path: "magicians-zine/issue-03-ens-subnames.cbz", size: 46_080 },
    ],
  },
  {
    id: "demo-devcon-hallway-newsreel",
    title: "Devcon hallway newsreel transfer",
    description: "Recovered and archived: a small transfer package with reel notes and the restored scan.",
    rewardUsdc: 16,
    status: "COMPLETED",
    tags: ["video", "devcon", "walrus"],
    walrusBlobId: "demo_devcon_hallway_newsreel_blob_2026",
    files: [
      { path: "devcon-hallway-newsreel/reel-17-restored.mp4", size: 90_112 },
      { path: "devcon-hallway-newsreel/reel-notes.txt", size: 2_560 },
      { path: "devcon-hallway-newsreel/attestation-cameo.pdf", size: 8_192 },
    ],
  },
  {
    id: "demo-ultrasound-artpack",
    title: "Ultrasound ANSI artpack",
    description: "Recovered and archived: the original artpack zip and file id listings from the dead magnet.",
    rewardUsdc: 6,
    status: "COMPLETED",
    tags: ["bbs", "ethereum", "walrus"],
    walrusBlobId: "demo_ultrasound_artpack_blob_2026",
    files: [
      { path: "ultrasound-ansi-artpack/artpack.zip", size: 57_344 },
      { path: "ultrasound-ansi-artpack/file_id.diz", size: 768 },
      { path: "ultrasound-ansi-artpack/fee-burn-poster.pdf", size: 6_144 },
    ],
  },
  {
    id: "demo-eip1559-index",
    title: "EIP-1559 study CD index",
    description: "Recovered and archived: catalog databases and cover scans from a missing study-group disc image.",
    rewardUsdc: 11,
    status: "COMPLETED",
    tags: ["eip-1559", "catalog", "walrus"],
    walrusBlobId: "demo_eip1559_index_blob_2026",
    files: [
      { path: "eip1559-study-cd/catalog.db", size: 36_864 },
      { path: "eip1559-study-cd/covers/basefee-front.jpg", size: 18_432 },
      { path: "eip1559-study-cd/covers/priority-fee-back.jpg", size: 19_456 },
      { path: "eip1559-study-cd/papers/fee-market-primer.pdf", size: 10_240 },
    ],
  },
  {
    id: "demo-beacon-chain-field-recordings",
    title: "Beacon chain field recordings",
    description: "Recovered and archived: lossless field recording transfers plus the recorder log.",
    rewardUsdc: 14,
    status: "COMPLETED",
    tags: ["audio", "beacon-chain", "walrus"],
    walrusBlobId: "demo_beacon_chain_field_recording_blob_2026",
    files: [
      { path: "beacon-chain-field-recordings/slot-00000001.flac", size: 41_984 },
      { path: "beacon-chain-field-recordings/slot-00000002.flac", size: 42_496 },
      { path: "beacon-chain-field-recordings/validator-logbook.txt", size: 1_792 },
    ],
  },
  {
    id: "demo-merge-watch-party-pack",
    title: "Merge watch party pack",
    description: "Recovered and archived: the final custom media rotation from a long-dead community tracker.",
    rewardUsdc: 8,
    status: "COMPLETED",
    tags: ["merge", "community", "walrus"],
    walrusBlobId: "demo_merge_watch_party_blob_2026",
    files: [
      { path: "merge-watch-party/media/terminal-total-difficulty-countdown.mp4", size: 30_720 },
      { path: "merge-watch-party/media/proof-of-stake-slides.pdf", size: 34_816 },
      { path: "merge-watch-party/rotation.cfg", size: 1_024 },
    ],
  },
];

function requireEnv(name, fallback = null) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function hashBytes(algorithm, bytes) {
  return crypto.createHash(algorithm).update(bytes).digest();
}

function createDeterministicContent(seed, size) {
  const output = Buffer.alloc(size);
  let offset = 0;
  let counter = 0;

  while (offset < output.length) {
    const block = hashBytes("sha256", Buffer.from(`${seed}:${counter}`));
    block.copy(output, offset);
    offset += block.length;
    counter += 1;
  }

  return output;
}

function buildTorrentPayload(definition, announceUrl) {
  const files = definition.files.map((file) => ({
    ...file,
    content: createDeterministicContent(`${definition.id}:${file.path}`, file.size),
  }));
  const concatenated = Buffer.concat(files.map((file) => file.content));
  const pieceHashes = [];

  for (let offset = 0; offset < concatenated.length; offset += PIECE_LENGTH) {
    pieceHashes.push(hashBytes("sha1", concatenated.subarray(offset, offset + PIECE_LENGTH)));
  }

  const rootName = definition.id.replace(/^demo-/, "");
  const info = {
    "piece length": PIECE_LENGTH,
    pieces: Buffer.concat(pieceHashes),
    name: rootName,
    files: files.map((file) => ({
      length: file.size,
      path: file.path.split("/"),
    })),
  };
  const torrent = {
    announce: announceUrl,
    "announce-list": [[announceUrl]],
    "created by": "Bit Lazarus demo seed",
    "creation date": Math.floor(Date.now() / 1000),
    comment: definition.description,
    info,
  };
  const torrentBytes = Buffer.from(bencode.encode(torrent));
  const infoHash = hashBytes("sha1", Buffer.from(bencode.encode(info))).toString("hex");

  return {
    torrentBytes,
    infoHash,
    totalSize: concatenated.length,
    pieceCount: pieceHashes.length,
    files: files.map((file) => ({
      name: path.basename(file.path),
      path: `${rootName}/${file.path}`,
      length: file.size,
    })),
  };
}

function createArcServiceStub() {
  return {
    async getBountyByInfoHash() {
      return null;
    },
  };
}

async function seedDemoBounties() {
  const dataDir = requireEnv("DATA_DIR", path.resolve("data"));
  const parentName = requireEnv("ENS_PARENT_NAME", DEFAULT_PARENT_NAME);
  const escrowContractAddress = requireEnv("ARC_ESCROW_CONTRACT_ADDRESS", DEFAULT_ARC_ESCROW_CONTRACT_ADDRESS);
  const walrusGatewayBaseUrl = requireEnv("WALRUS_GATEWAY_BASE_URL", DEFAULT_WALRUS_GATEWAY_BASE_URL);
  const trackerUrl = requireEnv("WEBTORRENT_TRACKER_URL", DEFAULT_TRACKER_URL);
  const now = new Date().toISOString();
  const bountyService = new BountyService({
    dataDir: path.join(dataDir, "bounties"),
    now: () => now,
  });
  const resourceLocatorService = new ResourceLocatorService({
    dataDir: path.join(dataDir, "resources"),
    parentName,
    walrusGatewayBaseUrl,
    escrowAddress: escrowContractAddress,
    arcEscrowService: createArcServiceStub(),
    now: () => now,
  });
  await bountyService.init();
  await resourceLocatorService.init();

  const existingIds = new Set(bountyService.listBounties().map((bounty) => bounty.id));
  const seeded = [];
  const skipped = [];

  for (const definition of DEMO_BOUNTIES) {
    if (existingIds.has(definition.id)) {
      skipped.push(definition.id);
      continue;
    }

    const torrent = buildTorrentPayload(definition, trackerUrl);
    const rewardAmountUnits = Math.round(definition.rewardUsdc * 1_000_000);
    const { resource } = await resourceLocatorService.ensureResourceForBounty({
      torrentInfoHash: torrent.infoHash,
      bountyId: definition.id,
      title: definition.title,
      description: definition.description,
      rewardAmountUnits,
      rewardToken: "USDC",
    });

    let resourceLocator = resource;
    if (definition.status === "COMPLETED") {
      resourceLocator = await resourceLocatorService.archiveResource({
        torrentInfoHash: torrent.infoHash,
        contractId: `demo-contract-${definition.id}`,
        walrusBlobId: definition.walrusBlobId,
        walrusObjectId: `demo-object-${definition.id}`,
      });
    }

    const bounty = await bountyService.createBounty({
      bountyId: definition.id,
      creatorUserId: DEMO_CREATOR_USER_ID,
      title: definition.title,
      description: definition.description,
      torrentInfoHash: torrent.infoHash,
      torrentName: `${definition.id}.torrent`,
      rewardAmountUnits,
      rewardToken: "USDC",
      tags: ["demo", ...definition.tags],
      escrowId: `demo-escrow-${definition.id}`,
      escrowStatus: definition.status === "COMPLETED" ? "RELEASED" : "FUNDED",
      funding: {
        chain: "arc",
        token: "USDC",
        escrowContractAddress,
        demo: true,
      },
      torrentFileBase64: torrent.torrentBytes.toString("base64"),
      pieceCount: torrent.pieceCount,
      pieceLength: PIECE_LENGTH,
      totalSize: torrent.totalSize,
      files: torrent.files,
      resourceLocator,
    });

    seeded.push({
      id: bounty.id,
      status: bounty.status,
      ensName: resourceLocator.ensName,
      infoHash: torrent.infoHash,
    });
  }

  console.log(JSON.stringify({
    dataDir,
    escrowContractAddress,
    seeded,
    skipped,
  }, null, 2));
}

seedDemoBounties().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
