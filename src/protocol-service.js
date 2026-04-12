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
    escrowService = null,
    now = () => new Date().toISOString(),
    bondDeadlineMs = 30 * 60 * 1000,
    deliveryDeadlineMs = 6 * 60 * 60 * 1000,
  } = {}) {
    this.dataDir = dataDir;
    this.statePath = path.join(this.dataDir, "protocol.json");
    this.escrowService = escrowService;
    this.now = now;
    this.bondDeadlineMs = bondDeadlineMs;
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

  async createDeliveryContract({
    contractId = crypto.randomUUID(),
    bountyId,
    payerUserId,
    hunterUserId,
    payerWalletAddress,
    hunterWalletAddress,
    rewardEscrowId,
  }) {
    assertString(bountyId, "bountyId");
    assertString(payerUserId, "payerUserId");
    assertString(hunterUserId, "hunterUserId");
    assertString(payerWalletAddress, "payerWalletAddress");
    assertString(hunterWalletAddress, "hunterWalletAddress");
    assertString(rewardEscrowId, "rewardEscrowId");

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
      rewardEscrowId,
      payerBondEscrowId: null,
      hunterBondEscrowId: null,
      payerBondStatus: "PENDING",
      hunterBondStatus: "PENDING",
      payerPayoutPaymentRequest: null,
      hunterPayoutPaymentRequest: null,
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
    };

    this.deliveryContracts.set(contract.id, contract);
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

  async sweepExpiredStates() {
    const now = this.now();

    for (const contract of this.deliveryContracts.values()) {
      if (contract.state === "BOND_PENDING" && isExpired(contract.bondDeadlineAt, now)) {
        contract.state = "EXPIRED";
        contract.resolutionReadiness = "READY_FOR_RESOLUTION_FAILURE_BOND_TIMEOUT";
        contract.updatedAt = now;
        if (this.escrowService) {
          try {
            await this.resolveContract({ contractId: contract.id, outcome: "EXPIRED" });
          } catch (_error) {
            // Retry next sweep.
          }
        }
        continue;
      }

      if (contract.state === "DELIVERY_IN_PROGRESS" && isExpired(contract.deliveryDeadlineAt, now)) {
        contract.state = "EXPIRED";
        contract.resolutionReadiness = "READY_FOR_RESOLUTION_FAILURE_HUNTER_TIMEOUT";
        contract.updatedAt = now;
        if (this.escrowService) {
          try {
            await this.resolveContract({ contractId: contract.id, outcome: "HUNTER_FAULT" });
          } catch (_error) {
            // Retry next sweep.
          }
        }
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
