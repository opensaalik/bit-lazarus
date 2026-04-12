import { mkdir, readFile, writeFile } from "node:fs/promises";
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

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
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

const BOUNTY_STATUSES_BY_ESCROW_STATUS = {
  AWAITING_FUNDING: "AWAITING_FUNDING",
  FUNDED: "OPEN",
  RELEASED: "COMPLETED",
  CANCELED: "CANCELED",
};

export class BountyService {
  constructor({
    dataDir = path.resolve("data", "bounties"),
    now = () => new Date().toISOString(),
    bondPercentage = 30,
  } = {}) {
    this.dataDir = dataDir;
    this.statePath = path.join(this.dataDir, "bounties.json");
    this.torrentsDir = path.join(this.dataDir, "torrents");
    this.now = now;
    this.bondPercentage = bondPercentage;
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

  computeBondAmount(rewardSats) {
    return Math.max(1, Math.ceil(rewardSats * this.bondPercentage / 100));
  }

  async createBounty({
    bountyId = crypto.randomUUID(),
    creatorUserId,
    title,
    description,
    torrentInfoHash,
    torrentName = null,
    rewardSats,
    tags = [],
    escrowId,
    escrowStatus = "AWAITING_FUNDING",
    funding = null,
    torrentFileBase64 = null,
    pieceCount = null,
    pieceLength = null,
    totalSize = null,
    files = null,
  }) {
    assertString(creatorUserId, "creatorUserId");
    assertString(title, "title");
    assertString(description, "description");
    assertPositiveInteger(rewardSats, "rewardSats");
    assertString(escrowId, "escrowId");

    if (this.bounties.has(bountyId)) {
      throw new Error(`bounty already exists: ${bountyId}`);
    }

    const normalizedInfoHash = normalizeTorrentInfoHash(torrentInfoHash);

    if (torrentFileBase64) {
      await this.storeTorrentFile(normalizedInfoHash, torrentFileBase64);
    }

    const bondAmountSats = this.computeBondAmount(rewardSats);
    const timestamp = this.now();
    const bounty = {
      id: bountyId,
      creatorUserId,
      title: title.trim(),
      description: description.trim(),
      torrentInfoHash: normalizedInfoHash,
      torrentName: normalizeOptionalString(torrentName, "torrentName"),
      rewardSats,
      bondAmountSats,
      tags: normalizeTags(tags),
      status: BOUNTY_STATUSES_BY_ESCROW_STATUS[escrowStatus] ?? "AWAITING_FUNDING",
      deliveryStatus: "IDLE",
      completionReadiness: "PENDING",
      createdAt: timestamp,
      updatedAt: timestamp,
      escrowId,
      escrowStatus,
      funding,
      hasTorrentFile: !!torrentFileBase64,
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
    assertString(escrowId, "escrowId");
    assertString(escrowStatus, "escrowStatus");

    const bounty = this.requireBounty(bountyId);

    if (bounty.escrowId !== escrowId) {
      throw new Error("escrowId does not match bounty");
    }

    bounty.escrowStatus = escrowStatus;
    bounty.status = BOUNTY_STATUSES_BY_ESCROW_STATUS[escrowStatus] ?? bounty.status;
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
      bounty.deliveryStatus = "BOND_PENDING";
      bounty.updatedAt = this.now();
      await this.persist();
    }

    return bounty;
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
