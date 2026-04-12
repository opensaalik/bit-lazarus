function buildDefaultRpcUrl(environment) {
  const host = environment.BITCOIN_CLI_RPCCONNECT ?? "127.0.0.1";
  const port = environment.BITCOIN_CLI_RPCPORT ?? "18443";
  return `http://${host}:${port}`;
}

async function bitcoinRpc({ rpcUrl, rpcUser, rpcPassword, walletName, method, params = [] }) {
  const url = walletName
    ? `${rpcUrl.replace(/\/$/, "")}/wallet/${encodeURIComponent(walletName)}`
    : rpcUrl;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      authorization: `Basic ${Buffer.from(`${rpcUser}:${rpcPassword}`).toString("base64")}`,
    },
    body: JSON.stringify({
      jsonrpc: "1.0",
      id: "bit-lazarus-demo-auth",
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

export class PolarDemoAuthService {
  constructor({
    authService,
    rpcUrl,
    rpcUser,
    rpcPassword,
    requesterWalletName = "requester-auth",
    hunterWalletName = "hunter-auth",
  }) {
    if (!authService) {
      throw new Error("authService is required");
    }

    this.authService = authService;
    this.rpcUrl = rpcUrl;
    this.rpcUser = rpcUser;
    this.rpcPassword = rpcPassword;
    this.requesterWalletName = requesterWalletName;
    this.hunterWalletName = hunterWalletName;
  }

  isConfigured() {
    return Boolean(this.rpcUrl && this.rpcUser && this.rpcPassword);
  }

  getCapabilities() {
    return {
      backendDemoAuth: this.isConfigured(),
    };
  }

  getWalletNameForRole(role) {
    if (role === "requester") {
      return this.requesterWalletName;
    }

    if (role === "hunter") {
      return this.hunterWalletName;
    }

    throw new Error(`unknown demo auth role: ${role}`);
  }

  async ensureWallet(walletName) {
    const wallets = await bitcoinRpc({
      rpcUrl: this.rpcUrl,
      rpcUser: this.rpcUser,
      rpcPassword: this.rpcPassword,
      walletName: null,
      method: "listwalletdir",
    });
    const knownWallets = Array.isArray(wallets?.wallets) ? wallets.wallets.map((entry) => entry.name) : [];

    if (!knownWallets.includes(walletName)) {
      await bitcoinRpc({
        rpcUrl: this.rpcUrl,
        rpcUser: this.rpcUser,
        rpcPassword: this.rpcPassword,
        walletName: null,
        method: "createwallet",
        params: [walletName],
      });
      return;
    }

    const loadedWallets = await bitcoinRpc({
      rpcUrl: this.rpcUrl,
      rpcUser: this.rpcUser,
      rpcPassword: this.rpcPassword,
      walletName: null,
      method: "listwallets",
    });

    if (!loadedWallets.includes(walletName)) {
      await bitcoinRpc({
        rpcUrl: this.rpcUrl,
        rpcUser: this.rpcUser,
        rpcPassword: this.rpcPassword,
        walletName: null,
        method: "loadwallet",
        params: [walletName],
      });
    }
  }

  async getSignableAddress(walletName) {
    return bitcoinRpc({
      rpcUrl: this.rpcUrl,
      rpcUser: this.rpcUser,
      rpcPassword: this.rpcPassword,
      walletName,
      method: "getnewaddress",
      params: ["", "legacy"],
    });
  }

  async signMessage(walletName, walletAddress, message) {
    return bitcoinRpc({
      rpcUrl: this.rpcUrl,
      rpcUser: this.rpcUser,
      rpcPassword: this.rpcPassword,
      walletName,
      method: "signmessage",
      params: [walletAddress, message],
    });
  }

  async createDemoSession({ role, displayName = null }) {
    if (!this.isConfigured()) {
      throw new Error("Polar demo auth is not configured on this server");
    }

    const walletName = this.getWalletNameForRole(role);
    await this.ensureWallet(walletName);
    const walletAddress = await this.getSignableAddress(walletName);
    const challenge = await this.authService.issueChallenge({ walletAddress });
    const signature = await this.signMessage(walletName, walletAddress, challenge.message);

    return this.authService.verifyChallenge({
      challengeId: challenge.id,
      walletAddress,
      signature,
      displayName,
    });
  }
}

export function createPolarDemoAuthServiceFromEnv({ authService, environment = process.env }) {
  return new PolarDemoAuthService({
    authService,
    rpcUrl: environment.POLAR_DEMO_BITCOIN_RPC_URL ?? environment.BITCOIN_RPC_URL ?? buildDefaultRpcUrl(environment),
    rpcUser: environment.POLAR_DEMO_BITCOIN_RPC_USER ?? environment.BITCOIN_RPC_USER ?? environment.BITCOIN_CLI_RPCUSER ?? "polaruser",
    rpcPassword: environment.POLAR_DEMO_BITCOIN_RPC_PASSWORD ?? environment.BITCOIN_RPC_PASSWORD ?? environment.BITCOIN_CLI_RPCPASSWORD ?? "polarpass",
    requesterWalletName: environment.POLAR_DEMO_REQUESTER_BITCOIN_WALLET ?? "requester-auth",
    hunterWalletName: environment.POLAR_DEMO_HUNTER_BITCOIN_WALLET ?? "hunter-auth",
  });
}
