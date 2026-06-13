import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, namehash, parseAbi, toHex } from "viem";
import { packetToBytes } from "viem/ens";
import {
  createResourceLocatorServiceFromEnv,
  ResourceLocatorService,
} from "../src/resource-locator-service.js";

const resolverReadAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
]);

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-resource-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createService(dataDir, options = {}) {
  return new ResourceLocatorService({
    dataDir,
    parentName: "bitlazarus.eth",
    walrusGatewayBaseUrl: "https://walrus.example/blobs",
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

test("resource locator derives one wildcard ENS name per unique torrent", async () => {
  await withTempDir(async (tempDir) => {
    const service = createService(tempDir);
    await service.init();

    const first = await service.ensureResourceForBounty({
      torrentInfoHash: "0123456789abcdef0123456789abcdef01234567",
      bountyId: "bounty-1",
      title: "Lost distro ISO",
      rewardSats: 5000,
    });
    const second = await service.ensureResourceForBounty({
      torrentInfoHash: "0123456789abcdef0123456789abcdef01234567",
      bountyId: "bounty-2",
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.resource.ensName, "btih-0123456789abcdef0123456789abcdef01234567.bitlazarus.eth");
    assert.equal(second.resource.ensName, first.resource.ensName);
    assert.deepEqual(second.resource.bountyIds, ["bounty-1", "bounty-2"]);
    assert.equal(second.resource.title, "Lost distro ISO");
    assert.equal(second.resource.rewardSats, 5000);
  });
});

test("resource locator resolves to torrent before archive and Walrus after archive", async () => {
  await withTempDir(async (tempDir) => {
    const service = createService(tempDir);
    await service.init();

    await service.ensureResourceForBounty({
      torrentInfoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      bountyId: "bounty-a",
    });

    const torrentResolution = service.resolveResource("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(torrentResolution.mode, "torrent");
    assert.equal(torrentResolution.activeBountyId, "bounty-a");

    const archived = await service.archiveResource({
      torrentInfoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      contractId: "contract-a",
      walrusBlobId: "walrus_blob_0123456789",
      walrusObjectId: "object-a",
    });
    const walrusResolution = service.resolveResource("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    assert.equal(archived.locatorStatus, "ARCHIVED");
    assert.equal(walrusResolution.mode, "walrus");
    assert.equal(walrusResolution.walrusBlobId, "walrus_blob_0123456789");
    assert.equal(walrusResolution.retrievalUrl, "https://walrus.example/blobs/walrus_blob_0123456789");
  });
});

test("resource locator answers ENSIP-10 text lookups from canonical resource state", async () => {
  await withTempDir(async (tempDir) => {
    const service = createService(tempDir);
    await service.init();

    await service.ensureResourceForBounty({
      torrentInfoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      bountyId: "bounty-b",
      description: "Recovered public domain footage",
    });
    await service.archiveResource({
      torrentInfoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      contractId: "contract-b",
      walrusBlobId: "walrus_blob_bbbbbbbbbbbb",
    });

    const ensName = "btih-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bitlazarus.eth";
    const blobResponse = service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "walrus.blob")),
    });
    const statusResponse = service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "status")),
    });
    const infoHashResponse = service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "infohash")),
    });
    const descriptionResponse = service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "description")),
    });

    assert.equal(decodeStringResponse(blobResponse.data), "walrus_blob_bbbbbbbbbbbb");
    assert.equal(decodeStringResponse(statusResponse.data), "archived");
    assert.equal(decodeStringResponse(infoHashResponse.data), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(decodeStringResponse(descriptionResponse.data), "Recovered public domain footage");
  });
});

test("resource locator accepts abi-encoded CCIP callData payloads", async () => {
  await withTempDir(async (tempDir) => {
    const service = createService(tempDir);
    await service.init();

    await service.ensureResourceForBounty({
      torrentInfoHash: "cccccccccccccccccccccccccccccccccccccccc",
      bountyId: "bounty-c",
    });

    const ensName = "btih-cccccccccccccccccccccccccccccccccccccccc.bitlazarus.eth";
    const response = service.answerCcipRead({
      data: encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes" }],
        [toHex(packetToBytes(ensName)), encodeTextCall(ensName, "status")],
      ),
    });

    assert.equal(decodeStringResponse(response.data), "open");
  });
});

test("resource locator answers addr lookups with the escrow contract address", async () => {
  await withTempDir(async (tempDir) => {
    const service = createService(tempDir, {
      escrowAddress: "0x00000000000000000000000000000000000000aa",
    });
    await service.init();

    const ensName = "btih-dddddddddddddddddddddddddddddddddddddddd.bitlazarus.eth";
    const response = service.answerCcipRead({
      data: encodeResolveCall(
        ensName,
        encodeFunctionData({
          abi: resolverReadAbi,
          functionName: "addr",
          args: [namehash(ensName)],
        }),
      ),
    });

    assert.equal(decodeAddressResponse(response.data), "0x00000000000000000000000000000000000000AA");
  });
});

test("resource locator returns empty text for unknown wildcard names", async () => {
  await withTempDir(async (tempDir) => {
    const service = createService(tempDir);
    await service.init();

    const ensName = "btih-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.bitlazarus.eth";
    const response = service.answerCcipRead({
      data: encodeResolveCall(ensName, encodeTextCall(ensName, "walrus.blob")),
    });

    assert.equal(decodeStringResponse(response.data), "");
  });
});

test("resource locator factory always builds the wildcard production service", () => {
  assert.throws(
    () => createResourceLocatorServiceFromEnv({}),
    /ENS_PARENT_NAME is required/,
  );

  const service = createResourceLocatorServiceFromEnv({
    ENS_PARENT_NAME: "bitlazarus.eth",
    ENS_NETWORK: "sepolia",
    WALRUS_GATEWAY_BASE_URL: "https://walrus.example/blobs",
  });

  assert.equal(service.parentName, "bitlazarus.eth");
  assert.equal(service.ensNetwork, "sepolia");
  assert.equal(service.getWalrusRetrievalUrl("blob-1"), "https://walrus.example/blobs/blob-1");
});
