import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("optional string fields must be strings");
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function assertPositiveSafeInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function assertSha256Hex(value, fieldName) {
  assertString(value, fieldName);
  const normalized = value.trim().toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${fieldName} must be a 64-character hex string`);
  }

  return normalized;
}

function isExpired(isoTimestamp, now) {
  return new Date(isoTimestamp).getTime() <= new Date(now).getTime();
}

export class ProtocolService {
  constructor({
    dataDir = path.resolve("data", "protocol"),
    now = () => new Date().toISOString(),
    deliveryDeadlineMs = 6 * 60 * 60 * 1000,
  } = {}) {
    this.dataDir = dataDir;
    this.statePath = path.join(this.dataDir, "protocol.json");
    this.now = now;
    this.deliveryDeadlineMs = deliveryDeadlineMs;
    this.deliveryContracts = new Map();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });

    try {
      const raw = await readFile(this.statePath, "utf8");
      const state = JSON.parse(raw);
      this.deliveryContracts = new Map(
        (state.deliveryContracts ?? []).map((contract) => [contract.id, contract]),
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.persist();
    }
  }

  listDeliveryContracts({ bountyId } = {}) {
    return [...this.deliveryContracts.values()].filter((contract) => {
      if (bountyId && contract.bountyId !== bountyId) {
        return false;
      }

      return true;
    });
  }

  getDeliveryContract(contractId) {
    return this.deliveryContracts.get(contractId) ?? null;
  }

  async deleteDeliveryContract(contractId) {
    assertString(contractId, "contractId");

    const contract = this.requireDeliveryContract(contractId);
    this.deliveryContracts.delete(contract.id);
    await this.persist();
    return contract;
  }

  async deleteStaleDeliveryContracts({ bountyId, requesterUserId }) {
    assertString(bountyId, "bountyId");
    assertString(requesterUserId, "requesterUserId");

    const staleContracts = this.listDeliveryContracts({ bountyId })
      .filter((contract) => (
        contract.payerUserId === requesterUserId &&
        contract.state !== "RESOLVED_SUCCESS"
      ));

    for (const contract of staleContracts) {
      this.deliveryContracts.delete(contract.id);
    }

    if (staleContracts.length > 0) {
      await this.persist();
    }

    return staleContracts;
  }

  async createDeliveryContract({
    contractId = crypto.randomUUID(),
    bountyId,
    payerUserId,
    hunterUserId,
    payerWalletAddress,
    hunterWalletAddress,
    rewardEscrowId = null,
    rewardAmountUnits = null,
    rewardToken = "USDC",
  }) {
    assertString(bountyId, "bountyId");
    assertString(payerUserId, "payerUserId");
    assertString(hunterUserId, "hunterUserId");
    assertString(payerWalletAddress, "payerWalletAddress");
    assertString(hunterWalletAddress, "hunterWalletAddress");

    if (rewardAmountUnits !== null) {
      assertPositiveSafeInteger(rewardAmountUnits, "rewardAmountUnits");
    }

    if (this.deliveryContracts.has(contractId)) {
      throw new Error(`delivery contract already exists: ${contractId}`);
    }

    const now = this.now();
    const contract = {
      id: contractId,
      bountyId,
      payerUserId,
      hunterUserId,
      payerWalletAddress,
      hunterWalletAddress,
      rewardEscrowId: normalizeOptionalString(rewardEscrowId),
      rewardAmountUnits,
      rewardToken: rewardToken.trim().toUpperCase(),
      hunterDeliveryFileSha256: null,
      hunterDeliveryFileName: null,
      hunterDeliveryFileSize: null,
      hunterDeliveryCommittedAt: null,
      requesterDeliveryFileSha256: null,
      requesterDeliveryConfirmedAt: null,
      deliveryHashStatus: "PENDING",
      deliveryHashVerifiedAt: null,
      state: "DELIVERY_IN_PROGRESS",
      resolutionReadiness: "PENDING",
      createdAt: now,
      updatedAt: now,
      deliveryDeadlineAt: new Date(new Date(now).getTime() + this.deliveryDeadlineMs).toISOString(),
    };

    this.deliveryContracts.set(contract.id, contract);
    await this.persist();
    return contract;
  }

  async resolveContract({ contractId, outcome }) {
    assertString(contractId, "contractId");

    const contract = this.requireDeliveryContract(contractId);

    if (outcome === "SUCCESS") {
      contract.state = "RESOLVED_SUCCESS";
      contract.resolutionReadiness = "RESOLVED";
    } else if (outcome === "HUNTER_FAULT") {
      contract.state = "RESOLVED_HUNTER_FAULT";
      contract.resolutionReadiness = "RESOLVED";
    } else if (outcome === "PAYER_FAULT") {
      contract.state = "RESOLVED_PAYER_FAULT";
      contract.resolutionReadiness = "RESOLVED";
    } else if (outcome === "EXPIRED") {
      contract.state = "RESOLVED_EXPIRED";
      contract.resolutionReadiness = "RESOLVED";
    } else {
      throw new Error(`unknown resolution outcome: ${outcome}`);
    }

    contract.updatedAt = this.now();
    await this.persist();
    return contract;
  }

  async registerHunterDeliveryFile({
    contractId,
    hunterUserId,
    fileSha256,
    fileName = null,
    fileSize = null,
  }) {
    assertString(contractId, "contractId");
    assertString(hunterUserId, "hunterUserId");

    const contract = this.requireDeliveryContract(contractId);
    this.assertContractActive(contract);

    if (contract.hunterUserId !== hunterUserId) {
      throw new Error("only the assigned hunter can commit the delivery file hash");
    }

    if (contract.state !== "DELIVERY_IN_PROGRESS") {
      throw new Error("the delivery phase is not active");
    }

    contract.hunterDeliveryFileSha256 = assertSha256Hex(fileSha256, "fileSha256");
    contract.hunterDeliveryFileName = normalizeOptionalString(fileName);
    contract.hunterDeliveryFileSize = fileSize == null ? null : assertPositiveSafeInteger(fileSize, "fileSize");
    contract.hunterDeliveryCommittedAt = this.now();
    contract.requesterDeliveryFileSha256 = null;
    contract.requesterDeliveryConfirmedAt = null;
    contract.deliveryHashVerifiedAt = null;
    contract.deliveryHashStatus = "HUNTER_COMMITTED";
    contract.resolutionReadiness = "PENDING";
    contract.updatedAt = this.now();
    await this.persist();
    return contract;
  }

  async confirmRequesterDeliveryFile({
    contractId,
    payerUserId,
    fileSha256,
  }) {
    assertString(contractId, "contractId");
    assertString(payerUserId, "payerUserId");

    const contract = this.requireDeliveryContract(contractId);
    this.assertContractActive(contract);

    if (contract.payerUserId !== payerUserId) {
      throw new Error("only the payer can confirm the delivered file hash");
    }

    if (contract.state !== "DELIVERY_IN_PROGRESS") {
      throw new Error("the delivery phase is not active");
    }

    if (!contract.hunterDeliveryFileSha256) {
      throw new Error("the hunter must commit a delivery file hash before confirmation");
    }

    const normalizedFileSha256 = assertSha256Hex(fileSha256, "fileSha256");
    contract.requesterDeliveryFileSha256 = normalizedFileSha256;
    contract.requesterDeliveryConfirmedAt = this.now();

    if (normalizedFileSha256 === contract.hunterDeliveryFileSha256) {
      contract.deliveryHashStatus = "MATCHED";
      contract.deliveryHashVerifiedAt = this.now();
      contract.state = "RESOLVED_SUCCESS";
      contract.resolutionReadiness = "RESOLVED";
    } else {
      contract.deliveryHashStatus = "MISMATCHED";
      contract.deliveryHashVerifiedAt = null;
      contract.resolutionReadiness = "PENDING_HASH_MISMATCH";
    }

    contract.updatedAt = this.now();
    await this.persist();
    return contract;
  }

  async sweepExpiredStates() {
    const now = this.now();

    for (const contract of this.deliveryContracts.values()) {
      if (contract.state === "DELIVERY_IN_PROGRESS" && isExpired(contract.deliveryDeadlineAt, now)) {
        contract.state = "RESOLVED_EXPIRED";
        contract.resolutionReadiness = "RESOLVED";
        contract.updatedAt = now;
      }
    }

    await this.persist();
  }

  requireDeliveryContract(contractId) {
    const contract = this.getDeliveryContract(contractId);

    if (!contract) {
      throw new Error(`delivery contract not found: ${contractId}`);
    }

    return contract;
  }

  assertContractActive(contract) {
    if (String(contract.state ?? "").startsWith("RESOLVED_")) {
      throw new Error("delivery contract is no longer active");
    }

    if (contract.state === "DELIVERY_IN_PROGRESS" && isExpired(contract.deliveryDeadlineAt, this.now())) {
      contract.state = "RESOLVED_EXPIRED";
      contract.resolutionReadiness = "RESOLVED";
      throw new Error("delivery contract delivery phase has expired");
    }
  }

  async persist() {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(
      this.statePath,
      JSON.stringify(
        {
          deliveryContracts: [...this.deliveryContracts.values()],
        },
        null,
        2,
      ),
    );
  }
}
