import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAddress, namehash, parseAbi, toHex } from "viem";
import { packetToBytes } from "viem/ens";
import { ArcEscrowService } from "../src/arc-escrow-service.js";
import {
  createResourceLocatorServiceFromEnv,
  ResourceLocatorService,
} from "../src/resource-locator-service.js";

const resolverReadAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
]);

const escrowAddress = "0x1111111111111111111111111111111111111111";
const usdcAddress = "0x3600000000000000000000000000000000000000";
const zeroAddress = "0x0000000000000000000000000000000000000000";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-resource-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createArcService(bountiesByInfoHash = new Map()) {
  return new ArcEscrowService({
    contractAddress: escrowAddress,
    usdcAddress,
    publicClient: {
      async readContract({ functionName, args }) {
        const infoHash = String(args[0]).toLowerCase().replace(/^0x/, "");
        const record = bountiesByInfoHash.get(infoHash);

        if (functionName === "bountyIdByInfoHash") {
          return record?.bountyId ?? 0n;
        }

        if (functionName === "getBountyByInfoHash") {
          return record?.rawBounty ?? {
            infoHash: args[0],
            requester: zeroAddress,
            hunter: zeroAddress,
            rewardAmount: 0n,
            status: 0,
            deliveryHash: `0x${"0".repeat(64)}`,
            walrusBlobId: "",
            spec: "",
            createdAt: 0n,
            deadlineAt: 0n,
          };
        }

        throw new Error(`unsupported read: ${functionName}`);
      },
    },
  });
}

function createArcBounty({
  bountyId = 1n,
  infoHash,
  status = 1,
  walrusBlobId = "",
  spec = "",
  rewardAmount = 25_000_000n,
}) {
  return {
    bountyId,
    rawBounty: {
      infoHash: `0x${infoHash}`,
      requester: "0x00000000000000000000000000000000000000AA",
      hunter: status >= 2 ? "0x00000000000000000000000000000000000000BB" : zeroAddress,
      rewardAmount,
      status,
      deliveryHash: `0x${"a".repeat(64)}`,
      walrusBlobId,
      spec,
      createdAt: 1_780_000_001n,
      deadlineAt: 1_780_086_401n,
    },
  };
}

function createService(dataDir, options = {}) {
  return new ResourceLocatorService({
    dataDir,
    parentName: "bitlazarus.eth",
    walrusGatewayBaseUrl: "https://walrus.example/blobs",
    escrowAddress,
    ...options,
  });
}

function encodeResolveCall(ensName, resolverData) {
  return encodeFunctionData({
    abi: resolverReadAbi,
    functionName: "resolve",
    args: [toHex(packetToBytes(ensName)), resolverData],
  });
}

function encodeTextCall(ensName, key) {
  return encodeFunctionData({
    abi: resolverReadAbi,
    functionName: "text",
    args: [namehash(ensName), key],
  });
}

function decodeStringResponse(data) {
  const [value] = decodeAbiParameters([{ type: "string" }], data);
  return value;
}

function decodeAddressResponse(data) {
  const [value] = decodeAbiParameters([{ type: "address" }], data);
  return value;
}

test("resource locator requires Arc escrow integration", () => {
  assert.throws(
    () => new ResourceLocatorService({ parentName: "bitlazarus.eth" }),
    /arcEscrowService is required/,
  );

  assert.throws(
    () => createResourceLocatorServiceFromEnv({
      ENS_PARENT_NAME: "bitlazarus.eth",
    }),
    /ARC_ESCROW_CONTRACT_ADDRESS is required/,
  );
});

test("resource locator derives deterministic wildcard ENS names", async () => {
  await withTempDir(async (tempDir) => {
    const service = createService(tempDir, {
      arcEscrowService: createArcService(),
    });
    await service.init();

    assert.equal(
      service.deriveName("0123456789abcdef0123456789abcdef01234567"),
      "btih-0123456789abcdef0123456789abcdef01234567.bitlazarus.eth",
    );
  });
});

test("resource locator parses torrent infohashes from ENS locator names", async () => {
  await withTempDir(async (tempDir) => {
    const service = createService(tempDir, {
      arcEscrowService: createArcService(),
    });
    await service.init();

    assert.equal(
      service.getTorrentInfoHashFromLocator("btih-0123456789abcdef0123456789abcdef01234567.bitlazarus.eth"),
      "0123456789abcdef0123456789abcdef01234567",
    );
    assert.equal(
      service.getTorrentInfoHashFromLocator("0123456789abcdef0123456789abcdef01234567"),
      "0123456789abcdef0123456789abcdef01234567",
    );
    assert.throws(
      () => service.getTorrentInfoHashFromLocator("btih-0123456789abcdef0123456789abcdef01234567.other.eth"),
      /locator must be/,
    );
  });
});

