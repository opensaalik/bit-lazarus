import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { AuthService } from "../src/auth-service.js";
import { MockWalletAuthVerifier } from "../src/wallet-auth-verifier.js";

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
