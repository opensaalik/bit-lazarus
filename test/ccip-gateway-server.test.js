import test from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, encodeFunctionData, namehash, parseAbi, toHex } from "viem";
import { packetToBytes } from "viem/ens";
import {
  answerCcipGatewayRequest,
  getCcipGatewayHealth,
} from "../src/ccip-gateway-server.js";
import { ArcEscrowService } from "../src/arc-escrow-service.js";
import { ResourceLocatorService } from "../src/resource-locator-service.js";

const resolverReadAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
]);

const escrowAddress = "0x831ad29969e853e668ac3e9db4856a1f48acfd0d";
const usdcAddress = "0x3600000000000000000000000000000000000000";
const zeroAddress = "0x0000000000000000000000000000000000000000";

function createArcService() {
  return new ArcEscrowService({
    contractAddress: escrowAddress,
    usdcAddress,
    publicClient: {
      async readContract({ functionName }) {
        if (functionName === "bountyIdByInfoHash") {
          return 11n;
        }

        if (functionName === "getBountyByInfoHash") {
          return {
            infoHash: "0xabababababababababababababababababababab",
            requester: "0x00000000000000000000000000000000000000AA",
            hunter: "0x00000000000000000000000000000000000000BB",
            rewardAmount: 25_000_000n,
            status: 4,
            deliveryHash: `0x${"a".repeat(64)}`,
            walrusBlobId: "walrus_blob_ababababab",
            spec: "Recovered public domain dataset",
            createdAt: 1_780_000_001n,
            deadlineAt: 1_780_086_401n,
          };
        }

        throw new Error(`unsupported read: ${functionName}`);
      },
    },
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

test("CCIP gateway serves ENS wildcard reads without starting the full node", async () => {
  const resourceLocatorService = new ResourceLocatorService({
    parentName: "bitlazarus.eth",
    walrusGatewayBaseUrl: "https://walrus.example/blobs",
    escrowAddress,
    arcEscrowService: createArcService(),
  });

  assert.deepEqual(getCcipGatewayHealth({ resourceLocatorService }), {
    ok: true,
    service: "bit-lazarus-ccip-gateway",
    parentName: "bitlazarus.eth",
    ensNetwork: "sepolia",
    arcEscrowContractAddress: "0x831AD29969E853e668AC3e9Db4856a1f48aCFd0d",
  });

  const ensName = "btih-abababababababababababababababababababab.bitlazarus.eth";
  const data = encodeResolveCall(ensName, encodeTextCall(ensName, "walrus.blob"));
  const ccipResponse = await answerCcipGatewayRequest({
    resourceLocatorService,
    sender: zeroAddress,
    data,
  });

  assert.equal(decodeStringResponse(ccipResponse.data), "walrus_blob_ababababab");
});
