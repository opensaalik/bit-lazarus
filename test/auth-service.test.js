import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { AuthService } from "../src/auth-service.js";
import {
  BitcoinCliWalletAuthVerifier,
  MockWalletAuthVerifier,
  createWalletAuthVerifierFromEnv,
} from "../src/wallet-auth-verifier.js";
import { Signer as Bip322Signer } from "bip322-js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-auth-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("auth service issues wallet challenges and creates a user session", async () => {
  await withTempDir(async (tempDir) => {
    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
      now: () => new Date("2026-04-11T12:00:00.000Z"),
    });
    await authService.init();

    const challenge = await authService.issueChallenge({
      walletAddress: "tb1qexamplebuyer",
    });
    const result = await authService.verifyChallenge({
      challengeId: challenge.id,
      walletAddress: challenge.walletAddress,
      signature: `mock-signature:${challenge.walletAddress}:${challenge.message}`,
      displayName: "Alice",
    });

    assert.equal(result.user.walletAddress, "tb1qexamplebuyer");
    assert.equal(result.user.displayName, "Alice");
    assert.ok(result.session.token);

    const auth = await authService.authenticateSession(result.session.token);
    assert.equal(auth.user.id, result.user.id);
  });
});

test("auth service rejects invalid wallet signatures", async () => {
  await withTempDir(async (tempDir) => {
    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await authService.init();

    const challenge = await authService.issueChallenge({
      walletAddress: "tb1qexamplebuyer",
    });

    await assert.rejects(
      authService.verifyChallenge({
        challengeId: challenge.id,
        walletAddress: challenge.walletAddress,
        signature: "wrong-signature",
      }),
      /invalid wallet signature/,
    );
  });
});

test("auth service expires sessions", async () => {
  await withTempDir(async (tempDir) => {
    let now = new Date("2026-04-11T12:00:00.000Z");
    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
      now: () => now,
      sessionTtlMs: 1_000,
    });
    await authService.init();

    const challenge = await authService.issueChallenge({
      walletAddress: "tb1qexamplebuyer",
    });
    const result = await authService.verifyChallenge({
      challengeId: challenge.id,
      walletAddress: challenge.walletAddress,
      signature: `mock-signature:${challenge.walletAddress}:${challenge.message}`,
    });

    now = new Date("2026-04-11T12:00:02.000Z");
    const auth = await authService.authenticateSession(result.session.token);
    assert.equal(auth, null);
  });
});

test("bitcoin-cli verifier delegates to verifymessage on testnet4", async () => {
  const calls = [];
  const verifier = new BitcoinCliWalletAuthVerifier({
    bitcoinCliPath: "/usr/bin/bitcoin-cli",
    datadir: "/tmp/bitcoin-auth",
    chain: "testnet4",
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "true\n", stderr: "" };
    },
  });

  const result = await verifier.verifySignature({
    walletAddress: "tb1qexamplebuyer",
    message: "Bit Lazarus wallet login\nNonce: abc",
    signature: "signature-value",
  });

  assert.equal(result.valid, true);
  assert.deepEqual(calls, [
    {
      file: "/usr/bin/bitcoin-cli",
      args: [
        "-datadir=/tmp/bitcoin-auth",
        "-testnet4",
        "verifymessage",
        "tb1qexamplebuyer",
        "signature-value",
        "Bit Lazarus wallet login\nNonce: abc",
      ],
    },
  ]);
});

test("bitcoin verifier accepts modern BIP-322 signatures for bech32 wallets", async () => {
  const verifier = new BitcoinCliWalletAuthVerifier({
    execFileImpl: async () => {
      throw new Error("bitcoin-cli fallback should not be called for valid bip322 signatures");
    },
  });
  const privateKeyWif = "L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k";
  const walletAddress = "tb1q9vza2e8x573nczrlzms0wvx3gsqjx7vaxwd45v";
  const message = "Bit Lazarus modern wallet login";
  const signature = Bip322Signer.sign(privateKeyWif, walletAddress, message);

  const result = await verifier.verifySignature({
    walletAddress,
    message,
    signature,
  });

  assert.equal(result.valid, true);
});

test("bitcoin-cli verifier surfaces command failures", async () => {
  const verifier = new BitcoinCliWalletAuthVerifier({
    execFileImpl: async () => {
      const error = new Error("command failed");
      error.stderr = "Signature verification failed";
      throw error;
    },
  });

  await assert.rejects(
    verifier.verifySignature({
      walletAddress: "tb1qexamplebuyer",
      message: "Bit Lazarus wallet login\nNonce: abc",
      signature: "signature-value",
    }),
    /bitcoin-cli signature verification failed: Signature verification failed/,
  );
});

test("wallet auth verifier factory creates bitcoin-cli backend", () => {
  const verifier = createWalletAuthVerifierFromEnv({
    WALLET_AUTH_BACKEND: "bitcoin-cli",
    BITCOIN_CLI_PATH: "/usr/bin/bitcoin-cli",
    BITCOIN_CLI_DATADIR: "/tmp/bitcoin-auth",
    BITCOIN_CLI_CHAIN: "testnet4",
  });

  assert.equal(verifier.constructor.name, "BitcoinCliWalletAuthVerifier");
});
