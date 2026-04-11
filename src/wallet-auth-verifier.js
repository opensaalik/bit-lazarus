function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
}

export class MockWalletAuthVerifier {
  async verifySignature({ walletAddress, message, signature }) {
    assertString(walletAddress, "walletAddress");
    assertString(message, "message");
    assertString(signature, "signature");

    return {
      valid: signature === `mock-signature:${walletAddress}:${message}`,
      walletAddress,
    };
  }
}

export function createWalletAuthVerifierFromEnv(environment = process.env) {
  const backend = environment.WALLET_AUTH_BACKEND ?? "mock";

  if (backend === "mock") {
    return new MockWalletAuthVerifier();
  }

  throw new Error(`unsupported wallet auth backend: ${backend}`);
}

