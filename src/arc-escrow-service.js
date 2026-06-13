import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
} from "viem";

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const DEFAULT_ARC_RPC_URL = "https://rpc.testnet.arc.network";
export const DEFAULT_ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: {
    default: {
      http: [DEFAULT_ARC_RPC_URL],
      webSocket: ["wss://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "Arcscan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

export const arcEscrowAbi = [
  {
    type: "function",
    name: "getBountyByInfoHash",
    stateMutability: "view",
    inputs: [{ name: "infoHash", type: "bytes20" }],
    outputs: [
      {
        name: "bounty",
        type: "tuple",
        components: [
          { name: "infoHash", type: "bytes20" },
          { name: "requester", type: "address" },
          { name: "hunter", type: "address" },
          { name: "rewardAmount", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "deliveryHash", type: "bytes32" },
          { name: "walrusBlobId", type: "string" },
          { name: "spec", type: "string" },
          { name: "createdAt", type: "uint64" },
          { name: "deadlineAt", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "bountyIdByInfoHash",
    stateMutability: "view",
    inputs: [{ name: "infoHash", type: "bytes20" }],
    outputs: [{ name: "bountyId", type: "uint256" }],
  },
  {
    type: "function",
    name: "createBounty",
    stateMutability: "nonpayable",
    inputs: [
      { name: "infoHash", type: "bytes20" },
      { name: "rewardAmount", type: "uint256" },
      { name: "spec", type: "string" },
      { name: "deadlineAt", type: "uint64" },
    ],
    outputs: [{ name: "bountyId", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimBounty",
    stateMutability: "nonpayable",
    inputs: [{ name: "bountyId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "submitDelivery",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bountyId", type: "uint256" },
      { name: "deliveryHash", type: "bytes32" },
      { name: "walrusBlobId", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "confirmDelivery",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bountyId", type: "uint256" },
      { name: "walrusBlobId", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refundExpired",
    stateMutability: "nonpayable",
    inputs: [{ name: "bountyId", type: "uint256" }],
    outputs: [],
  },
];

export const erc20ApprovalAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "ok", type: "bool" }],
  },
];

const ARC_STATUS_BY_INDEX = [
  "NONE",
  "OPEN",
  "CLAIMED",
  "SUBMITTED",
  "RESOLVED",
  "REFUNDED",
  "DISPUTED",
];

function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
}

function assertPositiveBigInt(value, fieldName) {
  const amount = BigInt(value);

  if (amount <= 0n) {
    throw new Error(`${fieldName} must be positive`);
  }

  return amount;
}

function assertBytes32(value, fieldName) {
  assertString(value, fieldName);
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");

  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }

  return `0x${normalized}`;
}

export function normalizeTorrentInfoHash(infoHash) {
  assertString(infoHash, "torrentInfoHash");
  const normalized = infoHash.trim().toLowerCase().replace(/^0x/, "");

  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("torrentInfoHash must be a 40-character hex string");
  }

  return normalized;
}

export function infoHashToBytes20(infoHash) {
  return `0x${normalizeTorrentInfoHash(infoHash)}`;
}

export function normalizeArcStatus(status) {
  const index = Number(status);
  return ARC_STATUS_BY_INDEX[index] ?? "UNKNOWN";
}

export function getLocatorStatusForArcStatus(status) {
  switch (normalizeArcStatus(status)) {
    case "OPEN":
      return "open";
    case "CLAIMED":
    case "SUBMITTED":
      return "claimed";
    case "RESOLVED":
      return "archived";
    case "REFUNDED":
    case "DISPUTED":
      return "closed";
    default:
      return "";
  }
}

export function createArcEscrowServiceFromEnv(environment = process.env, options = {}) {
  const contractAddress = environment.ARC_ESCROW_CONTRACT_ADDRESS ?? options.contractAddress;

  return new ArcEscrowService({
    ...options,
    rpcUrl: environment.ARC_RPC_URL ?? options.rpcUrl ?? DEFAULT_ARC_RPC_URL,
    contractAddress,
    usdcAddress: environment.ARC_USDC_ADDRESS ?? options.usdcAddress ?? DEFAULT_ARC_USDC_ADDRESS,
  });
}

export class ArcEscrowService {
  constructor({
    rpcUrl = DEFAULT_ARC_RPC_URL,
    contractAddress,
    usdcAddress = DEFAULT_ARC_USDC_ADDRESS,
    publicClient = null,
  } = {}) {
    assertString(rpcUrl, "ARC_RPC_URL");
    assertString(contractAddress, "ARC_ESCROW_CONTRACT_ADDRESS");

    if (!isAddress(contractAddress)) {
      throw new Error("ARC_ESCROW_CONTRACT_ADDRESS must be an Ethereum address");
    }

    if (!isAddress(usdcAddress)) {
      throw new Error("ARC_USDC_ADDRESS must be an Ethereum address");
    }

    this.rpcUrl = rpcUrl;
    this.contractAddress = getAddress(contractAddress);
    this.usdcAddress = getAddress(usdcAddress);
    this.publicClient = publicClient ?? createPublicClient({
      chain: arcTestnet,
      transport: http(rpcUrl),
    });
  }

  async getBountyIdByInfoHash(torrentInfoHash) {
    const bountyId = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: arcEscrowAbi,
      functionName: "bountyIdByInfoHash",
      args: [infoHashToBytes20(torrentInfoHash)],
    });

    return bountyId === 0n ? null : bountyId;
  }

  async getBountyByInfoHash(torrentInfoHash) {
    const [bountyId, rawBounty] = await Promise.all([
      this.getBountyIdByInfoHash(torrentInfoHash),
      this.publicClient.readContract({
        address: this.contractAddress,
        abi: arcEscrowAbi,
        functionName: "getBountyByInfoHash",
        args: [infoHashToBytes20(torrentInfoHash)],
      }),
    ]);

    if (!bountyId || rawBounty.requester === ZERO_ADDRESS) {
      return null;
    }

    return this.formatBounty({ bountyId, rawBounty });
  }

  formatBounty({ bountyId, rawBounty }) {
    const status = normalizeArcStatus(rawBounty.status);
    return {
      bountyId: bountyId.toString(),
      torrentInfoHash: normalizeTorrentInfoHash(rawBounty.infoHash),
      requester: rawBounty.requester,
      hunter: rawBounty.hunter === ZERO_ADDRESS ? null : rawBounty.hunter,
      rewardAmountUnits: rawBounty.rewardAmount.toString(),
      rewardToken: "USDC",
      contractStatus: status,
      locatorStatus: getLocatorStatusForArcStatus(rawBounty.status),
      deliveryHash: rawBounty.deliveryHash,
      walrusBlobId: rawBounty.walrusBlobId || null,
      spec: rawBounty.spec || null,
      createdAt: Number(rawBounty.createdAt),
      deadlineAt: Number(rawBounty.deadlineAt),
    };
  }

  buildApprovalTransaction({ rewardAmountUnits }) {
    const amount = assertPositiveBigInt(rewardAmountUnits, "rewardAmountUnits");

    return {
      chainId: ARC_TESTNET_CHAIN_ID,
      to: this.usdcAddress,
      value: "0x0",
      data: encodeFunctionData({
        abi: erc20ApprovalAbi,
        functionName: "approve",
        args: [this.contractAddress, amount],
      }),
    };
  }

  buildCreateBountyTransaction({
    torrentInfoHash,
    rewardAmountUnits,
    spec = "",
    deadlineAt = 0,
  }) {
    const amount = assertPositiveBigInt(rewardAmountUnits, "rewardAmountUnits");
    const normalizedDeadlineAt = BigInt(deadlineAt);

    return {
      chainId: ARC_TESTNET_CHAIN_ID,
      to: this.contractAddress,
      value: "0x0",
      data: encodeFunctionData({
        abi: arcEscrowAbi,
        functionName: "createBounty",
        args: [
          infoHashToBytes20(torrentInfoHash),
          amount,
          spec ?? "",
          normalizedDeadlineAt,
        ],
      }),
    };
  }

  buildClaimBountyTransaction({ bountyId }) {
    return this.buildEscrowTransaction("claimBounty", [BigInt(bountyId)]);
  }

  buildSubmitDeliveryTransaction({ bountyId, deliveryHash, walrusBlobId = "" }) {
    return this.buildEscrowTransaction("submitDelivery", [
      BigInt(bountyId),
      assertBytes32(deliveryHash, "deliveryHash"),
      walrusBlobId ?? "",
    ]);
  }

  buildConfirmDeliveryTransaction({ bountyId, walrusBlobId }) {
    assertString(walrusBlobId, "walrusBlobId");
    return this.buildEscrowTransaction("confirmDelivery", [BigInt(bountyId), walrusBlobId.trim()]);
  }

  buildRefundExpiredTransaction({ bountyId }) {
    return this.buildEscrowTransaction("refundExpired", [BigInt(bountyId)]);
  }

  buildEscrowTransaction(functionName, args) {
    return {
      chainId: ARC_TESTNET_CHAIN_ID,
      to: this.contractAddress,
      value: "0x0",
      data: encodeFunctionData({
        abi: arcEscrowAbi,
        functionName,
        args,
      }),
    };
  }
}
