import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createEnsLocatorAdapterFromEnv,
  ResourceLocatorService,
  ViemEnsV2LocatorAdapter,
} from "../src/resource-locator-service.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-resource-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createTestEnsV2Adapter({ parentName = "lazarus.eth", reads = [], writes = [] } = {}) {
  const account = {
    address: "0x00000000000000000000000000000000000000aa",
  };
  const childRegistry = "0x00000000000000000000000000000000000000bb";
  const resolver = "0x00000000000000000000000000000000000000cc";

  return {
    adapter: new ViemEnsV2LocatorAdapter({
      parentName,
      publicClient: {
        async readContract(call) {
          reads.push(call);
          if (call.functionName === "getSubregistry") {
            return childRegistry;
          }
          if (call.functionName === "getResolver") {
            return resolver;
          }
          if (call.functionName === "getState") {
            return {
              status: 0,
              expiry: 0n,
              latestOwner: "0x0000000000000000000000000000000000000000",
              tokenId: 0n,
              resource: 0n,
            };
          }

          throw new Error(`unexpected read: ${call.functionName}`);
        },
        async waitForTransactionReceipt({ hash }) {
          return { transactionHash: hash, blockNumber: 789n };
        },
      },
      walletClient: {
        async writeContract(call) {
          writes.push(call);
          return "0x123789";
        },
      },
      account,
      now: () => 1_700_000_000,
    }),
    account,
    childRegistry,
    resolver,
    reads,
    writes,
  };
}

test("resource locator creates one deterministic ENS subname per unique torrent", async () => {
  await withTempDir(async (tempDir) => {
    const { adapter } = createTestEnsV2Adapter();
    const service = new ResourceLocatorService({
      dataDir: tempDir,
      ensAdapter: adapter,
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
    const { adapter } = createTestEnsV2Adapter();
    const service = new ResourceLocatorService({
      dataDir: tempDir,
      ensAdapter: adapter,
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

test("viem ENSv2 adapter registers subnames through the parent child registry", async () => {
  const { account, adapter, childRegistry, reads, resolver, writes } = createTestEnsV2Adapter();

  const result = await adapter.ensureSubname({
    torrentInfoHash: "0123456789abcdef0123456789abcdef01234567",
  });

  assert.equal(result.ensName, "b-0123456789abcdef.lazarus.eth");
  assert.equal(result.created, true);
  assert.equal(result.registry, childRegistry);
  assert.equal(result.resolver, resolver);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].address, childRegistry);
  assert.equal(writes[0].functionName, "register");
  assert.equal(writes[0].args[0], "b-0123456789abcdef");
  assert.equal(writes[0].args[1], account.address);
  assert.equal(writes[0].args[3], resolver);
  assert.equal(writes[0].args[5], 1731536000n);
  assert.equal(reads.some((call) => call.functionName === "getSubregistry"), true);
  assert.equal(reads.some((call) => call.functionName === "getResolver"), true);
});

test("viem ENSv2 adapter writes Walrus blob text records to the discovered resolver", async () => {
  const { adapter, resolver, writes } = createTestEnsV2Adapter();

  const result = await adapter.setWalrusBlob({
    ensName: "b-0123456789abcdef.lazarus.eth",
    walrusBlobId: "walrus_blob_0123456789",
  });

  assert.equal(result.transactionHash, "0x123789");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].address, resolver);
  assert.equal(writes[0].functionName, "setText");
  assert.equal(writes[0].args[1], "bitlazarus.walrus.blob");
  assert.equal(writes[0].args[2], "walrus_blob_0123456789");
});

test("ENS adapter factory always requires production ENSv2 configuration", () => {
  assert.throws(
    () => createEnsLocatorAdapterFromEnv({ ENS_PARENT_NAME: "lazarus.eth" }),
    /ENS_RPC_URL or ETH_RPC_URL is required/,
  );
  assert.throws(
    () => createEnsLocatorAdapterFromEnv({ ENS_PARENT_NAME: "lazarus.eth", ENS_RPC_URL: "https://rpc.example" }),
    /ENS_PRIVATE_KEY or PRIVATE_KEY is required/,
  );
  assert.throws(
    () => createEnsLocatorAdapterFromEnv({
      ENS_RPC_URL: "https://rpc.example",
      ENS_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    }),
    /ENS_PARENT_NAME is required/,
  );
});

test("ENS adapter factory returns the production ENSv2 adapter", () => {
  const adapter = createEnsLocatorAdapterFromEnv({
    ENS_PARENT_NAME: "lazarus.eth",
    ENS_RPC_URL: "https://rpc.example",
    ENS_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  });

  assert.equal(adapter instanceof ViemEnsV2LocatorAdapter, true);
  assert.equal(adapter.parentName, "lazarus.eth");
});
