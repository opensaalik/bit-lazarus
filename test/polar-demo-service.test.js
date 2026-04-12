import test from "node:test";
import assert from "node:assert/strict";
import { PolarDemoService } from "../src/polar-demo-service.js";

test("polar demo service reports capabilities from configured clients", () => {
  const service = new PolarDemoService({
    requesterLightningClient: {},
    hunterLightningClient: {},
    requesterBitcoinWalletName: "requester-auth",
    bitcoinRpcClient: {},
  });

  assert.deepEqual(service.getCapabilities(), {
    backendPayments: true,
    backendPayoutInvoices: true,
    backendReceiptSigning: true,
  });
});

test("polar demo service routes requester funding, hunter payout invoices, and receipt signing", async () => {
  const calls = [];
  const requesterLightningClient = {
    async payInvoice(args) {
      calls.push({ type: "requester-pay", args });
      return { timedOut: true, status: "PENDING" };
    },
  };
  const hunterLightningClient = {
    async createInvoice(args) {
      calls.push({ type: "hunter-invoice", args });
      return { paymentRequest: "ln-invoice" };
    },
    async payInvoice(args) {
      calls.push({ type: "hunter-pay", args });
      return { timedOut: false, status: "SUCCEEDED" };
    },
  };
  const bitcoinRpcClient = {
    async signMessage(args) {
      calls.push({ type: "sign-message", args });
      return "signed-message";
    },
  };

  const service = new PolarDemoService({
    requesterLightningClient,
    hunterLightningClient,
    requesterBitcoinWalletName: "requester-auth",
    bitcoinRpcClient,
    paymentTimeoutMs: 4321,
  });

  const funding = await service.fundRequesterInvoice("ln-hold-invoice");
  const payoutInvoice = await service.createHunterPayoutInvoice({ amountSats: 25000, memo: "memo" });
  const hunterBondPayment = await service.payBondInvoice({ role: "hunter", paymentRequest: "ln-bond" });
  const signature = await service.signRequesterReceipt({ walletAddress: "mwallet", message: "hello" });

  assert.equal(funding.timedOut, true);
  assert.equal(payoutInvoice.paymentRequest, "ln-invoice");
  assert.equal(hunterBondPayment.status, "SUCCEEDED");
  assert.equal(signature, "signed-message");
  assert.deepEqual(calls, [
    {
      type: "requester-pay",
      args: {
        paymentRequest: "ln-hold-invoice",
        timeoutMs: 4321,
        allowTimeout: true,
      },
    },
    {
      type: "hunter-invoice",
      args: {
        amountSats: 25000,
        memo: "memo",
      },
    },
    {
      type: "hunter-pay",
      args: {
        paymentRequest: "ln-bond",
        timeoutMs: 4321,
        allowTimeout: true,
      },
    },
    {
      type: "sign-message",
      args: {
        walletName: "requester-auth",
        walletAddress: "mwallet",
        message: "hello",
      },
    },
  ]);
});
