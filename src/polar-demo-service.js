import { LndRestLightningClient } from "./lightning-client.js";

function normalizeBaseUrl(rawUrl) {
  return rawUrl ? rawUrl.replace(/\/$/, "") : null;
}

class BitcoinRpcClient {
  constructor({
    baseUrl = process.env.POLAR_DEMO_BITCOIN_RPC_URL ?? "http://127.0.0.1:18443",
    username = process.env.POLAR_DEMO_BITCOIN_RPC_USER ?? "polaruser",
    password = process.env.POLAR_DEMO_BITCOIN_RPC_PASSWORD ?? "polarpass",
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.username = username;
    this.password = password;
  }

  async call({ walletName = null, method, params = [] }) {
    const url = walletName
      ? `${this.baseUrl}/wallet/${encodeURIComponent(walletName)}`
      : this.baseUrl;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`,
      },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: "bit-lazarus-polar-demo",
        method,
        params,
      }),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`bitcoin rpc ${method} failed with status ${response.status}`);
    }

    if (payload.error) {
      throw new Error(`bitcoin rpc ${method} failed: ${payload.error.message}`);
    }

    return payload.result;
  }

  async signMessage({ walletName, walletAddress, message }) {
    if (!walletName) {
      throw new Error("walletName is required");
    }

    return this.call({
      walletName,
      method: "signmessage",
      params: [walletAddress, message],
    });
  }
}

export class PolarDemoService {
  constructor({
    requesterLightningClient = null,
    hunterLightningClient = null,
    requesterBitcoinWalletName = null,
    bitcoinRpcClient = null,
    paymentTimeoutMs = Number.parseInt(process.env.POLAR_DEMO_PAYMENT_TIMEOUT_MS ?? "5000", 10),
  } = {}) {
    this.requesterLightningClient = requesterLightningClient;
    this.hunterLightningClient = hunterLightningClient;
    this.requesterBitcoinWalletName = requesterBitcoinWalletName;
    this.bitcoinRpcClient = bitcoinRpcClient;
    this.paymentTimeoutMs = paymentTimeoutMs;
  }

  getCapabilities() {
    return {
      backendPayments: Boolean(this.requesterLightningClient && this.hunterLightningClient),
      backendPayoutInvoices: Boolean(this.hunterLightningClient),
      backendReceiptSigning: Boolean(this.bitcoinRpcClient && this.requesterBitcoinWalletName),
    };
  }

  async fundRequesterInvoice(paymentRequest) {
    if (!this.requesterLightningClient) {
      throw new Error("requester Polar funding is not configured");
    }

    return this.requesterLightningClient.payInvoice({
      paymentRequest,
      timeoutMs: this.paymentTimeoutMs,
      allowTimeout: true,
    });
  }

  async createHunterPayoutInvoice({ amountSats, memo }) {
    if (!this.hunterLightningClient) {
      throw new Error("hunter Polar payout invoices are not configured");
    }

    return this.hunterLightningClient.createInvoice({ amountSats, memo });
  }

  async payBondInvoice({ role, paymentRequest }) {
    const client = role === "payer" ? this.requesterLightningClient : role === "hunter" ? this.hunterLightningClient : null;

    if (!client) {
      throw new Error(`Polar bond payments are not configured for role: ${role}`);
    }

    return client.payInvoice({
      paymentRequest,
      timeoutMs: this.paymentTimeoutMs,
      allowTimeout: true,
    });
  }

  async signRequesterReceipt({ walletAddress, message }) {
    if (!this.bitcoinRpcClient || !this.requesterBitcoinWalletName) {
      throw new Error("requester receipt signing is not configured");
    }

    return this.bitcoinRpcClient.signMessage({
      walletName: this.requesterBitcoinWalletName,
      walletAddress,
      message,
    });
  }
}

export function createPolarDemoServiceFromEnv(environment = process.env) {
  const requesterRestUrl = environment.POLAR_DEMO_REQUESTER_LND_REST_URL;
  const requesterMacaroonHex = environment.POLAR_DEMO_REQUESTER_LND_MACAROON_HEX;
  const hunterRestUrl = environment.POLAR_DEMO_HUNTER_LND_REST_URL;
  const hunterMacaroonHex = environment.POLAR_DEMO_HUNTER_LND_MACAROON_HEX;
  const requesterBitcoinWalletName = environment.POLAR_DEMO_REQUESTER_BITCOIN_WALLET ?? null;

  const hasAnyDemoConfig = Boolean(
    requesterRestUrl || requesterMacaroonHex || hunterRestUrl || hunterMacaroonHex || requesterBitcoinWalletName,
  );

  if (!hasAnyDemoConfig) {
    return null;
  }

  const requesterLightningClient = requesterRestUrl && requesterMacaroonHex
    ? new LndRestLightningClient({
      baseUrl: requesterRestUrl,
      macaroonHex: requesterMacaroonHex,
      rejectUnauthorized: environment.POLAR_DEMO_REQUESTER_LND_TLS_SKIP_VERIFY !== "1",
    })
    : null;
  const hunterLightningClient = hunterRestUrl && hunterMacaroonHex
    ? new LndRestLightningClient({
      baseUrl: hunterRestUrl,
      macaroonHex: hunterMacaroonHex,
      rejectUnauthorized: environment.POLAR_DEMO_HUNTER_LND_TLS_SKIP_VERIFY !== "1",
    })
    : null;
  const bitcoinRpcClient = requesterBitcoinWalletName
    ? new BitcoinRpcClient({
      baseUrl: environment.POLAR_DEMO_BITCOIN_RPC_URL,
      username: environment.POLAR_DEMO_BITCOIN_RPC_USER,
      password: environment.POLAR_DEMO_BITCOIN_RPC_PASSWORD,
    })
    : null;

  return new PolarDemoService({
    requesterLightningClient,
    hunterLightningClient,
    requesterBitcoinWalletName,
    bitcoinRpcClient,
    paymentTimeoutMs: Number.parseInt(environment.POLAR_DEMO_PAYMENT_TIMEOUT_MS ?? "5000", 10),
  });
}
