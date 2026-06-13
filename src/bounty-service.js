import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
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

function assertPositiveSafeInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function normalizeTags(tags) {
  if (tags === undefined) {
    return [];
  }

  if (!Array.isArray(tags)) {
    throw new Error("tags must be an array");
  }

  return [...new Set(
    tags.map((tag) => {
      if (typeof tag !== "string") {
        throw new Error("tags must contain strings");
      }

      const normalizedTag = tag.trim().toLowerCase();

      if (!normalizedTag) {
        throw new Error("tags cannot be empty");
      }

      return normalizedTag;
    }),
  )];
}

function normalizeTorrentInfoHash(infoHash) {
  assertString(infoHash, "torrentInfoHash");
  const normalized = infoHash.trim().toLowerCase();

  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("torrentInfoHash must be a 40-character hex string");
  }

  return normalized;
}

function normalizeAddressForComparison(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

const BOUNTY_STATUSES_BY_SETTLEMENT_STATUS = {
  PENDING: "AWAITING_FUNDING",
  AWAITING_FUNDING: "AWAITING_FUNDING",
  FUNDED: "OPEN",
  RELEASED: "COMPLETED",
  CANCELED: "CANCELED",
};

export class BountyService {
  constructor({
    dataDir = path.resolve("data", "bounties"),
    now = () => new Date().toISOString(),
  } = {}) {
    this.dataDir = dataDir;
    this.statePath = path.join(this.dataDir, "bounties.json");
    this.torrentsDir = path.join(this.dataDir, "torrents");
    this.now = now;
    this.bounties = new Map();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.torrentsDir, { recursive: true });

    try {
      const raw = await readFile(this.statePath, "utf8");
      const state = JSON.parse(raw);
      this.bounties = new Map((state.bounties ?? []).map((bounty) => [bounty.id, bounty]));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.persist();
    }
  }

  listBounties({ creatorUserId, hunterUserId, status } = {}) {
    return [...this.bounties.values()].filter((bounty) => {
      if (creatorUserId && bounty.creatorUserId !== creatorUserId) {
        return false;
      }

      if (hunterUserId && !bounty.hunters.some((hunter) => hunter.userId === hunterUserId)) {
        return false;
      }

      if (status && bounty.status !== status) {
        return false;
      }

      return true;
    });
  }

  getBounty(bountyId) {
    return this.bounties.get(bountyId) ?? null;
  }

  async storeTorrentFile(infoHash, base64Data) {
    const filePath = path.join(this.torrentsDir, `${infoHash}.torrent`);
    await writeFile(filePath, Buffer.from(base64Data, "base64"));
    return filePath;
  }

  async getTorrentFile(infoHash) {
    const filePath = path.join(this.torrentsDir, `${infoHash}.torrent`);
    try {
      return await readFile(filePath);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async createBounty({
    bountyId = crypto.randomUUID(),
    creatorUserId,
    title,
    description,
    torrentInfoHash,
    torrentName = null,
    rewardAmountUnits,
    rewardToken = "USDC",
    tags = [],
    escrowId = null,
    escrowStatus = "PENDING",
    funding = null,
    torrentFileBase64 = null,
    pieceCount = null,
    pieceLength = null,
    totalSize = null,
    files = null,
    resourceLocator = null,
  }) {
    assertString(creatorUserId, "creatorUserId");
    assertString(title, "title");
    assertString(description, "description");
    assertPositiveSafeInteger(rewardAmountUnits, "rewardAmountUnits");
    assertString(rewardToken, "rewardToken");

    if (this.bounties.has(bountyId)) {
      throw new Error(`bounty already exists: ${bountyId}`);
    }

    const normalizedInfoHash = normalizeTorrentInfoHash(torrentInfoHash);

    if (torrentFileBase64) {
      await this.storeTorrentFile(normalizedInfoHash, torrentFileBase64);
    }

    const normalizedEscrowStatus = escrowStatus.trim().toUpperCase();
    const timestamp = this.now();
    const bounty = {
      id: bountyId,
      creatorUserId,
      title: title.trim(),
      description: description.trim(),
      torrentInfoHash: normalizedInfoHash,
      torrentName: normalizeOptionalString(torrentName, "torrentName"),
      rewardAmountUnits,
      rewardToken: rewardToken.trim().toUpperCase(),
      tags: normalizeTags(tags),
      status: BOUNTY_STATUSES_BY_SETTLEMENT_STATUS[normalizedEscrowStatus] ?? "AWAITING_FUNDING",
      deliveryStatus: "IDLE",
      completionReadiness: "PENDING",
      createdAt: timestamp,
      updatedAt: timestamp,
      escrowId: normalizeOptionalString(escrowId, "escrowId"),
      escrowStatus: normalizedEscrowStatus,
      funding,
      hasTorrentFile: !!torrentFileBase64,
      resourceLocator,
      torrentMeta: {
        pieceCount: pieceCount ?? null,
        pieceLength: pieceLength ?? null,
        totalSize: totalSize ?? null,
        files: files ?? null,
      },
      activeContractIds: [],
      hunters: [],
    };

    this.bounties.set(bounty.id, bounty);
    await this.persist();
    return bounty;
  }

  async joinBounty({ bountyId, userId }) {
    assertString(bountyId, "bountyId");
    assertString(userId, "userId");

    const bounty = this.requireBounty(bountyId);

    if (bounty.creatorUserId === userId) {
      throw new Error("bounty creators cannot join their own bounty as hunters");
    }

    if (bounty.status !== "OPEN") {
      throw new Error("only funded OPEN bounties can accept hunters");
    }

    const existingHunter = bounty.hunters.find((hunter) => hunter.userId === userId);

    if (existingHunter) {
      return bounty;
    }

    bounty.hunters.push({
      userId,
      joinedAt: this.now(),
      status: "JOINED",
    });
    bounty.updatedAt = this.now();
    await this.persist();
    return bounty;
  }

  async syncBountyEscrow({ bountyId, escrowId, escrowStatus, funding }) {
    assertString(bountyId, "bountyId");
    assertString(escrowStatus, "escrowStatus");

    const bounty = this.requireBounty(bountyId);
    const normalizedEscrowId = normalizeOptionalString(escrowId, "escrowId");

    if (bounty.escrowId && normalizedEscrowId && bounty.escrowId !== normalizedEscrowId) {
      throw new Error("escrowId does not match bounty");
    }

    bounty.escrowId = normalizedEscrowId ?? bounty.escrowId;
    bounty.escrowStatus = escrowStatus.trim().toUpperCase();
    bounty.status = BOUNTY_STATUSES_BY_SETTLEMENT_STATUS[bounty.escrowStatus] ?? bounty.status;
    bounty.funding = funding ?? bounty.funding;
    bounty.updatedAt = this.now();
    await this.persist();
    return bounty;
  }

  async registerDeliveryContract({ bountyId, contractId }) {
    assertString(bountyId, "bountyId");
    assertString(contractId, "contractId");

    const bounty = this.requireBounty(bountyId);

    if (!bounty.activeContractIds.includes(contractId)) {
      bounty.activeContractIds.push(contractId);
      bounty.deliveryStatus = "DELIVERY_IN_PROGRESS";
      bounty.updatedAt = this.now();
      await this.persist();
    }

    return bounty;
  }

  async unregisterDeliveryContract({
    bountyId,
    contractId,
    deliveryStatus = "IDLE",
    completionReadiness = "PENDING",
  }) {
    assertString(bountyId, "bountyId");
    assertString(contractId, "contractId");

    const bounty = this.requireBounty(bountyId);
    const originalLength = bounty.activeContractIds.length;
    bounty.activeContractIds = bounty.activeContractIds.filter((id) => id !== contractId);

    if (bounty.activeContractIds.length !== originalLength) {
      bounty.deliveryStatus = deliveryStatus;
      bounty.completionReadiness = completionReadiness;
      bounty.updatedAt = this.now();
      await this.persist();
    }

    return bounty;
  }

  async deleteBountiesForOtherEscrowContract({ escrowContractAddress }) {
    assertString(escrowContractAddress, "escrowContractAddress");
    const currentEscrowAddress = normalizeAddressForComparison(escrowContractAddress);
    const deletedBounties = [];

    for (const bounty of this.bounties.values()) {
      const bountyEscrowAddress = normalizeAddressForComparison(bounty.funding?.escrowContractAddress);

      if (bountyEscrowAddress && bountyEscrowAddress !== currentEscrowAddress) {
        this.bounties.delete(bounty.id);
        deletedBounties.push(bounty);
      }
    }

    for (const bounty of deletedBounties) {
      await rm(path.join(this.torrentsDir, `${bounty.torrentInfoHash}.torrent`), { force: true });
    }

    if (deletedBounties.length > 0) {
      await this.persist();
    }

    return deletedBounties;
  }

  async updateProtocolState({ bountyId, deliveryStatus, completionReadiness }) {
    assertString(bountyId, "bountyId");

    const bounty = this.requireBounty(bountyId);

    if (deliveryStatus) {
      bounty.deliveryStatus = deliveryStatus;
    }

    if (completionReadiness) {
      bounty.completionReadiness = completionReadiness;
    }

    bounty.updatedAt = this.now();
    await this.persist();
    return bounty;
  }

  requireBounty(bountyId) {
    const bounty = this.getBounty(bountyId);

    if (!bounty) {
      throw new Error(`bounty not found: ${bountyId}`);
    }

    return bounty;
  }

  async persist() {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.torrentsDir, { recursive: true });
    await writeFile(
      this.statePath,
      JSON.stringify(
        {
          bounties: [...this.bounties.values()],
        },
        null,
        2,
      ),
    );
  }
}
