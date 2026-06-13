import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createEnsLocatorAdapterFromEnv,
  MockEnsLocatorAdapter,
  ResourceLocatorService,
  ViemEnsLocatorAdapter,
} from "../src/resource-locator-service.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-resource-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("resource locator creates one deterministic ENS subname per unique torrent", async () => {
  await withTempDir(async (tempDir) => {
    const service = new ResourceLocatorService({
      dataDir: tempDir,
      ensAdapter: new MockEnsLocatorAdapter({ parentName: "lazarus.eth", network: "sepolia" }),
    });
    await service.init();

    const first = await service.ensureResourceForBounty({
      torrentInfoHash: "0123456789abcdef0123456789abcdef01234567",
      bountyId: "bounty-1",
    });
    const second = await service.ensureResourceForBounty({
      torrentInfoHash: "0123456789abcdef0123456789abcdef01234567",
      bountyId: "bounty-2",
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.resource.ensName, "b-0123456789abcdef.lazarus.eth");
    assert.equal(second.resource.ensName, first.resource.ensName);
    assert.deepEqual(second.resource.bountyIds, ["bounty-1", "bounty-2"]);
  });
});

test("resource locator resolves to torrent before archive and Walrus after archive", async () => {
  await withTempDir(async (tempDir) => {
    const service = new ResourceLocatorService({
      dataDir: tempDir,
      walrusGatewayBaseUrl: "https://walrus.example/blobs",
    });
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

test("viem ENS adapter creates unwrapped subnames through the ENS registry", async () => {
  const account = {
    address: "0x00000000000000000000000000000000000000aa",
  };
  const writes = [];
  let ownerReadCount = 0;
  const publicClient = {
    async readContract({ functionName }) {
      if (functionName === "owner") {
        ownerReadCount += 1;
        return ownerReadCount === 1
          ? "0x0000000000000000000000000000000000000000"
          : account.address;
      }

      throw new Error(`unexpected read: ${functionName}`);
    },
    async waitForTransactionReceipt({ hash }) {
      return { transactionHash: hash, blockNumber: 123n };
    },
  };
  const walletClient = {
    async writeContract(call) {
      writes.push(call);
      return "0xabc123";
    },
  };
  const adapter = new ViemEnsLocatorAdapter({
    parentName: "lazarus.eth",
    publicClient,
    walletClient,
    account,
  });

  const result = await adapter.ensureSubname({
    torrentInfoHash: "0123456789abcdef0123456789abcdef01234567",
  });

  assert.equal(result.ensName, "b-0123456789abcdef.lazarus.eth");
  assert.equal(result.created, true);
  assert.equal(result.transactionHash, "0xabc123");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].functionName, "setSubnodeRecord");
  assert.equal(writes[0].args[2], account.address);
});

test("viem ENS adapter writes Walrus blob text records to the resolver", async () => {
  const account = {
    address: "0x00000000000000000000000000000000000000aa",
  };
  const writes = [];
  const adapter = new ViemEnsLocatorAdapter({
    parentName: "lazarus.eth",
    publicClient: {
      async readContract() {
        throw new Error("should not read for setWalrusBlob");
      },
      async waitForTransactionReceipt({ hash }) {
        return { transactionHash: hash, blockNumber: 456n };
      },
    },
    walletClient: {
      async writeContract(call) {
        writes.push(call);
        return "0xdef456";
      },
    },
    account,
  });

  const result = await adapter.setWalrusBlob({
    ensName: "b-0123456789abcdef.lazarus.eth",
    walrusBlobId: "walrus_blob_0123456789",
  });

  assert.equal(result.transactionHash, "0xdef456");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].functionName, "setText");
  assert.equal(writes[0].args[1], "bitlazarus.walrus.blob");
  assert.equal(writes[0].args[2], "walrus_blob_0123456789");
});

test("ENS adapter factory fails fast when production mode lacks credentials", () => {
  assert.throws(
    () => createEnsLocatorAdapterFromEnv({ ENS_ADAPTER: "viem", ENS_PARENT_NAME: "lazarus.eth" }),
    /ENS_RPC_URL or ETH_RPC_URL is required/,
  );
});
