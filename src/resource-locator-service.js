import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  labelhash,
  namehash,
  parseAbi,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalize } from "viem/ens";
import { sepolia } from "viem/chains";

const SEPOLIA_ENS_V2_PARENT_REGISTRY_ADDRESS = "0xdedb92913a25abe1f7bcdd85d8a344a43b398b67";
const WALRUS_BLOB_TEXT_KEY = "bitlazarus.walrus.blob";
const ENS_V2_STATUS_REGISTERED = 2;
const ENS_V2_DEFAULT_EXPIRY_SECONDS = 365 * 24 * 60 * 60;

const ENS_V2_ROLE_SET_SUBREGISTRY = 1n << 20n;
const ENS_V2_ROLE_SET_RESOLVER = 1n << 24n;
const ENS_V2_ROLE_SET_SUBREGISTRY_ADMIN = ENS_V2_ROLE_SET_SUBREGISTRY << 128n;
const ENS_V2_ROLE_SET_RESOLVER_ADMIN = ENS_V2_ROLE_SET_RESOLVER << 128n;
const ENS_V2_ROLE_CAN_TRANSFER_ADMIN = 1n << 132n;
const ENS_V2_REGISTRATION_ROLE_BITMAP =
  ENS_V2_ROLE_SET_SUBREGISTRY |
  ENS_V2_ROLE_SET_SUBREGISTRY_ADMIN |
  ENS_V2_ROLE_SET_RESOLVER |
  ENS_V2_ROLE_SET_RESOLVER_ADMIN |
  ENS_V2_ROLE_CAN_TRANSFER_ADMIN;

const publicResolverAbi = parseAbi([
  "function setText(bytes32 node, string key, string value)",
]);

const ensV2RegistryAbi = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function getState(uint256 anyId) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
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

function appendUnique(values, nextValue) {
  return values.includes(nextValue) ? values : [...values, nextValue];
}

function normalizePrivateKey(value) {
  assertString(value, "ENS_PRIVATE_KEY");
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function normalizeAddress(value, fieldName) {
  assertString(value, fieldName);
  const trimmed = value.trim();

  if (!isAddress(trimmed)) {
    throw new Error(`${fieldName} must be an EVM address`);
  }

  return getAddress(trimmed);
}

function normalizeOptionalAddress(value, fieldName) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return normalizeAddress(value, fieldName);
}

function normalizeParentName(parentName) {
  assertString(parentName, "parentName");
  return normalize(parentName.trim());
}

function getParentLabel(parentName) {
  const labels = normalizeParentName(parentName).split(".");

  if (labels.length !== 2 || labels[1] !== "eth") {
    throw new Error("ENSv2 adapter currently supports second-level .eth parent names only");
  }

  return labels[0];
}

function normalizeBigInt(value, fieldName) {
  if (typeof value === "bigint") {
    return value;
  }

  assertString(value, fieldName);
  return BigInt(value.trim());
}

export class ViemEnsV2LocatorAdapter {
  constructor({
    parentName = "lazarus.eth",
    network = "sepolia",
    rpcUrl,
    privateKey,
    parentRegistryAddress = SEPOLIA_ENS_V2_PARENT_REGISTRY_ADDRESS,
    subregistryAddress = null,
    resolverAddress = null,
    subnameOwner = null,
    roleBitmap = ENS_V2_REGISTRATION_ROLE_BITMAP,
    expirySeconds = ENS_V2_DEFAULT_EXPIRY_SECONDS,
    chain = sepolia,
    publicClient = null,
    walletClient = null,
    account = null,
    now = () => Math.floor(Date.now() / 1000),
  } = {}) {
    if (network !== "sepolia") {
      throw new Error("ViemEnsV2LocatorAdapter currently supports ENSv2 writes on Sepolia only");
    }

    this.parentName = normalizeParentName(parentName);
    this.parentLabel = getParentLabel(this.parentName);
    this.network = network;
    this.parentRegistryAddress = normalizeAddress(parentRegistryAddress, "parentRegistryAddress");
    this.subregistryAddress = normalizeOptionalAddress(subregistryAddress, "subregistryAddress");
    this.resolverAddress = normalizeOptionalAddress(resolverAddress, "resolverAddress");
    this.subnameOwner = subnameOwner ? normalizeAddress(subnameOwner, "subnameOwner") : null;
    this.roleBitmap = typeof roleBitmap === "bigint"
      ? roleBitmap
      : normalizeBigInt(String(roleBitmap), "roleBitmap");
    this.expirySeconds = Number(expirySeconds);
    this.chain = chain;
    this.account = account ?? privateKeyToAccount(normalizePrivateKey(privateKey));
    this.subnameOwner = this.subnameOwner ?? this.account.address;
    this.now = now;
    const transport = rpcUrl ? http(rpcUrl) : null;
    this.publicClient = publicClient ?? createPublicClient({ chain, transport });
    this.walletClient = walletClient ?? createWalletClient({ account: this.account, chain, transport });
  }

