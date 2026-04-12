import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { verifyNostrEvent } from "./wallet-auth-verifier.js";

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

function normalizeDeliveryVerificationMode(value) {
  if (value === undefined || value === null || value === "") {
    return "receipt";
  }

  if (value !== "receipt" && value !== "torrent-hash") {
    throw new Error("deliveryVerificationMode must be either receipt or torrent-hash");
  }

  return value;
}

function isExpired(isoTimestamp, now) {
  return new Date(isoTimestamp).getTime() <= new Date(now).getTime();
}

export class ProtocolService {
  constructor({
    dataDir = path.resolve("data", "protocol"),
    verifier,
    escrowService = null,
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
    this.escrowService = escrowService;
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
    deliveryVerificationMode = "receipt",
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

    const normalizedDeliveryVerificationMode = normalizeDeliveryVerificationMode(deliveryVerificationMode);
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
      deliveryVerificationMode: normalizedDeliveryVerificationMode,
      payerBondEscrowId: null,
      hunterBondEscrowId: null,
      payerBondStatus: "PENDING",
      hunterBondStatus: "PENDING",
      payerPayoutPaymentRequest: null,
      hunterPayoutPaymentRequest: null,
      requiredReceipts: normalizedDeliveryVerificationMode === "receipt" ? assertPieceIndexes(pieceIndexes).length : 0,
      receiptIds: [],
      hunterDeliveryFileSha256: null,
      hunterDeliveryFileName: null,
      hunterDeliveryFileSize: null,
      hunterDeliveryCommittedAt: null,
      requesterDeliveryFileSha256: null,
      requesterDeliveryConfirmedAt: null,
      deliveryHashStatus: "PENDING",
      deliveryHashVerifiedAt: null,
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

  async createBondEscrows({ contractId, bondAmountSats }) {
    assertString(contractId, "contractId");

    if (!this.escrowService) {
      throw new Error("escrowService is required for bond management");
    }

    const contract = this.requireDeliveryContract(contractId);

    if (contract.payerBondEscrowId || contract.hunterBondEscrowId) {
      throw new Error("bond escrows already exist for this contract");
    }

    const payerBondEscrow = await this.escrowService.createEscrow({
      escrowId: `bond-payer-${contractId}`,
      buyerId: contract.payerUserId,
      sellerId: `contract:${contractId}`,
      amountSats: bondAmountSats,
      description: `Payer collateral bond for contract ${contractId}`,
      metadata: { kind: "payer-bond", contractId },
    });

    const hunterBondEscrow = await this.escrowService.createEscrow({
      escrowId: `bond-hunter-${contractId}`,
      buyerId: contract.hunterUserId,
      sellerId: `contract:${contractId}`,
      amountSats: bondAmountSats,
      description: `Hunter collateral bond for contract ${contractId}`,
      metadata: { kind: "hunter-bond", contractId },
    });

    contract.payerBondEscrowId = payerBondEscrow.id;
    contract.hunterBondEscrowId = hunterBondEscrow.id;
    contract.payerBondStatus = "AWAITING_FUNDING";
    contract.hunterBondStatus = "AWAITING_FUNDING";
    contract.bondAmountSats = bondAmountSats;
    contract.updatedAt = this.now();
    await this.persist();

    return {
      contract,
      payerBondEscrow,
      hunterBondEscrow,
    };
  }

  async syncBondStatus({ contractId }) {
    assertString(contractId, "contractId");

    if (!this.escrowService) {
      throw new Error("escrowService is required for bond management");
    }

    const contract = this.requireDeliveryContract(contractId);

    if (contract.payerBondEscrowId) {
      const payerEscrow = await this.escrowService.syncEscrow(contract.payerBondEscrowId);
      contract.payerBondStatus = payerEscrow.status;
    }

    if (contract.hunterBondEscrowId) {
      const hunterEscrow = await this.escrowService.syncEscrow(contract.hunterBondEscrowId);
      contract.hunterBondStatus = hunterEscrow.status;
    }

    if (contract.payerBondStatus === "FUNDED" && contract.hunterBondStatus === "FUNDED") {
      contract.state = "DELIVERY_IN_PROGRESS";
    }

    contract.updatedAt = this.now();
    await this.persist();
    return contract;
  }

  async resolveContract({ contractId, outcome }) {
    assertString(contractId, "contractId");

    if (!this.escrowService) {
      throw new Error("escrowService is required for resolution");
    }

    const contract = this.requireDeliveryContract(contractId);

    if (outcome === "SUCCESS") {
      this.assertPayoutInvoice(contract.hunterPayoutPaymentRequest, "hunter payout");
      if (contract.rewardEscrowId) {
        await this.escrowService.releaseEscrowToPaymentRequest(contract.rewardEscrowId, {
          payoutPaymentRequest: contract.hunterPayoutPaymentRequest,
          payoutMemo: `Reward payout for contract ${contractId}`,
        });
      }
      if (contract.payerBondEscrowId) {
        await this.escrowService.cancelEscrow(contract.payerBondEscrowId);
      }
      if (contract.hunterBondEscrowId) {
        await this.escrowService.cancelEscrow(contract.hunterBondEscrowId);
      }
      contract.state = "RESOLVED_SUCCESS";
      contract.resolutionReadiness = "RESOLVED";
    } else if (outcome === "HUNTER_FAULT") {
      this.assertPayoutInvoice(contract.payerPayoutPaymentRequest, "payer payout");
      if (contract.rewardEscrowId) {
        await this.escrowService.cancelEscrow(contract.rewardEscrowId);
      }
      if (contract.payerBondEscrowId) {
        await this.escrowService.cancelEscrow(contract.payerBondEscrowId);
      }
      if (contract.hunterBondEscrowId) {
        await this.escrowService.releaseEscrowToPaymentRequest(contract.hunterBondEscrowId, {
          payoutPaymentRequest: contract.payerPayoutPaymentRequest,
          payoutMemo: `Hunter bond slashing payout for contract ${contractId}`,
        });
      }
      contract.state = "RESOLVED_HUNTER_FAULT";
      contract.resolutionReadiness = "RESOLVED";
    } else if (outcome === "PAYER_FAULT") {
      this.assertPayoutInvoice(contract.hunterPayoutPaymentRequest, "hunter payout");
      if (contract.rewardEscrowId) {
        await this.escrowService.releaseEscrowToPaymentRequest(contract.rewardEscrowId, {
          payoutPaymentRequest: contract.hunterPayoutPaymentRequest,
          payoutMemo: `Reward payout for contract ${contractId}`,
        });
      }
      if (contract.payerBondEscrowId) {
        await this.escrowService.releaseEscrowToPaymentRequest(contract.payerBondEscrowId, {
          payoutPaymentRequest: contract.hunterPayoutPaymentRequest,
          payoutMemo: `Payer bond slashing payout for contract ${contractId}`,
        });
      }
      if (contract.hunterBondEscrowId) {
        await this.escrowService.cancelEscrow(contract.hunterBondEscrowId);
      }
      contract.state = "RESOLVED_PAYER_FAULT";
      contract.resolutionReadiness = "RESOLVED";
    } else if (outcome === "EXPIRED") {
      if (contract.rewardEscrowId) {
        await this.escrowService.cancelEscrow(contract.rewardEscrowId);
      }
      if (contract.payerBondEscrowId) {
        await this.escrowService.cancelEscrow(contract.payerBondEscrowId);
      }
      if (contract.hunterBondEscrowId) {
        await this.escrowService.cancelEscrow(contract.hunterBondEscrowId);
      }
      contract.state = "RESOLVED_EXPIRED";
      contract.resolutionReadiness = "RESOLVED";
    } else {
      throw new Error(`unknown resolution outcome: ${outcome}`);
    }

    contract.updatedAt = this.now();
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
      throw new Error("payerBondStatus can no longer be set manually; sync the bond escrows instead");
    }

    if (hunterBondStatus) {
      throw new Error("hunterBondStatus can no longer be set manually; sync the bond escrows instead");
    }

    contract.updatedAt = this.now();
    await this.persist();
    return contract;
  }

  async registerContractPayoutInvoice({ contractId, userId, paymentRequest }) {
    assertString(contractId, "contractId");
    assertString(userId, "userId");
    assertString(paymentRequest, "paymentRequest");

    const contract = this.requireDeliveryContract(contractId);

    if (contract.payerUserId === userId) {
      contract.payerPayoutPaymentRequest = paymentRequest.trim();
    } else if (contract.hunterUserId === userId) {
      contract.hunterPayoutPaymentRequest = paymentRequest.trim();
    } else {
      throw new Error("only the payer or hunter can register payout invoices");
    }

    contract.updatedAt = this.now();
    await this.persist();

    const retryOutcome = this.getResolutionOutcomeForContract(contract);

    if (retryOutcome && this.escrowService) {
      try {
        await this.resolveContract({ contractId: contract.id, outcome: retryOutcome });
      } catch (_error) {
        // The periodic sweep will retry if the counterpart invoice is still missing or routing fails.
      }
    }

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

    if ((contract.deliveryVerificationMode ?? "receipt") !== "torrent-hash") {
      throw new Error("this contract does not use torrent-hash delivery verification");
    }

    if (contract.hunterUserId !== hunterUserId) {
      throw new Error("only the assigned hunter can commit the delivery file hash");
    }

    if (contract.state !== "DELIVERY_IN_PROGRESS") {
      throw new Error("the delivery phase must be active before the hunter can start seeding");
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

    if ((contract.deliveryVerificationMode ?? "receipt") !== "torrent-hash") {
      throw new Error("this contract does not use torrent-hash delivery verification");
    }

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
      contract.state = "DELIVERY_VERIFIED";
      contract.resolutionReadiness = "READY_FOR_RESOLUTION_SUCCESS";

      if (this.escrowService) {
        try {
          await this.resolveContract({ contractId: contract.id, outcome: "SUCCESS" });
        } catch (_resolveError) {
          // Resolution will be retried by payout invoice registration or the sweep timer if needed.
        }
      }
    } else {
      contract.deliveryHashStatus = "MISMATCHED";
      contract.deliveryHashVerifiedAt = null;
      contract.resolutionReadiness = "PENDING_HASH_MISMATCH";
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
    receiptSignedEvent = null,
  }) {
    assertString(contractId, "contractId");
    assertString(payerUserId, "payerUserId");
    assertString(receiptSignerWalletAddress, "receiptSignerWalletAddress");
    assertString(receiptMessage, "receiptMessage");

    if (receiptSignature !== null && receiptSignature !== undefined && typeof receiptSignature !== "string") {
      throw new Error("receiptSignature must be a string");
    }

    if (receiptSignedEvent !== null && receiptSignedEvent !== undefined && typeof receiptSignedEvent !== "object") {
      throw new Error("receiptSignedEvent must be an object");
    }

    if (!receiptSignature && !receiptSignedEvent) {
      throw new Error("receiptSignature or receiptSignedEvent is required");
    }

    if (!Number.isInteger(pieceIndex) || pieceIndex < 0) {
      throw new Error("pieceIndex must be a non-negative integer");
    }

    const contract = this.requireDeliveryContract(contractId);
    this.assertContractActive(contract);

    if ((contract.deliveryVerificationMode ?? "receipt") !== "receipt") {
      throw new Error("piece receipts are only supported for receipt-verified contracts");
    }

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

    if (receiptSignedEvent) {
      if (receiptSignedEvent.content !== receiptMessage) {
        throw new Error("signed receipt event content does not match the receipt message");
      }

      const verifiedPubkey = verifyNostrEvent(receiptSignedEvent);

      if (!verifiedPubkey || verifiedPubkey.toLowerCase() !== receiptSignerWalletAddress.toLowerCase()) {
        throw new Error("invalid piece receipt signature");
      }
    } else {
      const verification = await this.verifier.verifySignature({
        walletAddress: receiptSignerWalletAddress,
        message: receiptMessage,
        signature: receiptSignature,
      });

      if (!verification.valid) {
        throw new Error("invalid piece receipt signature");
      }
    }

    const receipt = {
      id: crypto.randomUUID(),
      contractId,
      pieceIndex,
      receiptMessage,
      receiptSignature: receiptSignature ?? null,
      receiptSignedEvent,
      receiptSignerWalletAddress,
      createdAt: this.now(),
    };

    this.pieceReceipts.set(receipt.id, receipt);
    contract.receiptIds.push(receipt.id);

    if (contract.receiptIds.length >= contract.requiredReceipts) {
      contract.state = "DELIVERY_VERIFIED";
      contract.resolutionReadiness = "READY_FOR_RESOLUTION_SUCCESS";

      if (this.escrowService) {
        try {
          await this.resolveContract({ contractId: contract.id, outcome: "SUCCESS" });
        } catch (_resolveError) {
          // Resolution will be retried by the sweep timer if it fails here.
        }
      }
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
        if (this.escrowService) {
          try { await this.resolveContract({ contractId: contract.id, outcome: "EXPIRED" }); } catch (_e) { /* retry next sweep */ }
        }
        continue;
      }

      if (contract.state === "DELIVERY_IN_PROGRESS" && isExpired(contract.deliveryDeadlineAt, now)) {
        contract.state = "EXPIRED";
        contract.resolutionReadiness = "READY_FOR_RESOLUTION_FAILURE_HUNTER_TIMEOUT";
        contract.updatedAt = now;
        if (this.escrowService) {
          try { await this.resolveContract({ contractId: contract.id, outcome: "HUNTER_FAULT" }); } catch (_e) { /* retry next sweep */ }
        }
        continue;
      }

      if (contract.state === "DELIVERY_VERIFIED" && isExpired(contract.receiptDeadlineAt, now)) {
        contract.resolutionReadiness = "READY_FOR_RESOLUTION_SUCCESS";
        contract.updatedAt = now;
        if (this.escrowService) {
          try { await this.resolveContract({ contractId: contract.id, outcome: "SUCCESS" }); } catch (_e) { /* retry next sweep */ }
        }
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

  assertPayoutInvoice(paymentRequest, label) {
    if (!paymentRequest || typeof paymentRequest !== "string") {
      throw new Error(`${label} invoice is required before funds can be disbursed`);
    }
  }

  getResolutionOutcomeForContract(contract) {
    if (contract.resolutionReadiness === "READY_FOR_RESOLUTION_SUCCESS") {
      return "SUCCESS";
    }

    if (contract.resolutionReadiness === "READY_FOR_RESOLUTION_FAILURE_HUNTER_TIMEOUT") {
      return "HUNTER_FAULT";
    }

    return null;
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
