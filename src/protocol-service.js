import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
}

function assertStringArray(values, fieldName) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array`);
  }

  return values.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${fieldName} must contain non-empty strings`);
    }

    return value.trim();
  });
}

function assertPieceIndexes(pieceIndexes) {
  if (!Array.isArray(pieceIndexes) || pieceIndexes.length === 0) {
    throw new Error("pieceIndexes must be a non-empty array");
  }

  return [...new Set(
    pieceIndexes.map((pieceIndex) => {
      if (!Number.isInteger(pieceIndex) || pieceIndex < 0) {
        throw new Error("pieceIndexes must contain non-negative integers");
      }

      return pieceIndex;
    }),
  )].sort((left, right) => left - right);
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

function isExpired(isoTimestamp, now) {
  return new Date(isoTimestamp).getTime() <= new Date(now).getTime();
}

export class ProtocolService {
  constructor({
    dataDir = path.resolve("data", "protocol"),
    verifier,
    now = () => new Date().toISOString(),
    verificationSessionTtlMs = 15 * 60 * 1000,
    bondDeadlineMs = 30 * 60 * 1000,
    deliveryDeadlineMs = 6 * 60 * 60 * 1000,
    receiptDeadlineMs = 60 * 60 * 1000,
  } = {}) {
    if (!verifier) {
      throw new Error("verifier is required");
    }

    this.dataDir = dataDir;
    this.statePath = path.join(this.dataDir, "protocol.json");
    this.verifier = verifier;
    this.now = now;
    this.verificationSessionTtlMs = verificationSessionTtlMs;
    this.bondDeadlineMs = bondDeadlineMs;
    this.deliveryDeadlineMs = deliveryDeadlineMs;
    this.receiptDeadlineMs = receiptDeadlineMs;
    this.verificationSessions = new Map();
    this.deliveryContracts = new Map();
    this.pieceReceipts = new Map();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });

    try {
      const raw = await readFile(this.statePath, "utf8");
      const state = JSON.parse(raw);
      this.verificationSessions = new Map(
        (state.verificationSessions ?? []).map((session) => [session.id, session]),
      );
      this.deliveryContracts = new Map(
        (state.deliveryContracts ?? []).map((contract) => [contract.id, contract]),
      );
      this.pieceReceipts = new Map(
        (state.pieceReceipts ?? []).map((receipt) => [receipt.id, receipt]),
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.persist();
    }
  }

  listVerificationSessions({ bountyId } = {}) {
    return [...this.verificationSessions.values()].filter((session) => {
      if (bountyId && session.bountyId !== bountyId) {
        return false;
      }

      return true;
    });
  }

  getVerificationSession(sessionId) {
    return this.verificationSessions.get(sessionId) ?? null;
  }

  async createVerificationSession({
    verificationSessionId = crypto.randomUUID(),
    bountyId,
    payerUserId,
    hunterUserId,
    pieceIndexes,
    torrentInfoHash,
  }) {
    assertString(bountyId, "bountyId");
    assertString(payerUserId, "payerUserId");
    assertString(hunterUserId, "hunterUserId");
    assertString(torrentInfoHash, "torrentInfoHash");

    if (this.verificationSessions.has(verificationSessionId)) {
      throw new Error(`verification session already exists: ${verificationSessionId}`);
    }

    const normalizedPieceIndexes = assertPieceIndexes(pieceIndexes);
    const now = this.now();
    const session = {
      id: verificationSessionId,
      bountyId,
      payerUserId,
      hunterUserId,
      torrentInfoHash: torrentInfoHash.trim().toLowerCase(),
      pieceIndexes: normalizedPieceIndexes,
      payerNonce: crypto.randomBytes(32).toString("hex"),
      status: "PROOF_CHALLENGE_OPEN",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(new Date(now).getTime() + this.verificationSessionTtlMs).toISOString(),
      proofArtifacts: null,
      verifiedPieceIndexes: [],
      verificationSummary: null,
      contractId: null,
    };

    this.verificationSessions.set(session.id, session);
    await this.persist();
    return session;
  }

  async submitProofArtifacts({ sessionId, hunterUserId, proofArtifacts }) {
    assertString(sessionId, "sessionId");
    assertString(hunterUserId, "hunterUserId");

    const session = this.requireVerificationSession(sessionId);
    this.assertSessionActive(session);

    if (session.hunterUserId !== hunterUserId) {
      throw new Error("only the assigned hunter can submit proof artifacts");
    }

    if (!proofArtifacts || typeof proofArtifacts !== "object") {
      throw new Error("proofArtifacts is required");
    }

    const proofs = Array.isArray(proofArtifacts.proofs) ? proofArtifacts.proofs : [];

    if (proofs.length === 0) {
      throw new Error("proofArtifacts.proofs must contain at least one proof");
    }

    for (const proof of proofs) {
      if (!session.pieceIndexes.includes(proof.pieceIndex)) {
        throw new Error(`proof pieceIndex ${proof.pieceIndex} is not part of the session`);
      }
    }

    session.proofArtifacts = {
      ...proofArtifacts,
      submittedAt: this.now(),
    };
    session.status = "PROOF_SUBMITTED";
    session.updatedAt = this.now();
    await this.persist();
    return session;
  }

  async markProofVerified({ sessionId, payerUserId, verifiedPieceIndexes, verificationSummary = null }) {
    assertString(sessionId, "sessionId");
    assertString(payerUserId, "payerUserId");

    const session = this.requireVerificationSession(sessionId);
    this.assertSessionActive(session);

    if (session.payerUserId !== payerUserId) {
      throw new Error("only the payer can verify proof");
    }

    if (session.status !== "PROOF_SUBMITTED") {
      throw new Error("proof must be submitted before it can be verified");
    }

    const normalizedVerifiedPieceIndexes = assertPieceIndexes(verifiedPieceIndexes);

    for (const pieceIndex of normalizedVerifiedPieceIndexes) {
      if (!session.pieceIndexes.includes(pieceIndex)) {
        throw new Error(`verified piece ${pieceIndex} is not part of the session`);
      }
    }

    session.verifiedPieceIndexes = normalizedVerifiedPieceIndexes;
    session.verificationSummary = normalizeOptionalString(verificationSummary);
    session.status = "PROOF_VERIFIED";
    session.updatedAt = this.now();
    await this.persist();
    return session;
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

  async createDeliveryContract({
    contractId = crypto.randomUUID(),
    sessionId,
    bountyId,
    payerUserId,
    hunterUserId,
    payerWalletAddress,
    hunterWalletAddress,
    pieceIndexes,
    rewardEscrowId,
  }) {
    assertString(sessionId, "sessionId");
    assertString(bountyId, "bountyId");
    assertString(payerUserId, "payerUserId");
    assertString(hunterUserId, "hunterUserId");
    assertString(payerWalletAddress, "payerWalletAddress");
    assertString(hunterWalletAddress, "hunterWalletAddress");
    assertString(rewardEscrowId, "rewardEscrowId");

    if (this.deliveryContracts.has(contractId)) {
      throw new Error(`delivery contract already exists: ${contractId}`);
    }

    const session = this.requireVerificationSession(sessionId);

    if (session.status !== "PROOF_VERIFIED") {
      throw new Error("delivery contracts require a verified proof session");
    }

    if (session.contractId) {
      throw new Error("a delivery contract already exists for this session");
    }

    const now = this.now();
    const contract = {
      id: contractId,
      sessionId,
      bountyId,
      payerUserId,
      hunterUserId,
      payerWalletAddress,
      hunterWalletAddress,
      pieceIndexes: assertPieceIndexes(pieceIndexes),
      rewardEscrowId,
      payerBondEscrowId: null,
      hunterBondEscrowId: null,
      payerBondStatus: "PENDING",
      hunterBondStatus: "PENDING",
      requiredReceipts: assertPieceIndexes(pieceIndexes).length,
      receiptIds: [],
      state: "BOND_PENDING",
      resolutionReadiness: "PENDING",
      createdAt: now,
      updatedAt: now,
      bondDeadlineAt: new Date(new Date(now).getTime() + this.bondDeadlineMs).toISOString(),
      deliveryDeadlineAt: new Date(new Date(now).getTime() + this.deliveryDeadlineMs).toISOString(),
      receiptDeadlineAt: new Date(new Date(now).getTime() + this.receiptDeadlineMs).toISOString(),
    };

    this.deliveryContracts.set(contract.id, contract);
    session.contractId = contract.id;
    session.updatedAt = this.now();
    await this.persist();
    return contract;
  }

  async updateContractBondEscrows({
    contractId,
    payerUserId,
    payerBondEscrowId,
    hunterBondEscrowId,
    payerBondStatus,
    hunterBondStatus,
  }) {
    assertString(contractId, "contractId");
    assertString(payerUserId, "payerUserId");

    const contract = this.requireDeliveryContract(contractId);

    if (contract.payerUserId !== payerUserId) {
      throw new Error("only the payer can update contract bond status");
    }

    if (payerBondEscrowId !== undefined) {
      contract.payerBondEscrowId = normalizeOptionalString(payerBondEscrowId);
    }

    if (hunterBondEscrowId !== undefined) {
      contract.hunterBondEscrowId = normalizeOptionalString(hunterBondEscrowId);
    }

    if (payerBondStatus) {
      contract.payerBondStatus = payerBondStatus;
    }

    if (hunterBondStatus) {
      contract.hunterBondStatus = hunterBondStatus;
    }

    if (contract.payerBondStatus === "FUNDED" && contract.hunterBondStatus === "FUNDED") {
      contract.state = "DELIVERY_IN_PROGRESS";
    }

    contract.updatedAt = this.now();
    await this.persist();
    return contract;
  }

  listPieceReceipts({ contractId } = {}) {
    return [...this.pieceReceipts.values()].filter((receipt) => {
      if (contractId && receipt.contractId !== contractId) {
        return false;
      }

      return true;
    });
  }

  async submitPieceReceipt({
    contractId,
    payerUserId,
    receiptSignerWalletAddress,
    pieceIndex,
    receiptMessage,
    receiptSignature,
  }) {
    assertString(contractId, "contractId");
    assertString(payerUserId, "payerUserId");
    assertString(receiptSignerWalletAddress, "receiptSignerWalletAddress");
    assertString(receiptMessage, "receiptMessage");
    assertString(receiptSignature, "receiptSignature");

    if (!Number.isInteger(pieceIndex) || pieceIndex < 0) {
      throw new Error("pieceIndex must be a non-negative integer");
    }

    const contract = this.requireDeliveryContract(contractId);
    this.assertContractActive(contract);

    if (contract.payerUserId !== payerUserId) {
      throw new Error("only the payer can submit piece receipts");
    }

    if (contract.payerWalletAddress !== receiptSignerWalletAddress) {
      throw new Error("receipt signer wallet does not match the payer wallet");
    }

    if (!contract.pieceIndexes.includes(pieceIndex)) {
      throw new Error(`piece ${pieceIndex} is not part of the contract`);
    }

    const existingReceipt = this.listPieceReceipts({ contractId }).find((receipt) => receipt.pieceIndex === pieceIndex);

    if (existingReceipt) {
      return existingReceipt;
    }

    const verification = await this.verifier.verifySignature({
      walletAddress: receiptSignerWalletAddress,
      message: receiptMessage,
      signature: receiptSignature,
    });

    if (!verification.valid) {
      throw new Error("invalid piece receipt signature");
    }

    const receipt = {
      id: crypto.randomUUID(),
      contractId,
      pieceIndex,
      receiptMessage,
      receiptSignature,
      receiptSignerWalletAddress,
      createdAt: this.now(),
    };

    this.pieceReceipts.set(receipt.id, receipt);
    contract.receiptIds.push(receipt.id);

    if (contract.receiptIds.length >= contract.requiredReceipts) {
      contract.state = "DELIVERY_VERIFIED";
      contract.resolutionReadiness = "READY_FOR_RESOLUTION_SUCCESS";
    }

    contract.updatedAt = this.now();
    await this.persist();
    return receipt;
  }

  async sweepExpiredStates() {
    const now = this.now();

    for (const session of this.verificationSessions.values()) {
      if (
        ["PROOF_CHALLENGE_OPEN", "PROOF_SUBMITTED"].includes(session.status) &&
        isExpired(session.expiresAt, now)
      ) {
        session.status = "EXPIRED";
        session.updatedAt = now;
      }
    }

    for (const contract of this.deliveryContracts.values()) {
      if (contract.state === "BOND_PENDING" && isExpired(contract.bondDeadlineAt, now)) {
        contract.state = "EXPIRED";
        contract.resolutionReadiness = "READY_FOR_RESOLUTION_FAILURE_BOND_TIMEOUT";
        contract.updatedAt = now;
        continue;
      }

      if (contract.state === "DELIVERY_IN_PROGRESS" && isExpired(contract.deliveryDeadlineAt, now)) {
        contract.state = "EXPIRED";
        contract.resolutionReadiness = "READY_FOR_RESOLUTION_FAILURE_HUNTER_TIMEOUT";
        contract.updatedAt = now;
        continue;
      }

      if (contract.state === "DELIVERY_VERIFIED" && isExpired(contract.receiptDeadlineAt, now)) {
        contract.resolutionReadiness = "READY_FOR_RESOLUTION_SUCCESS";
        contract.updatedAt = now;
      }
    }

    await this.persist();
  }

  requireVerificationSession(sessionId) {
    const session = this.getVerificationSession(sessionId);

    if (!session) {
      throw new Error(`verification session not found: ${sessionId}`);
    }

    return session;
  }

  requireDeliveryContract(contractId) {
    const contract = this.getDeliveryContract(contractId);

    if (!contract) {
      throw new Error(`delivery contract not found: ${contractId}`);
    }

    return contract;
  }

  assertSessionActive(session) {
    if (["EXPIRED", "FAILED"].includes(session.status)) {
      throw new Error("verification session is no longer active");
    }

    if (isExpired(session.expiresAt, this.now())) {
      session.status = "EXPIRED";
      throw new Error("verification session has expired");
    }
  }

  assertContractActive(contract) {
    if (["EXPIRED", "FAILED"].includes(contract.state)) {
      throw new Error("delivery contract is no longer active");
    }

    if (contract.state === "BOND_PENDING" && isExpired(contract.bondDeadlineAt, this.now())) {
      contract.state = "EXPIRED";
      contract.resolutionReadiness = "READY_FOR_RESOLUTION_FAILURE_BOND_TIMEOUT";
      throw new Error("delivery contract bond phase has expired");
    }

    if (contract.state === "DELIVERY_IN_PROGRESS" && isExpired(contract.deliveryDeadlineAt, this.now())) {
      contract.state = "EXPIRED";
      contract.resolutionReadiness = "READY_FOR_RESOLUTION_FAILURE_HUNTER_TIMEOUT";
      throw new Error("delivery contract delivery phase has expired");
    }
  }

  async persist() {
    await writeFile(
      this.statePath,
      JSON.stringify(
        {
          verificationSessions: [...this.verificationSessions.values()],
          deliveryContracts: [...this.deliveryContracts.values()],
          pieceReceipts: [...this.pieceReceipts.values()],
        },
        null,
        2,
      ),
    );
  }
}
