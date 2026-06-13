import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  hexToBytes,
  isHex,
  namehash,
  parseAbi,
} from "viem";
import { normalize } from "viem/ens";
import { createArcEscrowServiceFromEnv } from "./arc-escrow-service.js";

const WALRUS_BLOB_TEXT_KEY = "walrus.blob";
const LEGACY_WALRUS_BLOB_TEXT_KEY = "bitlazarus.walrus.blob";
const INFOHASH_TEXT_KEY = "infohash";
const STATUS_TEXT_KEY = "status";
const RESOURCE_URL_TEXT_KEY = "url";
const DESCRIPTION_TEXT_KEY = "description";
const AVATAR_TEXT_KEY = "avatar";
const REWARD_TEXT_KEY = "reward";
const WALLET_ADDRESS_TEXT_KEY = "address";
const DEFAULT_ENS_NETWORK = "sepolia";
const DEFAULT_WALRUS_GATEWAY_BASE_URL = "https://aggregator.walrus-testnet.walrus.space/v1/blobs";

const resolverReadAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
]);

function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
}

function normalizeTorrentInfoHash(infoHash) {
  assertString(infoHash, "torrentInfoHash");
  const normalized = infoHash.trim().toLowerCase();

  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("torrentInfoHash must be a 40-character hex string");
  }

  return normalized;
}

function normalizeOptionalString(value, fieldName) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeWalrusBlobId(value) {
  assertString(value, "walrusBlobId");
  const trimmed = value.trim();

  if (!/^[A-Za-z0-9_-]{16,256}$/.test(trimmed)) {
    throw new Error("walrusBlobId must be a URL-safe Walrus blob identifier");
  }

  return trimmed;
}

function normalizeParentName(parentName) {
  assertString(parentName, "ENS_PARENT_NAME");
  return normalize(parentName.trim());
}

function appendUnique(values, nextValue) {
  return values.includes(nextValue) ? values : [...values, nextValue];
}

function getLocatorStatusText(locatorStatus) {
  switch (locatorStatus) {
    case "ARCHIVED":
      return "archived";
    case "SEEDING":
      return "claimed";
    case "PENDING_RECOVERY":
      return "open";
    default:
      return "";
  }
}

function decodeDnsEncodedName(encodedName) {
  if (!isHex(encodedName)) {
    throw new Error("dns-encoded ENS name must be hex");
  }

  const bytes = hexToBytes(encodedName);
  const labels = [];
  let offset = 0;

  while (offset < bytes.length) {
    const length = bytes[offset];
    offset += 1;

    if (length === 0) {
      break;
    }

    if (offset + length > bytes.length) {
      throw new Error("invalid dns-encoded ENS name");
    }

    labels.push(new TextDecoder().decode(bytes.slice(offset, offset + length)));
    offset += length;
  }

  return normalize(labels.join("."));
}

function parseInfoHashFromEnsName(ensName, parentName) {
  const normalizedName = normalize(ensName);
  const normalizedParent = normalizeParentName(parentName);
  const suffix = `.${normalizedParent}`;

  if (!normalizedName.endsWith(suffix)) {
    return null;
  }

  const label = normalizedName.slice(0, -suffix.length);
  const match = /^btih-([0-9a-f]{40})$/.exec(label);
  return match?.[1] ?? null;
}

function parseWalletLabelFromEnsName(ensName, parentName) {
  const normalizedName = normalize(ensName);
  const normalizedParent = normalizeParentName(parentName);
  const suffix = `.${normalizedParent}`;

  if (!normalizedName.endsWith(suffix)) {
    return null;
  }

  const label = normalizedName.slice(0, -suffix.length);
  return /^[a-z]{6}$/.test(label) ? label : null;
}

function decodeCcipReadPayload(data) {
  if (!isHex(data)) {
    throw new Error("CCIP calldata must be hex");
  }

  try {
    const decoded = decodeFunctionData({
      abi: resolverReadAbi,
      data,
    });

    if (decoded.functionName === "resolve") {
      return {
        dnsEncodedName: decoded.args[0],
        resolverData: decoded.args[1],
      };
    }
  } catch {
    // Some resolvers send abi.encode(name, data) as OffchainLookup.callData.
  }

  try {
    const [dnsEncodedName, resolverData] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes" }],
      data,
    );

    return { dnsEncodedName, resolverData };
  } catch {
    throw new Error("unsupported CCIP resolver calldata");
  }
}

