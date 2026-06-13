import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { decodeAbiParameters, encodeFunctionData, namehash, parseAbi, toHex } from "viem";
import { packetToBytes } from "viem/ens";
import {
  answerCcipGatewayRequest,
  getCcipGatewayHealth,
} from "../src/ccip-gateway-server.js";
import { ResourceLocatorService } from "../src/resource-locator-service.js";

const resolverReadAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
]);

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-ccip-gateway-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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

test("CCIP gateway serves ENS wildcard reads without starting the full node", async () => {
  await withTempDir(async (tempDir) => {
    const resourceLocatorService = new ResourceLocatorService({
      dataDir: tempDir,
      parentName: "bitlazarus.eth",
      walrusGatewayBaseUrl: "https://walrus.example/blobs",
    });
    await resourceLocatorService.init();

    await resourceLocatorService.ensureResourceForBounty({
      torrentInfoHash: "abababababababababababababababababababab",
      bountyId: "bounty-ab",
      description: "Recovered public domain dataset",
    });
    await resourceLocatorService.archiveResource({
      torrentInfoHash: "abababababababababababababababababababab",
      contractId: "contract-ab",
      walrusBlobId: "walrus_blob_ababababab",
    });

    assert.deepEqual(getCcipGatewayHealth({ resourceLocatorService }), {
      ok: true,
      service: "bit-lazarus-ccip-gateway",
      parentName: "bitlazarus.eth",
      ensNetwork: "sepolia",
    });

    const ensName = "btih-abababababababababababababababababababab.bitlazarus.eth";
    const data = encodeResolveCall(ensName, encodeTextCall(ensName, "walrus.blob"));
    const ccipResponse = answerCcipGatewayRequest({
      resourceLocatorService,
      sender: "0x0000000000000000000000000000000000000000",
      data,
    });

    assert.equal(decodeStringResponse(ccipResponse.data), "walrus_blob_ababababab");
  });
});
