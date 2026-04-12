import crypto from "node:crypto";

function encodeBase64FromHex(hex) {
  return Buffer.from(hex, "hex").toString("base64");
}

function decodeHexFromBase64(base64) {
  return Buffer.from(base64, "base64").toString("hex");
}

function normalizeBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function requestJson(urlString, { method = "GET", headers = {}, body, rejectUnauthorized = true } = {}) {
  const previousTlsMode = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  if (!rejectUnauthorized) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  let response;

  try {
    response = await fetch(urlString, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } finally {
    if (!rejectUnauthorized) {
      if (previousTlsMode === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsMode;
      }
    }
  }

  const payload = await response.text();
  let parsedBody = null;

  if (payload) {
    try {
      parsedBody = JSON.parse(payload);
    } catch (error) {
      throw new Error(`lightning node returned invalid JSON: ${error.message}`);
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    body: parsedBody,
  };
}

function assertAmount(amountSats) {
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error("amountSats must be a positive integer");
  }
}

function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
}

export class MockLightningClient {
  constructor() {
    this.invoices = new Map();
    this.invoicesByPaymentRequest = new Map();
    this.payments = new Map();
    this.nextAddIndex = 1;
  }

  async createHoldInvoice({ hashHex, amountSats, memo, expirySeconds = 3600 }) {
    assertAmount(amountSats);

    const invoice = {
      paymentHashHex: hashHex,
      paymentRequest: `lnmocktestnet-${hashHex}`,
      paymentAddr: crypto.randomBytes(32).toString("hex"),
      addIndex: String(this.nextAddIndex++),
      memo,
      amountSats,
      expirySeconds,
      state: "OPEN",
      type: "HOLD",
    };

    this.invoices.set(hashHex, invoice);
    this.invoicesByPaymentRequest.set(invoice.paymentRequest, invoice);
    return invoice;
  }

  async createInvoice({ amountSats, memo, expirySeconds = 3600 } = {}) {
    assertAmount(amountSats);

    const paymentPreimageHex = crypto.randomBytes(32).toString("hex");
    const paymentHashHex = crypto.createHash("sha256").update(Buffer.from(paymentPreimageHex, "hex")).digest("hex");
    const invoice = {
      paymentHashHex,
      paymentPreimageHex,
      paymentRequest: `lnmocktestnet-invoice-${paymentHashHex}`,
      paymentAddr: crypto.randomBytes(32).toString("hex"),
      addIndex: String(this.nextAddIndex++),
      memo,
      amountSats,
      expirySeconds,
      state: "OPEN",
      type: "STANDARD",
    };

    this.invoices.set(paymentHashHex, invoice);
    this.invoicesByPaymentRequest.set(invoice.paymentRequest, invoice);
    return invoice;
  }

  async lookupInvoice({ paymentHashHex }) {
    const invoice = this.invoices.get(paymentHashHex);

    if (!invoice) {
      throw new Error(`unknown invoice: ${paymentHashHex}`);
    }

    return {
      paymentHashHex,
      paymentRequest: invoice.paymentRequest,
      paymentAddr: invoice.paymentAddr,
      addIndex: invoice.addIndex,
      state: invoice.state,
      amountSats: invoice.amountSats,
    };
  }

  async cancelHoldInvoice({ paymentHashHex }) {
    const invoice = this.invoices.get(paymentHashHex);

    if (!invoice) {
      throw new Error(`unknown invoice: ${paymentHashHex}`);
    }

    invoice.state = "CANCELED";
    return { state: invoice.state };
  }

  async settleHoldInvoice({ preimageHex }) {
    const paymentHashHex = crypto.createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex");
    const invoice = this.invoices.get(paymentHashHex);

    if (!invoice) {
      throw new Error(`unknown invoice for preimage: ${paymentHashHex}`);
    }

    invoice.state = "SETTLED";
    return { state: invoice.state };
  }

  async payInvoice({ paymentRequest }) {
    assertString(paymentRequest, "paymentRequest");

    const invoice = this.invoicesByPaymentRequest.get(paymentRequest);

    if (!invoice) {
      throw new Error(`unknown invoice: ${paymentRequest}`);
    }

    if (invoice.state === "SETTLED") {
      return {
        paymentHashHex: invoice.paymentHashHex,
        paymentPreimageHex: invoice.paymentPreimageHex ?? null,
        paymentRequest,
        status: "SUCCEEDED",
      };
    }

    invoice.state = "SETTLED";
    const payment = {
      paymentHashHex: invoice.paymentHashHex,
      paymentPreimageHex: invoice.paymentPreimageHex ?? null,
      paymentRequest,
      status: "SUCCEEDED",
    };
    this.payments.set(invoice.paymentHashHex, payment);
    return payment;
  }

