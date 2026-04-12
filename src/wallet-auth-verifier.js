import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Verifier as Bip322Verifier } from "bip322-js";

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
      walletType: "bitcoin",
    };
  }
}

export class BitcoinCliWalletAuthVerifier {
  constructor({
    bitcoinCliPath = process.env.BITCOIN_CLI_PATH ?? "bitcoin-cli",
    datadir = process.env.BITCOIN_CLI_DATADIR ?? null,
    chain = process.env.BITCOIN_CLI_CHAIN ?? "regtest",
    rpcConnect = process.env.BITCOIN_CLI_RPCCONNECT ?? null,
    rpcPort = process.env.BITCOIN_CLI_RPCPORT ?? null,
    rpcUser = process.env.BITCOIN_CLI_RPCUSER ?? null,
    rpcPassword = process.env.BITCOIN_CLI_RPCPASSWORD ?? null,
    execFileImpl = execFileAsync,
  } = {}) {
    this.bitcoinCliPath = bitcoinCliPath;
    this.datadir = datadir;
    this.chain = chain;
    this.rpcConnect = rpcConnect;
    this.rpcPort = rpcPort;
    this.rpcUser = rpcUser;
    this.rpcPassword = rpcPassword;
    this.execFileImpl = execFileImpl;
  }

  async verifySignature({ walletAddress, message, signature }) {
    assertString(walletAddress, "walletAddress");
    assertString(message, "message");
    assertString(signature, "signature");

    try {
      const valid = Bip322Verifier.verifySignature(walletAddress, message, signature);

      if (valid) {
        return {
          valid: true,
          walletAddress,
          walletType: "bitcoin",
        };
      }
    } catch (_error) {
      // Fall through to bitcoin-cli for legacy signmessage compatibility.
    }

    const args = [];

    if (this.datadir) {
      args.push(`-datadir=${this.datadir}`);
    }

    if (this.chain) {
      args.push(`-${this.chain}`);
    }

    if (this.rpcConnect) {
      args.push(`-rpcconnect=${this.rpcConnect}`);
    }

    if (this.rpcPort) {
      args.push(`-rpcport=${this.rpcPort}`);
    }

    if (this.rpcUser) {
      args.push(`-rpcuser=${this.rpcUser}`);
    }

    if (this.rpcPassword) {
      args.push(`-rpcpassword=${this.rpcPassword}`);
    }

    args.push("verifymessage", walletAddress, signature, message);

    try {
      const { stdout } = await this.execFileImpl(this.bitcoinCliPath, args);
      return {
        valid: stdout.trim() === "true",
        walletAddress,
        walletType: "bitcoin",
      };
    } catch (error) {
      const stderr = error.stderr?.trim();
      const reason = stderr || error.message;
      throw new Error(`bitcoin-cli signature verification failed: ${reason}`);
    }
  }
}

export function createWalletAuthVerifierFromEnv(environment = process.env) {
  return new BitcoinCliWalletAuthVerifier({
    bitcoinCliPath: environment.BITCOIN_CLI_PATH,
    datadir: environment.BITCOIN_CLI_DATADIR,
    chain: environment.BITCOIN_CLI_CHAIN,
    rpcConnect: environment.BITCOIN_CLI_RPCCONNECT,
    rpcPort: environment.BITCOIN_CLI_RPCPORT,
    rpcUser: environment.BITCOIN_CLI_RPCUSER,
    rpcPassword: environment.BITCOIN_CLI_RPCPASSWORD,
  });
}
