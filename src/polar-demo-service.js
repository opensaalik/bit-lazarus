import { LndRestLightningClient } from "./lightning-client.js";

export class PolarDemoService {
  constructor({
    requesterLightningClient = null,
    hunterLightningClient = null,
    paymentTimeoutMs = Number.parseInt(process.env.POLAR_DEMO_PAYMENT_TIMEOUT_MS ?? "5000", 10),
  } = {}) {
    this.requesterLightningClient = requesterLightningClient;
    this.hunterLightningClient = hunterLightningClient;
    this.paymentTimeoutMs = paymentTimeoutMs;
  }

  getCapabilities() {
    return {
      backendPayments: Boolean(this.requesterLightningClient && this.hunterLightningClient),
      backendPayoutInvoices: Boolean(this.hunterLightningClient),
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
    const client = role === "payer"
      ? this.requesterLightningClient
      : role === "hunter"
        ? this.hunterLightningClient
        : null;

    if (!client) {
      throw new Error(`Polar bond payments are not configured for role: ${role}`);
    }

    return client.payInvoice({
      paymentRequest,
      timeoutMs: this.paymentTimeoutMs,
      allowTimeout: true,
    });
  }
}

export function createPolarDemoServiceFromEnv(environment = process.env) {
  const requesterLightningClient =
    environment.POLAR_DEMO_REQUESTER_LND_REST_URL && environment.POLAR_DEMO_REQUESTER_LND_MACAROON_HEX
      ? new LndRestLightningClient({
        baseUrl: environment.POLAR_DEMO_REQUESTER_LND_REST_URL,
        macaroonHex: environment.POLAR_DEMO_REQUESTER_LND_MACAROON_HEX,
        rejectUnauthorized: environment.POLAR_DEMO_REQUESTER_LND_TLS_SKIP_VERIFY !== "1",
      })
      : null;
  const hunterLightningClient =
    environment.POLAR_DEMO_HUNTER_LND_REST_URL && environment.POLAR_DEMO_HUNTER_LND_MACAROON_HEX
      ? new LndRestLightningClient({
        baseUrl: environment.POLAR_DEMO_HUNTER_LND_REST_URL,
        macaroonHex: environment.POLAR_DEMO_HUNTER_LND_MACAROON_HEX,
        rejectUnauthorized: environment.POLAR_DEMO_HUNTER_LND_TLS_SKIP_VERIFY !== "1",
      })
      : null;

  return new PolarDemoService({
    requesterLightningClient,
    hunterLightningClient,
    paymentTimeoutMs: Number.parseInt(environment.POLAR_DEMO_PAYMENT_TIMEOUT_MS ?? "5000", 10),
  });
}