function encodeResolverString(value) {
  return encodeAbiParameters([{ type: "string" }], [value ?? ""]);
}

function encodeResolverAddress(value) {
  return encodeAbiParameters([{ type: "address" }], [value ?? "0x0000000000000000000000000000000000000000"]);
}

export function createResourceLocatorServiceFromEnv(environment = process.env, options = {}) {
  const arcEscrowService = options.arcEscrowService ?? createArcEscrowServiceFromEnv(environment);

  if (!arcEscrowService) {
    throw new Error("ARC_ESCROW_CONTRACT_ADDRESS is required");
  }

  return new ResourceLocatorService({
    ...options,
    parentName: environment.ENS_PARENT_NAME,
    ensNetwork: environment.ENS_NETWORK ?? DEFAULT_ENS_NETWORK,
    walrusGatewayBaseUrl: environment.WALRUS_GATEWAY_BASE_URL ?? options.walrusGatewayBaseUrl,
    escrowAddress:
      environment.RESOURCE_LOCATOR_ESCROW_ADDRESS ??
      environment.ARC_ESCROW_CONTRACT_ADDRESS ??
      environment.ESCROW_CONTRACT_ADDRESS ??
      null,
    avatarUrl: environment.RESOURCE_LOCATOR_AVATAR_URL ?? null,
    arcEscrowService,
  });
}

