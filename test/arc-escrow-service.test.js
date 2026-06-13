import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, getAddress } from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  ArcEscrowService,
  arcEscrowAbi,
  createArcEscrowServiceFromEnv,
  erc20ApprovalAbi,
  getLocatorStatusForArcStatus,
  infoHashToBytes20,
  normalizeArcStatus,
} from "../src/arc-escrow-service.js";

const contractAddress = "0x831ad29969e853e668ac3e9db4856a1f48acfd0d";
const usdcAddress = "0x3600000000000000000000000000000000000000";
const checksummedContractAddress = getAddress(contractAddress);
const checksummedUsdcAddress = getAddress(usdcAddress);

function createService() {
  return new ArcEscrowService({
    contractAddress,
    usdcAddress,
  });
}

test("Arc escrow service normalizes infohashes for bytes20 contract calls", () => {
  assert.equal(
    infoHashToBytes20("ABCDEFabcdef0123456789abcdef0123456789ab"),
    "0xabcdefabcdef0123456789abcdef0123456789ab",
  );
});

test("Arc escrow service maps contract statuses to ENS locator statuses", () => {
  assert.equal(normalizeArcStatus(0), "NONE");
  assert.equal(normalizeArcStatus(1), "OPEN");
  assert.equal(normalizeArcStatus(2), "CLAIMED");
  assert.equal(normalizeArcStatus(3), "SUBMITTED");
  assert.equal(normalizeArcStatus(4), "RESOLVED");
  assert.equal(getLocatorStatusForArcStatus(1), "open");
  assert.equal(getLocatorStatusForArcStatus(2), "claimed");
  assert.equal(getLocatorStatusForArcStatus(3), "claimed");
  assert.equal(getLocatorStatusForArcStatus(4), "archived");
  assert.equal(getLocatorStatusForArcStatus(5), "closed");
});

test("Arc escrow service builds USDC approval transactions", () => {
  const service = createService();
  const transaction = service.buildApprovalTransaction({
    rewardAmountUnits: 25_000_000,
  });
  const decoded = decodeFunctionData({
    abi: erc20ApprovalAbi,
    data: transaction.data,
  });

  assert.equal(transaction.chainId, ARC_TESTNET_CHAIN_ID);
  assert.equal(transaction.to, checksummedUsdcAddress);
  assert.equal(transaction.value, "0x0");
  assert.equal(decoded.functionName, "approve");
  assert.deepEqual(decoded.args, [checksummedContractAddress, 25_000_000n]);
});

test("Arc escrow service builds create bounty transactions", () => {
  const service = createService();
  const transaction = service.buildCreateBountyTransaction({
    torrentInfoHash: "0123456789abcdef0123456789abcdef01234567",
    rewardAmountUnits: 50_000_000,
    spec: "btih-0123 test",
    deadlineAt: 1_781_000_000,
  });
  const decoded = decodeFunctionData({
    abi: arcEscrowAbi,
    data: transaction.data,
  });

  assert.equal(transaction.chainId, ARC_TESTNET_CHAIN_ID);
  assert.equal(transaction.to, checksummedContractAddress);
  assert.equal(transaction.value, "0x0");
  assert.equal(decoded.functionName, "createBounty");
  assert.deepEqual(decoded.args, [
    "0x0123456789abcdef0123456789abcdef01234567",
    50_000_000n,
    "btih-0123 test",
    1_781_000_000n,
  ]);
});

test("Arc escrow service builds lifecycle transaction payloads", () => {
  const service = createService();
  const claim = decodeFunctionData({
    abi: arcEscrowAbi,
    data: service.buildClaimBountyTransaction({ bountyId: 7 }).data,
  });
  const submit = decodeFunctionData({
    abi: arcEscrowAbi,
    data: service.buildSubmitDeliveryTransaction({
      bountyId: 7,
      deliveryHash: "a".repeat(64),
      walrusBlobId: "walrus_blob_abcdef123456",
    }).data,
  });
  const confirm = decodeFunctionData({
    abi: arcEscrowAbi,
    data: service.buildConfirmDeliveryTransaction({
      bountyId: 7,
      walrusBlobId: "walrus_blob_abcdef123456",
    }).data,
  });

  assert.equal(claim.functionName, "claimBounty");
  assert.deepEqual(claim.args, [7n]);
  assert.equal(submit.functionName, "submitDelivery");
  assert.deepEqual(submit.args, [7n, `0x${"a".repeat(64)}`, "walrus_blob_abcdef123456"]);
  assert.equal(confirm.functionName, "confirmDelivery");
  assert.deepEqual(confirm.args, [7n, "walrus_blob_abcdef123456"]);
});

test("Arc escrow service formats contract bounty state for the app", () => {
  const service = createService();
  const bounty = service.formatBounty({
    bountyId: 9n,
    rawBounty: {
      infoHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      requester: "0x00000000000000000000000000000000000000AA",
      hunter: "0x00000000000000000000000000000000000000BB",
      rewardAmount: 12_500_000n,
      status: 4,
      deliveryHash: `0x${"c".repeat(64)}`,
      walrusBlobId: "walrus_blob_resolved",
      spec: "Lost footage",
      createdAt: 1_780_000_001n,
      deadlineAt: 1_780_086_401n,
    },
  });

  assert.deepEqual(bounty, {
    bountyId: "9",
    torrentInfoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    requester: "0x00000000000000000000000000000000000000AA",
    hunter: "0x00000000000000000000000000000000000000BB",
    rewardAmountUnits: "12500000",
    rewardToken: "USDC",
    contractStatus: "RESOLVED",
    locatorStatus: "archived",
    deliveryHash: `0x${"c".repeat(64)}`,
    walrusBlobId: "walrus_blob_resolved",
    spec: "Lost footage",
    createdAt: 1_780_000_001,
    deadlineAt: 1_780_086_401,
  });
});

test("Arc escrow factory is disabled until contract address is configured", () => {
  assert.equal(createArcEscrowServiceFromEnv({}), null);

  const service = createArcEscrowServiceFromEnv({
    ARC_ESCROW_CONTRACT_ADDRESS: contractAddress,
    ARC_RPC_URL: "https://rpc.testnet.arc.network",
    ARC_USDC_ADDRESS: usdcAddress,
  });

  assert.equal(service.contractAddress, checksummedContractAddress);
  assert.equal(service.usdcAddress, checksummedUsdcAddress);
});