  deriveLabel(torrentInfoHash) {
    return `b-${torrentInfoHash.slice(0, 16)}`;
  }

  deriveName(torrentInfoHash) {
    return normalize(`${this.deriveLabel(torrentInfoHash)}.${this.parentName}`);
  }

  async ensureSubname({ torrentInfoHash }) {
    const label = this.deriveLabel(torrentInfoHash);
    const ensName = this.deriveName(torrentInfoHash);
    const registry = await this.getSubregistryAddress();
    const resolver = await this.getResolverAddress();
    const state = await this.readState(registry, label);

    if (Number(state.status) === ENS_V2_STATUS_REGISTERED) {
      return {
        ensName,
        ensNetwork: this.network,
        created: false,
        owner: state.latestOwner,
        resolver,
        registry,
      };
    }

    const expiry = BigInt(this.now() + this.expirySeconds);
    const hash = await this.walletClient.writeContract({
      address: registry,
      abi: ensV2RegistryAbi,
      functionName: "register",
      args: [label, this.subnameOwner, zeroAddress, resolver, this.roleBitmap, expiry],
      account: this.account,
      chain: this.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    return {
      ensName,
      ensNetwork: this.network,
      created: true,
      owner: this.subnameOwner,
      resolver,
      registry,
      transactionHash: hash,
      blockNumber: receipt.blockNumber?.toString?.() ?? null,
    };
  }

  async setWalrusBlob({ ensName, walrusBlobId }) {
    const normalizedEnsName = normalize(ensName);
    const resolver = await this.getResolverAddress();
    const hash = await this.walletClient.writeContract({
      address: resolver,
      abi: publicResolverAbi,
      functionName: "setText",
      args: [namehash(normalizedEnsName), WALRUS_BLOB_TEXT_KEY, walrusBlobId],
      account: this.account,
      chain: this.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    return {
      ensName: normalizedEnsName,
      ensNetwork: this.network,
      textRecords: {
        [WALRUS_BLOB_TEXT_KEY]: walrusBlobId,
      },
      transactionHash: hash,
      blockNumber: receipt.blockNumber?.toString?.() ?? null,
    };
  }

  async getSubregistryAddress() {
    if (!this.subregistryAddress) {
      const subregistryAddress = await this.publicClient.readContract({
        address: this.parentRegistryAddress,
        abi: ensV2RegistryAbi,
        functionName: "getSubregistry",
        args: [this.parentLabel],
      });

      if (isAddressEqual(subregistryAddress, zeroAddress)) {
        throw new Error(`ENSv2 parent has no subregistry: ${this.parentName}`);
      }

      this.subregistryAddress = getAddress(subregistryAddress);
    }

    return this.subregistryAddress;
  }

  async getResolverAddress() {
    if (!this.resolverAddress) {
      const resolverAddress = await this.publicClient.readContract({
        address: this.parentRegistryAddress,
        abi: ensV2RegistryAbi,
        functionName: "getResolver",
        args: [this.parentLabel],
      });

      if (isAddressEqual(resolverAddress, zeroAddress)) {
        throw new Error(`ENSv2 parent has no resolver: ${this.parentName}`);
      }

      this.resolverAddress = getAddress(resolverAddress);
    }

    return this.resolverAddress;
  }

  async readState(registry, label) {
    return this.publicClient.readContract({
      address: registry,
      abi: ensV2RegistryAbi,
      functionName: "getState",
      args: [BigInt(labelhash(label))],
    });
  }
}

export function createEnsLocatorAdapterFromEnv(environment = process.env) {
  const parentName = environment.ENS_PARENT_NAME;
  const network = environment.ENS_NETWORK ?? "sepolia";
  const rpcUrl = environment.ENS_RPC_URL ?? environment.ETH_RPC_URL;
  const privateKey = environment.ENS_PRIVATE_KEY ?? environment.PRIVATE_KEY;

  if (!parentName) {
    throw new Error("ENS_PARENT_NAME is required");
  }

  if (!rpcUrl) {
    throw new Error("ENS_RPC_URL or ETH_RPC_URL is required");
  }

  if (!privateKey) {
    throw new Error("ENS_PRIVATE_KEY or PRIVATE_KEY is required");
  }

  return new ViemEnsV2LocatorAdapter({
    parentName,
    network,
    rpcUrl,
    privateKey,
    parentRegistryAddress: environment.ENS_V2_PARENT_REGISTRY_ADDRESS ?? SEPOLIA_ENS_V2_PARENT_REGISTRY_ADDRESS,
    subregistryAddress: environment.ENS_V2_SUBREGISTRY_ADDRESS ?? null,
    resolverAddress: environment.ENS_V2_RESOLVER_ADDRESS ?? null,
    subnameOwner: environment.ENS_SUBNAME_OWNER ?? null,
    roleBitmap: environment.ENS_V2_REGISTRATION_ROLE_BITMAP ?? ENS_V2_REGISTRATION_ROLE_BITMAP,
    expirySeconds: environment.ENS_V2_EXPIRY_SECONDS ?? ENS_V2_DEFAULT_EXPIRY_SECONDS,
  });
}

export class ResourceLocatorService {
  constructor({
    dataDir = path.resolve("data", "resources"),
    ensAdapter,
    walrusGatewayBaseUrl = "https://aggregator.walrus-testnet.walrus.space/v1/blobs",
    now = () => new Date().toISOString(),
  } = {}) {
    if (!ensAdapter) {
      throw new Error("ensAdapter is required");
    }

    this.dataDir = dataDir;
    this.statePath = path.join(this.dataDir, "resources.json");
    this.ensAdapter = ensAdapter;
    this.walrusGatewayBaseUrl = walrusGatewayBaseUrl.replace(/\/$/, "");
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

  async ensureResourceForBounty({ torrentInfoHash, bountyId }) {
    const normalizedInfoHash = normalizeTorrentInfoHash(torrentInfoHash);
    assertString(bountyId, "bountyId");

    const existing = this.resources.get(normalizedInfoHash);
    if (existing) {
      existing.bountyIds = appendUnique(existing.bountyIds ?? [], bountyId);
      if (existing.locatorStatus !== "ARCHIVED") {
        existing.activeBountyId = existing.activeBountyId ?? bountyId;
      }
      existing.updatedAt = this.now();
      await this.persist();
      return { resource: existing, created: false };
    }

    const ens = await this.ensAdapter.ensureSubname({ torrentInfoHash: normalizedInfoHash });
    const timestamp = this.now();
    const resource = {
      id: normalizedInfoHash,
      torrentInfoHash: normalizedInfoHash,
      ensName: ens.ensName,
      ensNetwork: ens.ensNetwork,
      locatorStatus: "PENDING_RECOVERY",
      bountyIds: [bountyId],
      activeBountyId: bountyId,
      sourceContractId: null,
      walrusBlobId: null,
      walrusObjectId: null,
      retrievalUrl: null,
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

    await this.ensAdapter.setWalrusBlob({
      ensName: resource.ensName,
      walrusBlobId: normalizedWalrusBlobId,
    });
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

  getWalrusRetrievalUrl(walrusBlobId) {
    return `${this.walrusGatewayBaseUrl}/${encodeURIComponent(walrusBlobId)}`;
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