export class ResourceLocatorService {
  constructor({
    dataDir = path.resolve("data", "resources"),
    parentName,
    ensNetwork = DEFAULT_ENS_NETWORK,
    walrusGatewayBaseUrl = DEFAULT_WALRUS_GATEWAY_BASE_URL,
    escrowAddress = null,
    avatarUrl = null,
    arcEscrowService = null,
    authService = null,
    now = () => new Date().toISOString(),
  } = {}) {
    this.parentName = normalizeParentName(parentName);
    this.ensNetwork = ensNetwork;
    this.dataDir = dataDir;
    this.statePath = path.join(this.dataDir, "resources.json");
    this.walrusGatewayBaseUrl = walrusGatewayBaseUrl.replace(/\/$/, "");
    this.escrowAddress = normalizeOptionalString(escrowAddress, "escrowAddress");
    this.avatarUrl = normalizeOptionalString(avatarUrl, "avatarUrl");
    if (!arcEscrowService) {
      throw new Error("arcEscrowService is required");
    }
    this.arcEscrowService = arcEscrowService;
    this.authService = authService;
    this.now = now;
    this.resources = new Map();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });

    try {
      const raw = await readFile(this.statePath, "utf8");
      const state = JSON.parse(raw);
      this.resources = new Map((state.resources ?? []).map((resource) => [resource.torrentInfoHash, resource]));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.persist();
    }
  }

  listResources() {
    return [...this.resources.values()];
  }

  getResource(torrentInfoHash) {
    return this.resources.get(normalizeTorrentInfoHash(torrentInfoHash)) ?? null;
  }

  deriveLabel(torrentInfoHash) {
    return `btih-${normalizeTorrentInfoHash(torrentInfoHash)}`;
  }

  deriveName(torrentInfoHash) {
    return normalize(`${this.deriveLabel(torrentInfoHash)}.${this.parentName}`);
  }

  getTorrentInfoHashFromLocator(locator) {
    assertString(locator, "locator");

    const normalized = locator.trim().toLowerCase();
    if (/^[0-9a-f]{40}$/.test(normalized)) {
      return normalizeTorrentInfoHash(normalized);
    }

    const infoHash = parseInfoHashFromEnsName(normalized, this.parentName);
    if (!infoHash) {
      throw new Error(`locator must be a torrent infohash or btih-* subname under ${this.parentName}`);
    }

    return infoHash;
  }

  async resolveLocator(locator) {
    const torrentInfoHash = this.getTorrentInfoHashFromLocator(locator);
    const ensName = this.deriveName(torrentInfoHash);
    const walrusBlobId = await this.getEnsTextRecord({
      ensName,
      key: WALRUS_BLOB_TEXT_KEY,
    });
    const resource = this.getResource(torrentInfoHash);

    if (walrusBlobId) {
      const retrievalUrl = await this.getEnsTextRecord({
        ensName,
        key: RESOURCE_URL_TEXT_KEY,
      });

      return {
        mode: "walrus",
        torrentInfoHash,
        ensName,
        ensNetwork: this.ensNetwork,
        walrusBlobId,
        retrievalUrl: retrievalUrl || this.getWalrusRetrievalUrl(walrusBlobId),
        resource,
      };
    }

    if (resource) {
      return {
        torrentInfoHash,
        ...this.resolveResource(torrentInfoHash),
      };
    }

    return {
      mode: "torrent",
      torrentInfoHash,
      ensName,
      ensNetwork: this.ensNetwork,
      activeBountyId: null,
      resource: null,
    };
  }

  async ensureResourceForBounty({
    torrentInfoHash,
    bountyId,
    title = null,
    description = null,
    rewardAmountUnits = null,
    rewardToken = "USDC",
  }) {
    const normalizedInfoHash = normalizeTorrentInfoHash(torrentInfoHash);
    assertString(bountyId, "bountyId");

    const existing = this.resources.get(normalizedInfoHash);
    if (existing) {
      existing.bountyIds = appendUnique(existing.bountyIds ?? [], bountyId);
      if (existing.locatorStatus !== "ARCHIVED") {
        existing.activeBountyId = existing.activeBountyId ?? bountyId;
      }
      existing.title = existing.title ?? normalizeOptionalString(title, "title");
      existing.description = existing.description ?? normalizeOptionalString(description, "description");
      existing.rewardAmountUnits = existing.rewardAmountUnits ?? rewardAmountUnits ?? null;
      existing.rewardToken = existing.rewardToken ?? rewardToken;
      existing.updatedAt = this.now();
      await this.persist();
      return { resource: existing, created: false };
    }

    const timestamp = this.now();
    const resource = {
      id: normalizedInfoHash,
      torrentInfoHash: normalizedInfoHash,
      ensName: this.deriveName(normalizedInfoHash),
      ensNetwork: this.ensNetwork,
      locatorStatus: "PENDING_RECOVERY",
      bountyIds: [bountyId],
      activeBountyId: bountyId,
      sourceContractId: null,
      walrusBlobId: null,
      walrusObjectId: null,
      retrievalUrl: null,
      title: normalizeOptionalString(title, "title"),
      description: normalizeOptionalString(description, "description"),
      rewardAmountUnits: rewardAmountUnits ?? null,
      rewardToken,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.resources.set(resource.torrentInfoHash, resource);
    await this.persist();
    return { resource, created: true };
  }

  async markSeeding({ torrentInfoHash, contractId }) {
    const resource = this.requireResource(torrentInfoHash);
    assertString(contractId, "contractId");

    if (resource.locatorStatus !== "ARCHIVED") {
      resource.locatorStatus = "SEEDING";
      resource.sourceContractId = contractId;
      resource.updatedAt = this.now();
      await this.persist();
    }

    return resource;
  }

  async archiveResource({
    torrentInfoHash,
    contractId,
    walrusBlobId,
    walrusObjectId = null,
  }) {
    const resource = this.requireResource(torrentInfoHash);
    assertString(contractId, "contractId");

    const normalizedWalrusBlobId = normalizeWalrusBlobId(walrusBlobId);
    resource.locatorStatus = "ARCHIVED";
    resource.sourceContractId = contractId;
    resource.walrusBlobId = normalizedWalrusBlobId;
    resource.walrusObjectId = normalizeOptionalString(walrusObjectId, "walrusObjectId");
    resource.retrievalUrl = this.getWalrusRetrievalUrl(normalizedWalrusBlobId);
    resource.archivedAt = this.now();
    resource.updatedAt = resource.archivedAt;

    await this.persist();
    return resource;
  }

  resolveResource(torrentInfoHash) {
    const resource = this.requireResource(torrentInfoHash);

    if (resource.locatorStatus === "ARCHIVED") {
      return {
        mode: "walrus",
        ensName: resource.ensName,
        ensNetwork: resource.ensNetwork,
        walrusBlobId: resource.walrusBlobId,
        retrievalUrl: resource.retrievalUrl,
        resource,
      };
    }

    return {
      mode: "torrent",
      ensName: resource.ensName,
      ensNetwork: resource.ensNetwork,
      activeBountyId: resource.activeBountyId,
      resource,
    };
  }

  async getEnsTextRecord({ ensName, key }) {
    assertString(key, "key");
    const wallet = this.getWalletForEnsName(ensName);
    if (wallet) {
      switch (key) {
        case WALLET_ADDRESS_TEXT_KEY:
          return wallet.walletAddress;
        case DESCRIPTION_TEXT_KEY:
          return `Bit Lazarus wallet ${wallet.ensName}`;
        case AVATAR_TEXT_KEY:
          return this.avatarUrl ?? "";
        default:
          return "";
      }
    }

    const infoHash = parseInfoHashFromEnsName(ensName, this.parentName);

    if (!infoHash) {
      return "";
    }

    const arcBounty = await this.arcEscrowService.getBountyByInfoHash(infoHash);

    switch (key) {
      case INFOHASH_TEXT_KEY:
        return infoHash;
      case STATUS_TEXT_KEY:
        return arcBounty?.locatorStatus ?? "";
      case WALRUS_BLOB_TEXT_KEY:
      case LEGACY_WALRUS_BLOB_TEXT_KEY:
        return arcBounty?.walrusBlobId ?? "";
      case RESOURCE_URL_TEXT_KEY:
        if (arcBounty?.walrusBlobId) {
          return this.getWalrusRetrievalUrl(arcBounty.walrusBlobId);
        }
        return "";
      case DESCRIPTION_TEXT_KEY:
        return arcBounty?.spec ?? "";
      case REWARD_TEXT_KEY:
        return arcBounty ? `${arcBounty.rewardAmountUnits} ${arcBounty.rewardToken}` : "";
      case AVATAR_TEXT_KEY:
        return this.avatarUrl ?? "";
      default:
        return "";
    }
  }

  async answerCcipRead({ data }) {
    assertString(data, "data");
    const { dnsEncodedName, resolverData } = decodeCcipReadPayload(data);
    const ensName = decodeDnsEncodedName(dnsEncodedName);
    const decoded = decodeFunctionData({
      abi: resolverReadAbi,
      data: resolverData,
    });

    if (decoded.functionName === "text") {
      const [, key] = decoded.args;
      return {
        data: encodeResolverString(await this.getEnsTextRecord({ ensName, key })),
      };
    }

    if (decoded.functionName === "addr") {
      return {
        data: encodeResolverAddress(this.getEnsAddressRecord(ensName)),
      };
    }

    throw new Error(`unsupported resolver function: ${decoded.functionName}`);
  }

  getWalrusRetrievalUrl(walrusBlobId) {
    return `${this.walrusGatewayBaseUrl}/${encodeURIComponent(walrusBlobId)}`;
  }

  getWalletForEnsName(ensName) {
    const label = parseWalletLabelFromEnsName(ensName, this.parentName);

    if (!label || !this.authService) {
      return null;
    }

    return this.authService.getUserByEnsLabel(label);
  }

  getEnsAddressRecord(ensName) {
    return this.getWalletForEnsName(ensName)?.walletAddress ?? this.escrowAddress;
  }

  requireResource(torrentInfoHash) {
    const resource = this.getResource(torrentInfoHash);

    if (!resource) {
      throw new Error(`resource not found for torrent: ${torrentInfoHash}`);
    }

    return resource;
  }

  async persist() {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(
      this.statePath,
      JSON.stringify(
        {
          resources: this.listResources(),
        },
        null,
        2,
      ),
    );
  }
}
