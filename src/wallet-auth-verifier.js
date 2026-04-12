import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Verifier as Bip322Verifier } from "bip322-js";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";

const execFileAsync = promisify(execFile);

const ZBASE32_ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";
const ZBASE32_INVERSE = new Uint8Array(128);
for (let i = 0; i < ZBASE32_ALPHABET.length; i++) {
  ZBASE32_INVERSE[ZBASE32_ALPHABET.charCodeAt(i)] = i;
}

function decodeZbase32(encoded) {
  let bits = 0;
  let value = 0;
  const output = [];

  for (const char of encoded) {
    value = (value << 5) | ZBASE32_INVERSE[char.charCodeAt(0)];
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }

  return new Uint8Array(output);
}

function lightningMessageHash(message) {
  const prefix = "Lightning Signed Message:";
  const prefixBuffer = Buffer.from(prefix, "utf8");
  const messageBuffer = Buffer.from(message, "utf8");
  const combined = Buffer.concat([prefixBuffer, messageBuffer]);
  const first = crypto.createHash("sha256").update(combined).digest();
  return crypto.createHash("sha256").update(first).digest();
}

/**
 * Recovers the signer's compressed secp256k1 pubkey (hex) from a WebLN / LND
 * signMessage zbase32 signature. Used when the wallet does not expose a pubkey
 * in webln.getInfo() (e.g. some Alby connector setups).
 */
export function recoverLightningSignMessagePubkey(message, signature) {
  if (typeof message !== "string" || typeof signature !== "string") {
    return null;
  }

  try {
    const sigBytes = decodeZbase32(signature);

    if (sigBytes.length !== 65) {
      return null;
    }

    const recoveryFlag = sigBytes[0];
    const recovery = (recoveryFlag - 31) & 3;
    const compactSig = sigBytes.slice(1);
    const msgHash = lightningMessageHash(message);

    const recoveredSig = new Uint8Array(65);
    recoveredSig[0] = recovery;
    recoveredSig.set(compactSig, 1);

    const recoveredPub = secp256k1.recoverPublicKey(recoveredSig, msgHash);
    return Buffer.from(recoveredPub).toString("hex");
  } catch (_error) {
    return null;
  }
}

/**
 * Verifies a signed Nostr event (NIP-07 / NIP-01). Returns the event pubkey
 * if the schnorr signature and event id are valid, or null on failure.
 */
export function verifyNostrEvent(signedEvent) {
  if (!signedEvent || typeof signedEvent !== "object") {
    return null;
  }

  const { pubkey, created_at, kind, tags, content, id, sig } = signedEvent;

  if (typeof pubkey !== "string" || typeof id !== "string" || typeof sig !== "string") {
    return null;
  }

  try {
    const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
    const expectedId = crypto.createHash("sha256").update(serialized).digest("hex");

    if (expectedId !== id) {
      return null;
    }

    const valid = schnorr.verify(
      Buffer.from(sig, "hex"),
      Buffer.from(id, "hex"),
      Buffer.from(pubkey, "hex"),
    );

    return valid ? pubkey : null;
  } catch (_error) {
    return null;
  }
}

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
        };
      }
    } catch (_error) {
      // Fall through to bitcoin-cli for legacy compatibility and clearer diagnostics.
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
      };
    } catch (error) {
      const stderr = error.stderr?.trim();
      const reason = stderr || error.message;
      throw new Error(`bitcoin-cli signature verification failed: ${reason}`);
    }
  }
}

export class WebLnWalletAuthVerifier {
  async verifySignature({ walletAddress, message, signature }) {
    assertString(walletAddress, "walletAddress");
    assertString(message, "message");
    assertString(signature, "signature");

    const recoveredHex = recoverLightningSignMessagePubkey(message, signature);

    if (!recoveredHex) {
      return { valid: false, walletAddress };
    }

    return {
      valid: recoveredHex === walletAddress.toLowerCase(),
      walletAddress,
      walletType: "webln",
    };
  }
}

export class HybridWalletAuthVerifier {
  constructor({ bitcoinCliVerifier, weblnVerifier } = {}) {
    this.bitcoinCliVerifier = bitcoinCliVerifier ?? new BitcoinCliWalletAuthVerifier();
    this.weblnVerifier = weblnVerifier ?? new WebLnWalletAuthVerifier();
  }

  async verifySignature({ walletAddress, message, signature }) {
    const isHexPubkey = /^(02|03)[0-9a-f]{64}$/i.test(walletAddress);

    if (isHexPubkey) {
      return this.weblnVerifier.verifySignature({ walletAddress, message, signature });
    }

    return this.bitcoinCliVerifier.verifySignature({ walletAddress, message, signature });
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
      rpcConnect: environment.BITCOIN_CLI_RPCCONNECT,
      rpcPort: environment.BITCOIN_CLI_RPCPORT,
      rpcUser: environment.BITCOIN_CLI_RPCUSER,
      rpcPassword: environment.BITCOIN_CLI_RPCPASSWORD,
    });
  }

  if (backend === "webln") {
    return new WebLnWalletAuthVerifier();
  }

  if (backend === "hybrid") {
    return new HybridWalletAuthVerifier({
      bitcoinCliVerifier: new BitcoinCliWalletAuthVerifier({
        bitcoinCliPath: environment.BITCOIN_CLI_PATH,
        datadir: environment.BITCOIN_CLI_DATADIR,
        chain: environment.BITCOIN_CLI_CHAIN,
        rpcConnect: environment.BITCOIN_CLI_RPCCONNECT,
        rpcPort: environment.BITCOIN_CLI_RPCPORT,
        rpcUser: environment.BITCOIN_CLI_RPCUSER,
        rpcPassword: environment.BITCOIN_CLI_RPCPASSWORD,
      }),
    });
  }

  throw new Error(`unsupported wallet auth backend: ${backend}`);
}
