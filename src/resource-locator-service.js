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

const SEPOLIA_ENS_REGISTRY_ADDRESS = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const SEPOLIA_NAME_WRAPPER_ADDRESS = "0x0635513f179D50A207757E05759CbD106d7dFcE8";
const SEPOLIA_PUBLIC_RESOLVER_ADDRESS = "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5";
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

const ensRegistryAbi = parseAbi([
  "function owner(bytes32 node) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl)",
]);

const nameWrapperAbi = parseAbi([
  "function ownerOf(uint256 id) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setSubnodeRecord(bytes32 parentNode, string label, address owner, address resolver, uint64 ttl, uint32 fuses, uint64 expiry) returns (bytes32)",
]);

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

function getNodeTokenId(node) {
  return BigInt(node);
}

export class MockEnsLocatorAdapter {
  constructor({ parentName = "lazarus.eth", network = "sepolia" } = {}) {
    this.parentName = parentName;
    this.network = network;
    this.records = new Map();
  }

  deriveName(torrentInfoHash) {
    return `b-${torrentInfoHash.slice(0, 16)}.${this.parentName}`;
  }

  async ensureSubname({ torrentInfoHash }) {
    const ensName = this.deriveName(torrentInfoHash);

    if (!this.records.has(ensName)) {
      this.records.set(ensName, {
        network: this.network,
        textRecords: {},
      });
    }

    return {
      ensName,
      ensNetwork: this.network,
    };
  }

  async setWalrusBlob({ ensName, walrusBlobId }) {
    const record = this.records.get(ensName) ?? {
      network: this.network,
      textRecords: {},
    };
    record.textRecords[WALRUS_BLOB_TEXT_KEY] = walrusBlobId;
    this.records.set(ensName, record);
    return record;
  }
}

export class ViemEnsLocatorAdapter {
  constructor({
    parentName = "lazarus.eth",
    network = "sepolia",
    rpcUrl,
    privateKey,
    registryAddress = SEPOLIA_ENS_REGISTRY_ADDRESS,
    nameWrapperAddress = SEPOLIA_NAME_WRAPPER_ADDRESS,
    publicResolverAddress = SEPOLIA_PUBLIC_RESOLVER_ADDRESS,
    subnameOwner = null,
    ttl = 0,
    fuses = 0,
    expiry = 0,
    chain = sepolia,
    publicClient = null,
    walletClient = null,
    account = null,
  } = {}) {
    if (network !== "sepolia") {
      throw new Error("ViemEnsLocatorAdapter currently supports ENS writes on Sepolia only");
    }

    this.parentName = normalizeParentName(parentName);
    this.network = network;
    this.registryAddress = normalizeAddress(registryAddress, "registryAddress");
    this.nameWrapperAddress = normalizeAddress(nameWrapperAddress, "nameWrapperAddress");
    this.publicResolverAddress = normalizeAddress(publicResolverAddress, "publicResolverAddress");
    this.ttl = BigInt(ttl);
    this.fuses = Number(fuses);
    this.expiry = BigInt(expiry);
    this.chain = chain;
    this.account = account ?? privateKeyToAccount(normalizePrivateKey(privateKey));
    this.subnameOwner = subnameOwner ? normalizeAddress(subnameOwner, "subnameOwner") : this.account.address;
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
    const ensName = this.deriveName(torrentInfoHash);
    const label = this.deriveLabel(torrentInfoHash);
    const parentNode = namehash(this.parentName);
    const childNode = namehash(ensName);
    const childOwner = await this.readRegistryOwner(childNode);

    if (!isAddressEqual(childOwner, zeroAddress)) {
      return {
        ensName,
        ensNetwork: this.network,
        created: false,
        owner: childOwner,
        resolver: this.publicResolverAddress,
      };
    }

    const parentOwner = await this.readRegistryOwner(parentNode);
    if (isAddressEqual(parentOwner, zeroAddress)) {
      throw new Error(`ENS parent has no registry owner: ${this.parentName}`);
    }

    const isWrappedParent = isAddressEqual(parentOwner, this.nameWrapperAddress);
    const hash = isWrappedParent
      ? await this.createWrappedSubname({ parentNode, label })
      : await this.createRegistrySubname({ parentNode, label, parentOwner });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    return {
      ensName,
      ensNetwork: this.network,
      created: true,
      owner: this.subnameOwner,
      resolver: this.publicResolverAddress,
      transactionHash: hash,
      blockNumber: receipt.blockNumber?.toString?.() ?? null,
    };
  }

