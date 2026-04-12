import test from "node:test";
import assert from "node:assert/strict";
import { LndRestLightningClient } from "../src/lightning-client.js";

test("lnd rest client creates standard invoices", async () => {
  const client = new LndRestLightningClient({
    baseUrl: "https://127.0.0.1:8080",
    macaroonHex: "00ff",
    rejectUnauthorized: false,
  });

  client.request = async (pathname, options = {}) => {
    assert.equal(pathname, "/v1/invoices");
    assert.equal(options.method, "POST");
    assert.deepEqual(options.body, {
      memo: "hunter payout",
      value: "25000",
      expiry: "3600",
    });

    return {
      r_hash: Buffer.from("11".repeat(32), "hex").toString("base64"),
      payment_request: "lnbcrt250u1ptest",
      add_index: "7",
    };
  };

  const invoice = await client.createInvoice({
    amountSats: 25_000,
    memo: "hunter payout",
  });

  assert.equal(invoice.paymentHashHex, "11".repeat(32));
  assert.equal(invoice.paymentRequest, "lnbcrt250u1ptest");
  assert.equal(invoice.addIndex, "7");
  assert.equal(invoice.amountSats, 25_000);
});
