import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { AuthService } from "../src/auth-service.js";
import {
  BitcoinCliWalletAuthVerifier,
  HybridWalletAuthVerifier,
  MockWalletAuthVerifier,
  WebLnWalletAuthVerifier,
  createWalletAuthVerifierFromEnv,
  recoverLightningSignMessagePubkey,
  verifyNostrEvent,
} from "../src/wallet-auth-verifier.js";
import { Signer as Bip322Signer } from "bip322-js";
import crypto from "node:crypto";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";

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

const ZBASE32_ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";

function encodeZbase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += ZBASE32_ALPHABET[(value >>> bits) & 31];
    }
  }

  if (bits > 0) {
    output += ZBASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function createLightningSignature(privKey, message) {
  const prefix = "Lightning Signed Message:";
  const combined = Buffer.concat([Buffer.from(prefix, "utf8"), Buffer.from(message, "utf8")]);
  const first = crypto.createHash("sha256").update(combined).digest();
  const msgHash = crypto.createHash("sha256").update(first).digest();

  const sig = secp256k1.sign(msgHash, privKey, { format: "recovered" });
  const recovery = typeof sig.recovery === "number" ? sig.recovery : sig[0];
  const compact = typeof sig.toCompactRawBytes === "function" ? sig.toCompactRawBytes() : sig.slice(1);

  const lndSig = new Uint8Array(65);
  lndSig[0] = 31 + recovery;
  lndSig.set(compact, 1);

  return encodeZbase32(lndSig);
}

test("webln verifier accepts valid lightning-signed messages", async () => {
  const verifier = new WebLnWalletAuthVerifier();
  const privKey = secp256k1.utils.randomSecretKey();
  const pubKey = Buffer.from(secp256k1.getPublicKey(privKey, true)).toString("hex");
  const message = "Bit Lazarus wallet login\nNonce: test123";

  const signature = createLightningSignature(privKey, message);

  const result = await verifier.verifySignature({
    walletAddress: pubKey,
    message,
    signature,
  });

  assert.equal(result.valid, true);
  assert.equal(result.walletAddress, pubKey);
  assert.equal(result.walletType, "webln");
});

test("webln verifier rejects signature from wrong key", async () => {
  const verifier = new WebLnWalletAuthVerifier();
  const signerPrivKey = secp256k1.utils.randomSecretKey();
  const otherPrivKey = secp256k1.utils.randomSecretKey();
  const otherPubKey = Buffer.from(secp256k1.getPublicKey(otherPrivKey, true)).toString("hex");
  const message = "Bit Lazarus wallet login\nNonce: test456";

  const signature = createLightningSignature(signerPrivKey, message);

  const result = await verifier.verifySignature({
    walletAddress: otherPubKey,
    message,
    signature,
  });

  assert.equal(result.valid, false);
});

test("webln verifier rejects garbage signature gracefully", async () => {
  const verifier = new WebLnWalletAuthVerifier();

  const result = await verifier.verifySignature({
    walletAddress: "02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
    message: "test",
    signature: "not-a-real-zbase32-signature",
  });

  assert.equal(result.valid, false);
});

test("hybrid verifier routes hex pubkeys to webln verifier", async () => {
  const verifier = new HybridWalletAuthVerifier();
  const privKey = secp256k1.utils.randomSecretKey();
  const pubKey = Buffer.from(secp256k1.getPublicKey(privKey, true)).toString("hex");
  const message = "Bit Lazarus wallet login\nNonce: hybrid-test";

  const signature = createLightningSignature(privKey, message);

  const result = await verifier.verifySignature({
    walletAddress: pubKey,
    message,
    signature,
  });

  assert.equal(result.valid, true);
  assert.equal(result.walletType, "webln");
});

test("hybrid verifier routes bitcoin addresses to bip322 verifier", async () => {
  const verifier = new HybridWalletAuthVerifier({
    bitcoinCliVerifier: new MockWalletAuthVerifier(),
  });

  const result = await verifier.verifySignature({
    walletAddress: "tb1qexamplebuyer",
    message: "test-message",
    signature: "mock-signature:tb1qexamplebuyer:test-message",
  });

  assert.equal(result.valid, true);
});

test("wallet auth verifier factory creates webln backend", () => {
  const verifier = createWalletAuthVerifierFromEnv({
    WALLET_AUTH_BACKEND: "webln",
  });

  assert.equal(verifier.constructor.name, "WebLnWalletAuthVerifier");
});

test("wallet auth verifier factory creates hybrid backend", () => {
  const verifier = createWalletAuthVerifierFromEnv({
    WALLET_AUTH_BACKEND: "hybrid",
  });

  assert.equal(verifier.constructor.name, "HybridWalletAuthVerifier");
});

test("auth service stores webln wallet type from verifier", async () => {
  await withTempDir(async (tempDir) => {
    const privKey = secp256k1.utils.randomSecretKey();
    const pubKey = Buffer.from(secp256k1.getPublicKey(privKey, true)).toString("hex");

    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new WebLnWalletAuthVerifier(),
    });
    await authService.init();

    const challenge = await authService.issueChallenge({ walletAddress: pubKey });
    const signature = createLightningSignature(privKey, challenge.message);

    const result = await authService.verifyChallenge({
      challengeId: challenge.id,
      walletAddress: pubKey,
      signature,
      displayName: "Lightning User",
    });

    assert.equal(result.user.walletAddress, pubKey);
    assert.equal(result.user.walletType, "webln");
    assert.equal(result.user.displayName, "Lightning User");
    assert.ok(result.session.token);
  });
});

