import { getAddress, verifyMessage } from "viem";

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

    const checksummedAddress = getAddress(walletAddress);
    return {
      valid: signature === `mock-signature:${checksummedAddress}:${message}`,
      walletAddress: checksummedAddress,
      walletType: "ethereum",
    };
  }
}

export class EthereumWalletAuthVerifier {
  async verifySignature({ walletAddress, message, signature }) {
    assertString(walletAddress, "walletAddress");
    assertString(message, "message");
    assertString(signature, "signature");

    const checksummedAddress = getAddress(walletAddress);
    const valid = await verifyMessage({
      address: checksummedAddress,
      message,
      signature,
    });

    return {
      valid,
      walletAddress: checksummedAddress,
      walletType: "ethereum",
    };
  }
}

export function createWalletAuthVerifierFromEnv() {
  return new EthereumWalletAuthVerifier();
}