test("resource locator resolves archived ENS locator names to Walrus", async () => {
  await withTempDir(async (tempDir) => {
    const infoHash = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const service = createService(tempDir, {
      arcEscrowService: createArcService(new Map([
        [infoHash, createArcBounty({
          infoHash,
          status: 4,
          walrusBlobId: "walrus_blob_eeeeeeeeeeee",
        })],
      ])),
    });
    await service.init();

    const resolution = await service.resolveLocator(`btih-${infoHash}.bitlazarus.eth`);

    assert.equal(resolution.mode, "walrus");
    assert.equal(resolution.torrentInfoHash, infoHash);
    assert.equal(resolution.ensName, `btih-${infoHash}.bitlazarus.eth`);
    assert.equal(resolution.walrusBlobId, "walrus_blob_eeeeeeeeeeee");
    assert.equal(resolution.retrievalUrl, "https://walrus.example/blobs/walrus_blob_eeeeeeeeeeee");
  });
});

test("resource locator answers ENSIP-10 text lookups from Arc escrow state", async () => {
  await withTempDir(async (tempDir) => {
    const infoHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const arcBounties = new Map([
      [infoHash, createArcBounty({
        bountyId: 7n,
        infoHash,
        status: 4,
        walrusBlobId: "walrus_blob_bbbbbbbbbbbb",
        spec: "Recovered public domain footage",
        rewardAmount: 42_000_000n,
      })],
    ]);
    const service = createService(tempDir, {
      arcEscrowService: createArcService(arcBounties),
    });
    await service.init();

    const ensName = "btih-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bitlazarus.eth";
    const blobResponse = await service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "walrus.blob")),
    });
    const statusResponse = await service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "status")),
    });
    const infoHashResponse = await service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "infohash")),
    });
    const descriptionResponse = await service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "description")),
    });
    const rewardResponse = await service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "reward")),
    });
    const urlResponse = await service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "url")),
    });

    assert.equal(decodeStringResponse(blobResponse.data), "walrus_blob_bbbbbbbbbbbb");
    assert.equal(decodeStringResponse(statusResponse.data), "archived");
    assert.equal(decodeStringResponse(infoHashResponse.data), infoHash);
    assert.equal(decodeStringResponse(descriptionResponse.data), "Recovered public domain footage");
    assert.equal(decodeStringResponse(rewardResponse.data), "42000000 USDC");
    assert.equal(decodeStringResponse(urlResponse.data), "https://walrus.example/blobs/walrus_blob_bbbbbbbbbbbb");
  });
});

test("resource locator accepts abi-encoded CCIP callData payloads", async () => {
  await withTempDir(async (tempDir) => {
    const infoHash = "cccccccccccccccccccccccccccccccccccccccc";
    const service = createService(tempDir, {
      arcEscrowService: createArcService(new Map([
        [infoHash, createArcBounty({ infoHash, status: 1 })],
      ])),
    });
    await service.init();

    const ensName = "btih-cccccccccccccccccccccccccccccccccccccccc.bitlazarus.eth";
    const response = await service.answerCcipRead({
      data: encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes" }],
        [toHex(packetToBytes(ensName)), encodeTextCall(ensName, "status")],
      ),
    });

    assert.equal(decodeStringResponse(response.data), "open");
  });
});

test("resource locator answers addr lookups with the Arc escrow contract address", async () => {
  await withTempDir(async (tempDir) => {
    const service = createService(tempDir, {
      arcEscrowService: createArcService(),
    });
    await service.init();

    const ensName = "btih-dddddddddddddddddddddddddddddddddddddddd.bitlazarus.eth";
    const response = await service.answerCcipRead({
      data: encodeResolveCall(
        ensName,
        encodeFunctionData({
          abi: resolverReadAbi,
          functionName: "addr",
          args: [namehash(ensName)],
        }),
      ),
    });

    assert.equal(decodeAddressResponse(response.data), getAddress(escrowAddress));
  });
});

test("resource locator returns empty Arc-backed records for unknown wildcard names", async () => {
  await withTempDir(async (tempDir) => {
    const service = createService(tempDir, {
      arcEscrowService: createArcService(),
    });
    await service.init();

    const ensName = "btih-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.bitlazarus.eth";
    const response = await service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "walrus.blob")),
    });

    assert.equal(decodeStringResponse(response.data), "");
  });
});

test("resource locator factory builds the Arc-backed production service", () => {
  const service = createResourceLocatorServiceFromEnv({
    ENS_PARENT_NAME: "bitlazarus.eth",
    ENS_NETWORK: "sepolia",
    WALRUS_GATEWAY_BASE_URL: "https://walrus.example/blobs",
    ARC_RPC_URL: "https://rpc.testnet.arc.network",
    ARC_ESCROW_CONTRACT_ADDRESS: escrowAddress,
    ARC_USDC_ADDRESS: usdcAddress,
  });

  assert.equal(service.parentName, "bitlazarus.eth");
  assert.equal(service.ensNetwork, "sepolia");
  assert.equal(service.escrowAddress, escrowAddress);
  assert.equal(service.getWalrusRetrievalUrl("blob-1"), "https://walrus.example/blobs/blob-1");
});
