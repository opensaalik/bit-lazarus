import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import { AuthService } from "../src/auth-service.js";
import {
  EthereumWalletAuthVerifier,
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

test("auth service issues Ethereum wallet challenges and creates a user session", async () => {
  await withTempDir(async (tempDir) => {
    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
      now: () => new Date("2026-04-11T12:00:00.000Z"),
    });
    await authService.init();

    const challenge = await authService.issueChallenge({
      walletAddress: "0x00000000000000000000000000000000000000aa",
    });
    const result = await authService.verifyChallenge({
      challengeId: challenge.id,
      walletAddress: challenge.walletAddress,
      signature: `mock-signature:${challenge.walletAddress}:${challenge.message}`,
      displayName: "Alice",
    });

    assert.equal(challenge.kind, "ethereum");
    assert.equal(result.user.walletAddress, "0x00000000000000000000000000000000000000AA");
    assert.equal(result.user.walletType, "ethereum");
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
      walletAddress: "0x00000000000000000000000000000000000000aa",
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

test("auth service requires a wallet address for Ethereum challenges", async () => {
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
      walletAddress: "0x00000000000000000000000000000000000000aa",
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
      walletAddress: "0x00000000000000000000000000000000000000aa",
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

test("Ethereum verifier accepts EIP-191 wallet signatures", async () => {
  const account = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  const message = "Bit Lazarus Ethereum wallet login";
  const signature = await account.signMessage({ message });
  const verifier = new EthereumWalletAuthVerifier();

  const result = await verifier.verifySignature({
    walletAddress: account.address,
    message,
    signature,
  });

  assert.equal(result.valid, true);
  assert.equal(result.walletAddress, account.address);
  assert.equal(result.walletType, "ethereum");
});

test("wallet auth verifier factory builds the Ethereum verifier", () => {
  const verifier = createWalletAuthVerifierFromEnv();

  assert.equal(verifier.constructor.name, "EthereumWalletAuthVerifier");
});