test("auth service webln challenge flow recovers pubkey without getInfo", async () => {
  await withTempDir(async (tempDir) => {
    const privKey = secp256k1.utils.randomSecretKey();
    const pubKey = Buffer.from(secp256k1.getPublicKey(privKey, true)).toString("hex");

    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await authService.init();

    const challenge = await authService.issueChallenge({ kind: "webln" });
    assert.equal(challenge.kind, "webln");
    assert.equal(challenge.walletAddress, null);

    const signature = createLightningSignature(privKey, challenge.message);
    assert.equal(recoverLightningSignMessagePubkey(challenge.message, signature), pubKey);

    const result = await authService.verifyChallenge({
      challengeId: challenge.id,
      signature,
      displayName: "Alby user",
    });

    assert.equal(result.user.walletAddress, pubKey);
    assert.equal(result.user.walletType, "webln");
    assert.equal(result.user.displayName, "Alby user");
  });
});

test("auth service rejects bitcoin challenge without walletAddress", async () => {
  await withTempDir(async (tempDir) => {
    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await authService.init();

    await assert.rejects(authService.issueChallenge({ kind: "bitcoin" }), /walletAddress is required/);
  });
});

function createNostrSignedEvent(privKey, { challengeId, content }) {
  const pubkey = Buffer.from(schnorr.getPublicKey(privKey)).toString("hex");
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 22242;
  const tags = [["challenge", challengeId]];

  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const id = crypto.createHash("sha256").update(serialized).digest("hex");
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), privKey)).toString("hex");

  return { id, pubkey, created_at, kind, tags, content, sig };
}

test("verifyNostrEvent accepts a valid signed nostr event", () => {
  const privKey = schnorr.utils.randomSecretKey();
  const pubkey = Buffer.from(schnorr.getPublicKey(privKey)).toString("hex");
  const content = "test message";
  const event = createNostrSignedEvent(privKey, { challengeId: "c1", content });

  const result = verifyNostrEvent(event);
  assert.equal(result, pubkey);
});

test("verifyNostrEvent rejects tampered content", () => {
  const privKey = schnorr.utils.randomSecretKey();
  const event = createNostrSignedEvent(privKey, { challengeId: "c1", content: "original" });
  event.content = "tampered";

  const result = verifyNostrEvent(event);
  assert.equal(result, null);
});

test("verifyNostrEvent rejects garbage input", () => {
  assert.equal(verifyNostrEvent(null), null);
  assert.equal(verifyNostrEvent("string"), null);
  assert.equal(verifyNostrEvent({ pubkey: "abc", id: "def", sig: "ghi" }), null);
});

test("auth service nostr challenge flow verifies signed event", async () => {
  await withTempDir(async (tempDir) => {
    const privKey = schnorr.utils.randomSecretKey();
    const pubkey = Buffer.from(schnorr.getPublicKey(privKey)).toString("hex");

    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await authService.init();

    const challenge = await authService.issueChallenge({ kind: "nostr" });
    assert.equal(challenge.kind, "nostr");
    assert.equal(challenge.walletAddress, null);

    const signedEvent = createNostrSignedEvent(privKey, {
      challengeId: challenge.id,
      content: challenge.message,
    });

    const result = await authService.verifyChallenge({
      challengeId: challenge.id,
      signedEvent,
      displayName: "Nostr user",
    });

    assert.equal(result.user.walletAddress, pubkey);
    assert.equal(result.user.walletType, "nostr");
    assert.equal(result.user.displayName, "Nostr user");
    assert.ok(result.session.token);

    const auth = await authService.authenticateSession(result.session.token);
    assert.equal(auth.user.walletAddress, pubkey);
  });
});

test("auth service nostr challenge rejects mismatched challenge tag", async () => {
  await withTempDir(async (tempDir) => {
    const privKey = schnorr.utils.randomSecretKey();

    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await authService.init();

    const challenge = await authService.issueChallenge({ kind: "nostr" });
    const signedEvent = createNostrSignedEvent(privKey, {
      challengeId: "wrong-challenge-id",
      content: challenge.message,
    });

    await assert.rejects(
      authService.verifyChallenge({ challengeId: challenge.id, signedEvent }),
      /challenge tag does not match/,
    );
  });
});

test("auth service nostr challenge rejects mismatched content", async () => {
  await withTempDir(async (tempDir) => {
    const privKey = schnorr.utils.randomSecretKey();

    const authService = new AuthService({
      dataDir: tempDir,
      verifier: new MockWalletAuthVerifier(),
    });
    await authService.init();

    const challenge = await authService.issueChallenge({ kind: "nostr" });
    const signedEvent = createNostrSignedEvent(privKey, {
      challengeId: challenge.id,
      content: "wrong content",
    });

    await assert.rejects(
      authService.verifyChallenge({ challengeId: challenge.id, signedEvent }),
      /content does not match challenge/,
    );
  });
});
