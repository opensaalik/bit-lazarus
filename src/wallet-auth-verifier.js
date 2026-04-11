import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export class BitcoinCliWalletAuthVerifier {
  constructor({
    bitcoinCliPath = process.env.BITCOIN_CLI_PATH ?? "bitcoin-cli",
    datadir = process.env.BITCOIN_CLI_DATADIR ?? null,
    chain = process.env.BITCOIN_CLI_CHAIN ?? "testnet4",
    execFileImpl = execFileAsync,
  } = {}) {
    this.bitcoinCliPath = bitcoinCliPath;
    this.datadir = datadir;
    this.chain = chain;
    this.execFileImpl = execFileImpl;
  }

  async verifySignature({ walletAddress, message, signature }) {
    assertString(walletAddress, "walletAddress");
    assertString(message, "message");
    assertString(signature, "signature");

    const args = [];

    if (this.datadir) {
      args.push(`-datadir=${this.datadir}`);
    }

    if (this.chain) {
      args.push(`-${this.chain}`);
    }

    args.push("verifymessage", walletAddress, signature, message);

    try {
      const { stdout } = await this.execFileImpl(this.bitcoinCliPath, args);
      return {
        valid: stdout.trim() === "true",
        walletAddress,
      };
    } catch (error) {
      const stderr = error.stderr?.trim();
      const reason = stderr || error.message;
      throw new Error(`bitcoin-cli signature verification failed: ${reason}`);
    }
  }
}

export function createWalletAuthVerifierFromEnv(environment = process.env) {
  const backend = environment.WALLET_AUTH_BACKEND ?? "mock";

  if (backend === "mock") {
    return new MockWalletAuthVerifier();
  }

  if (backend === "bitcoin-cli") {
    return new BitcoinCliWalletAuthVerifier({
      bitcoinCliPath: environment.BITCOIN_CLI_PATH,
      datadir: environment.BITCOIN_CLI_DATADIR,
      chain: environment.BITCOIN_CLI_CHAIN,
    });
  }

  throw new Error(`unsupported wallet auth backend: ${backend}`);
}