  async acceptHoldInvoice({ paymentHashHex }) {
    const invoice = this.invoices.get(paymentHashHex);

    if (!invoice) {
      throw new Error(`unknown invoice: ${paymentHashHex}`);
    }

    invoice.state = "ACCEPTED";
    return { state: invoice.state };
  }
}

export class LndRestLightningClient {
  constructor({ baseUrl, macaroonHex, rejectUnauthorized = true } = {}) {
    if (!baseUrl) {
      throw new Error("LIGHTNING_LND_REST_URL is required for the lnd-rest backend");
    }

    if (!macaroonHex) {
      throw new Error("LIGHTNING_LND_MACAROON_HEX is required for the lnd-rest backend");
    }

    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.macaroonHex = macaroonHex;
    this.rejectUnauthorized = rejectUnauthorized;
  }

  async createHoldInvoice({ hashHex, amountSats, memo, expirySeconds = 3600 }) {
    assertAmount(amountSats);

    const result = await this.request("/v2/invoices/hodl", {
      method: "POST",
      body: {
        memo,
        hash: encodeBase64FromHex(hashHex),
        value: String(amountSats),
        expiry: String(expirySeconds),
      },
    });

    return {
      paymentHashHex: hashHex,
      paymentRequest: result.payment_request,
      paymentAddr: result.payment_addr ? decodeHexFromBase64(result.payment_addr) : null,
      addIndex: result.add_index,
      state: "OPEN",
      amountSats,
    };
  }

  async lookupInvoice({ paymentHashHex }) {
    const query = new URLSearchParams({
      payment_hash: encodeBase64FromHex(paymentHashHex),
    });
    const result = await this.request(`/v2/invoices/lookup?${query.toString()}`);

    return {
      paymentHashHex,
      paymentRequest: result.payment_request,
      paymentAddr: result.payment_addr ? decodeHexFromBase64(result.payment_addr) : null,
      addIndex: result.add_index,
      state: result.state,
      amountSats: Number.parseInt(result.value ?? "0", 10),
    };
  }

  async cancelHoldInvoice({ paymentHashHex }) {
    const result = await this.request("/v2/invoices/cancel", {
      method: "POST",
      body: {
        payment_hash: encodeBase64FromHex(paymentHashHex),
      },
    });

    return { state: result.state ?? "CANCELED" };
  }

  async settleHoldInvoice({ preimageHex }) {
    const result = await this.request("/v2/invoices/settle", {
      method: "POST",
      body: {
        preimage: encodeBase64FromHex(preimageHex),
      },
    });

    return { state: result.state ?? "SETTLED" };
  }

  async payInvoice({ paymentRequest } = {}) {
    assertString(paymentRequest, "paymentRequest");

    const result = await this.request("/v1/channels/transactions", {
      method: "POST",
      body: {
        payment_request: paymentRequest,
      },
    });

    if (result.payment_error) {
      throw new Error(result.payment_error);
    }

    return {
      paymentHashHex: result.payment_hash ? decodeHexFromBase64(result.payment_hash) : null,
      paymentPreimageHex: result.payment_preimage ? decodeHexFromBase64(result.payment_preimage) : null,
      paymentRequest,
      status: "SUCCEEDED",
    };
  }

  async request(pathname, options = {}) {
    const response = await requestJson(`${this.baseUrl}${pathname}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        "Grpc-Metadata-macaroon": this.macaroonHex,
      },
      rejectUnauthorized: this.rejectUnauthorized,
    });

    if (!response.ok) {
      const message = response.body?.error ?? response.body?.message ?? `lightning request failed: ${response.status}`;
      throw new Error(message);
    }

    return response.body ?? {};
  }
}

export function createLightningClientFromEnv(environment = process.env) {
  const backend = environment.LIGHTNING_BACKEND ?? "mock";

  if (backend === "mock") {
    return new MockLightningClient();
  }

  if (backend === "lnd-rest") {
    return new LndRestLightningClient({
      baseUrl: environment.LIGHTNING_LND_REST_URL,
      macaroonHex: environment.LIGHTNING_LND_MACAROON_HEX,
      rejectUnauthorized: environment.LIGHTNING_LND_TLS_SKIP_VERIFY !== "1",
    });
  }

  throw new Error(`unsupported lightning backend: ${backend}`);
}
