import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EscrowService } from "../src/escrow-service.js";
import { MockLightningClient } from "../src/lightning-client.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-escrow-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("escrow creation issues a hold invoice on lightning testnet", async () => {
  await withTempDir(async (tempDir) => {
    const lightningClient = new MockLightningClient();
    const service = new EscrowService({ dataDir: tempDir, lightningClient });
    await service.init();

    const escrow = await service.createEscrow({
      escrowId: "escrow-1",
      buyerId: "alice",
      sellerId: "bob",
      amountSats: 25_000,
      description: "testnet purchase",
    });

    assert.equal(escrow.network, "lightning-testnet");
    assert.equal(escrow.status, "AWAITING_FUNDING");
    assert.equal(escrow.funding.type, "hold_invoice");
    assert.match(escrow.funding.paymentRequest, /^lnmocktestnet-/);
  });
});

test("escrow sync maps accepted hold invoices to FUNDED and release settles them", async () => {
  await withTempDir(async (tempDir) => {
    const lightningClient = new MockLightningClient();
    const service = new EscrowService({ dataDir: tempDir, lightningClient });
    await service.init();

    const escrow = await service.createEscrow({
      escrowId: "escrow-2",
      buyerId: "alice",
      sellerId: "bob",
      amountSats: 10_000,
    });

    await lightningClient.acceptHoldInvoice({
      paymentHashHex: escrow.funding.paymentHashHex,
    });

    const fundedEscrow = await service.syncEscrow(escrow.id);
    assert.equal(fundedEscrow.status, "FUNDED");

    const releasedEscrow = await service.releaseEscrow(escrow.id);
    assert.equal(releasedEscrow.status, "RELEASED");
    assert.equal(releasedEscrow.funding.invoiceState, "SETTLED");
  });
});

test("escrow cancel closes the hold invoice", async () => {
  await withTempDir(async (tempDir) => {
    const lightningClient = new MockLightningClient();
    const service = new EscrowService({ dataDir: tempDir, lightningClient });
    await service.init();

    const escrow = await service.createEscrow({
      escrowId: "escrow-3",
      buyerId: "alice",
      sellerId: "bob",
      amountSats: 5_000,
    });

    const canceledEscrow = await service.cancelEscrow(escrow.id);
    assert.equal(canceledEscrow.status, "CANCELED");
    assert.equal(canceledEscrow.funding.invoiceState, "CANCELED");
  });
});