  async setWalrusBlob({ ensName, walrusBlobId }) {
    const normalizedEnsName = normalize(ensName);
    const hash = await this.walletClient.writeContract({
      address: this.publicResolverAddress,
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

  async createRegistrySubname({ parentNode, label, parentOwner }) {
    await this.assertRegistryAuthorized(parentOwner);

    return this.walletClient.writeContract({
      address: this.registryAddress,
      abi: ensRegistryAbi,
      functionName: "setSubnodeRecord",
      args: [
        parentNode,
        labelhash(label),
        this.subnameOwner,
        this.publicResolverAddress,
        this.ttl,
      ],
      account: this.account,
      chain: this.chain,
    });
  }

  async createWrappedSubname({ parentNode, label }) {
    const wrappedOwner = await this.publicClient.readContract({
      address: this.nameWrapperAddress,
      abi: nameWrapperAbi,
      functionName: "ownerOf",
      args: [getNodeTokenId(parentNode)],
    });
    await this.assertWrapperAuthorized(wrappedOwner);

    return this.walletClient.writeContract({
      address: this.nameWrapperAddress,
      abi: nameWrapperAbi,
      functionName: "setSubnodeRecord",
      args: [
        parentNode,
        label,
        this.subnameOwner,
        this.publicResolverAddress,
        this.ttl,
        this.fuses,
        this.expiry,
      ],
      account: this.account,
      chain: this.chain,
    });
  }

  async assertRegistryAuthorized(parentOwner) {
    if (isAddressEqual(parentOwner, this.account.address)) {
      return;
    }

    const approved = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: ensRegistryAbi,
      functionName: "isApprovedForAll",
      args: [parentOwner, this.account.address],
    });

    if (!approved) {
      throw new Error(`ENS signer ${this.account.address} is not authorized for parent ${this.parentName}`);
    }
  }

  async assertWrapperAuthorized(wrappedOwner) {
    if (isAddressEqual(wrappedOwner, this.account.address)) {
      return;
    }

    const approved = await this.publicClient.readContract({
      address: this.nameWrapperAddress,
      abi: nameWrapperAbi,
      functionName: "isApprovedForAll",
      args: [wrappedOwner, this.account.address],
    });

    if (!approved) {
      throw new Error(`ENS signer ${this.account.address} is not authorized for wrapped parent ${this.parentName}`);
    }
  }

  async readRegistryOwner(node) {
    return getAddress(await this.publicClient.readContract({
      address: this.registryAddress,
      abi: ensRegistryAbi,
      functionName: "owner",
      args: [node],
    }));
  }
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
  const adapterMode = environment.ENS_ADAPTER ?? "auto";
  const parentName = environment.ENS_PARENT_NAME ?? "lazarus.eth";
  const network = environment.ENS_NETWORK ?? "sepolia";

  if (adapterMode === "mock") {
    return new MockEnsLocatorAdapter({ parentName, network });
  }

  const rpcUrl = environment.ENS_RPC_URL ?? environment.ETH_RPC_URL;
  const privateKey = environment.ENS_PRIVATE_KEY ?? environment.PRIVATE_KEY;

  if (adapterMode === "viem" || adapterMode === "ensv2" || adapterMode === "production") {
    if (!rpcUrl) {
      throw new Error(`ENS_RPC_URL or ETH_RPC_URL is required when ENS_ADAPTER=${adapterMode}`);
    }

    if (!privateKey) {
      throw new Error(`ENS_PRIVATE_KEY or PRIVATE_KEY is required when ENS_ADAPTER=${adapterMode}`);
    }
  }

  if (adapterMode === "ensv2") {
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

  if (rpcUrl && privateKey) {
    return new ViemEnsLocatorAdapter({
      parentName,
      network,
      rpcUrl,
      privateKey,
      registryAddress: environment.ENS_REGISTRY_ADDRESS ?? SEPOLIA_ENS_REGISTRY_ADDRESS,
      nameWrapperAddress: environment.ENS_NAME_WRAPPER_ADDRESS ?? SEPOLIA_NAME_WRAPPER_ADDRESS,
      publicResolverAddress: environment.ENS_PUBLIC_RESOLVER_ADDRESS ?? SEPOLIA_PUBLIC_RESOLVER_ADDRESS,
      subnameOwner: environment.ENS_SUBNAME_OWNER ?? null,
      ttl: environment.ENS_RECORD_TTL ?? 0,
      fuses: environment.ENS_NAMEWRAPPER_FUSES ?? 0,
      expiry: environment.ENS_NAMEWRAPPER_EXPIRY ?? 0,
    });
  }

  return new MockEnsLocatorAdapter({ parentName, network });
}

export class ResourceLocatorService {
  constructor({
    dataDir = path.resolve("data", "resources"),
    ensAdapter = new MockEnsLocatorAdapter(),
    walrusGatewayBaseUrl = "https://aggregator.walrus-testnet.walrus.space/v1/blobs",
    now = () => new Date().toISOString(),
  } = {}) {
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
