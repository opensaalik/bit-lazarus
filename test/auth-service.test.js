import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Signer as Bip322Signer } from "bip322-js";
import { AuthService } from "../src/auth-service.js";
import {
  BitcoinCliWalletAuthVerifier,
  MockWalletAuthVerifier,
  createWalletAuthVerifierFromEnv,
} from "../src/wallet-auth-verifier.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-auth-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("auth service issues bitcoin wallet challenges and creates a user session", async () => {
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

    assert.equal(challenge.kind, "bitcoin");
    assert.equal(result.user.walletAddress, "tb1qexamplebuyer");
    assert.equal(result.user.walletType, "bitcoin");
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

test("auth service requires a wallet address for bitcoin challenges", async () => {
  await withTempDir(async (tempDir) => {
    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await authService.init();

    await assert.rejects(authService.issueChallenge({}), /walletAddress is required/);
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

test("auth service updates wallet-linked user profiles", async () => {
  await withTempDir(async (tempDir) => {
    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await authService.init();

    const challenge = await authService.issueChallenge({
      walletAddress: "tb1qprofileuser",
    });
    const result = await authService.verifyChallenge({
      challengeId: challenge.id,
      walletAddress: challenge.walletAddress,
      signature: `mock-signature:${challenge.walletAddress}:${challenge.message}`,
      displayName: "Original Name",
    });

    const updatedUser = await authService.updateUserProfile(result.user.id, {
      displayName: "Updated Name",
      bio: "Torrent bounty hunter",
    });

    assert.equal(updatedUser.displayName, "Updated Name");
    assert.equal(updatedUser.bio, "Torrent bounty hunter");
  });
});

test("bitcoin-cli verifier delegates to verifymessage with configured rpc settings", async () => {
  const calls = [];
  const verifier = new BitcoinCliWalletAuthVerifier({
    bitcoinCliPath: "/usr/bin/bitcoin-cli",
    chain: "regtest",
    rpcConnect: "127.0.0.1",
    rpcPort: "18443",
    rpcUser: "polaruser",
    rpcPassword: "polarpass",
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "true\n", stderr: "" };
    },
  });

  const result = await verifier.verifySignature({
    walletAddress: "mk2QpYatsKicvFVuTAQLBryyccRXMUaGHP",
    message: "Bit Lazarus wallet login\nNonce: abc",
    signature: "signature-value",
  });

  assert.equal(result.valid, true);
  assert.deepEqual(calls, [
    {
      file: "/usr/bin/bitcoin-cli",
      args: [
        "-regtest",
        "-rpcconnect=127.0.0.1",
        "-rpcport=18443",
        "-rpcuser=polaruser",
        "-rpcpassword=polarpass",
        "verifymessage",
        "mk2QpYatsKicvFVuTAQLBryyccRXMUaGHP",
        "signature-value",
        "Bit Lazarus wallet login\nNonce: abc",
      ],
    },
  ]);
});

test("bitcoin verifier accepts valid BIP-322 signatures without shelling out", async () => {
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

test("wallet auth verifier factory always builds the bitcoin-cli verifier", () => {
  const verifier = createWalletAuthVerifierFromEnv({
    BITCOIN_CLI_PATH: "/usr/bin/bitcoin-cli",
    BITCOIN_CLI_DATADIR: "/tmp/bitcoin-auth",
    BITCOIN_CLI_CHAIN: "regtest",
  });

  assert.equal(verifier.constructor.name, "BitcoinCliWalletAuthVerifier");
});
