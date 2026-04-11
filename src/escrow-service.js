import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ESCROW_STATUSES = {
  OPEN: "AWAITING_FUNDING",
  ACCEPTED: "FUNDED",
  SETTLED: "RELEASED",
  CANCELED: "CANCELED",
};

function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
}

function assertAmount(amountSats) {
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error("amountSats must be a positive integer");
  }
}

export class EscrowService {
  constructor({
    dataDir = path.resolve("data", "escrow"),
    lightningClient,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!lightningClient) {
      throw new Error("lightningClient is required");
    }

    this.dataDir = dataDir;
    this.statePath = path.join(this.dataDir, "escrows.json");
    this.lightningClient = lightningClient;
    this.now = now;
    this.escrows = new Map();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });

    try {
      const raw = await readFile(this.statePath, "utf8");
      const state = JSON.parse(raw);
      this.escrows = new Map((state.escrows ?? []).map((escrow) => [escrow.id, escrow]));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.persist();
    }
  }

  listEscrows() {
    return [...this.escrows.values()];
  }

  getEscrow(escrowId) {
    return this.escrows.get(escrowId) ?? null;
  }

  async createEscrow({
    escrowId = crypto.randomUUID(),
    buyerId,
    sellerId,
    mediatorId = null,
    amountSats,
    description = "",
    expirySeconds = 3600,
    metadata = {},
  }) {
    assertString(buyerId, "buyerId");
    assertString(sellerId, "sellerId");
    assertAmount(amountSats);

    if (this.escrows.has(escrowId)) {
      throw new Error(`escrow already exists: ${escrowId}`);
    }

    const preimageHex = crypto.randomBytes(32).toString("hex");
    const paymentHashHex = crypto.createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex");
    const invoice = await this.lightningClient.createHoldInvoice({
      hashHex: paymentHashHex,
      amountSats,
      memo: description || `Escrow ${escrowId}`,
      expirySeconds,
    });
    const createdAt = this.now();
    const escrow = {
      id: escrowId,
      buyerId,
      sellerId,
      mediatorId,
      amountSats,
      description,
      metadata,
      network: "lightning-testnet",
      status: ESCROW_STATUSES[invoice.state] ?? "AWAITING_FUNDING",
      createdAt,
      updatedAt: createdAt,
      funding: {
        type: "hold_invoice",
        invoiceState: invoice.state,
        paymentHashHex,
        paymentRequest: invoice.paymentRequest,
        paymentAddr: invoice.paymentAddr,
        addIndex: invoice.addIndex,
        expirySeconds,
      },
      settlement: {
        releasePreimageHex: preimageHex,
      },
    };

    this.escrows.set(escrowId, escrow);
    await this.persist();
    return escrow;
  }

  async syncEscrow(escrowId) {
    const escrow = this.requireEscrow(escrowId);
    const invoice = await this.lightningClient.lookupInvoice({
      paymentHashHex: escrow.funding.paymentHashHex,
    });

    escrow.funding.invoiceState = invoice.state;
    escrow.status = ESCROW_STATUSES[invoice.state] ?? escrow.status;
    escrow.updatedAt = this.now();
    await this.persist();
    return escrow;
  }

  async releaseEscrow(escrowId) {
    const escrow = await this.syncEscrow(escrowId);

    if (escrow.status !== "FUNDED") {
      throw new Error("escrow must be FUNDED before release");
    }

    await this.lightningClient.settleHoldInvoice({
      preimageHex: escrow.settlement.releasePreimageHex,
    });

    escrow.status = "RELEASED";
    escrow.funding.invoiceState = "SETTLED";
    escrow.updatedAt = this.now();
    await this.persist();
    return escrow;
  }

  async cancelEscrow(escrowId) {
    const escrow = this.requireEscrow(escrowId);

    if (escrow.status === "RELEASED") {
      throw new Error("released escrows cannot be canceled");
    }

    await this.lightningClient.cancelHoldInvoice({
      paymentHashHex: escrow.funding.paymentHashHex,
    });

    escrow.status = "CANCELED";
    escrow.funding.invoiceState = "CANCELED";
    escrow.updatedAt = this.now();
    await this.persist();
    return escrow;
  }

  requireEscrow(escrowId) {
    const escrow = this.getEscrow(escrowId);

    if (!escrow) {
      throw new Error(`escrow not found: ${escrowId}`);
    }

    return escrow;
  }

  async persist() {
    await writeFile(
      this.statePath,
      JSON.stringify(
        {
          escrows: this.listEscrows(),
        },
        null,
        2,
      ),
    );
  }
}

