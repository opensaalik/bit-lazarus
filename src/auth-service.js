import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { recoverLightningSignMessagePubkey, verifyNostrEvent } from "./wallet-auth-verifier.js";

function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
}

function normalizeWalletAddress(walletAddress) {
  assertString(walletAddress, "walletAddress");
  return walletAddress.trim();
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("profile fields must be strings");
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export class AuthService {
  constructor({
    dataDir = path.resolve("data", "auth"),
    now = () => new Date(),
    verifier,
    challengeTtlMs = 5 * 60 * 1000,
    sessionTtlMs = 7 * 24 * 60 * 60 * 1000,
  } = {}) {
    if (!verifier) {
      throw new Error("verifier is required");
    }

    this.dataDir = dataDir;
    this.statePath = path.join(this.dataDir, "auth.json");
    this.now = now;
    this.verifier = verifier;
    this.challengeTtlMs = challengeTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.users = new Map();
    this.userIdsByWalletAddress = new Map();
    this.challenges = new Map();
    this.sessions = new Map();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });

    try {
      const raw = await readFile(this.statePath, "utf8");
      const state = JSON.parse(raw);

      this.users = new Map((state.users ?? []).map((user) => [user.id, user]));
      this.userIdsByWalletAddress = new Map(
        [...this.users.values()].map((user) => [user.walletAddress, user.id]),
      );
      this.challenges = new Map((state.challenges ?? []).map((challenge) => [challenge.id, challenge]));
      this.sessions = new Map((state.sessions ?? []).map((session) => [session.token, session]));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.persist();
    }
  }

  async issueChallenge({ walletAddress, kind = "bitcoin" } = {}) {
    const now = this.now();
    const id = crypto.randomUUID();
    const nonceBytes = crypto.randomBytes(16).toString("hex");

    if (kind === "webln") {
      const challenge = {
        id,
        kind: "webln",
        walletAddress: null,
        nonce: nonceBytes,
        message: [
          "Bit Lazarus wallet login (WebLN)",
          `Challenge ID: ${id}`,
          `Nonce: ${nonceBytes}`,
          `Issued At: ${now.toISOString()}`,
        ].join("\n"),
        expiresAt: new Date(now.getTime() + this.challengeTtlMs).toISOString(),
        createdAt: now.toISOString(),
      };

      this.challenges.set(challenge.id, challenge);
      await this.persist();
      return challenge;
    }

    if (kind === "nostr") {
      const challenge = {
        id,
        kind: "nostr",
        walletAddress: null,
        nonce: nonceBytes,
        message: [
          "Bit Lazarus wallet login (Nostr)",
          `Challenge ID: ${id}`,
          `Nonce: ${nonceBytes}`,
          `Issued At: ${now.toISOString()}`,
        ].join("\n"),
        expiresAt: new Date(now.getTime() + this.challengeTtlMs).toISOString(),
        createdAt: now.toISOString(),
      };

      this.challenges.set(challenge.id, challenge);
      await this.persist();
      return challenge;
    }

    if (kind !== "bitcoin") {
      throw new Error("challenge kind must be bitcoin, webln, or nostr");
    }

    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
    const challenge = {
      id,
      kind: "bitcoin",
      walletAddress: normalizedWalletAddress,
      nonce: nonceBytes,
      message: [
        "Bit Lazarus wallet login",
        `Wallet: ${normalizedWalletAddress}`,
        `Nonce: ${crypto.randomBytes(16).toString("hex")}`,
        `Issued At: ${now.toISOString()}`,
      ].join("\n"),
      expiresAt: new Date(now.getTime() + this.challengeTtlMs).toISOString(),
      createdAt: now.toISOString(),
    };

    this.challenges.set(challenge.id, challenge);
    await this.persist();
    return challenge;
  }

  async verifyChallenge({ challengeId, walletAddress, signature, signedEvent, displayName = null }) {
    assertString(challengeId, "challengeId");

    const challenge = this.challenges.get(challengeId);

    if (!challenge) {
      throw new Error("challenge not found");
    }

    if (new Date(challenge.expiresAt).getTime() < this.now().getTime()) {
      this.challenges.delete(challengeId);
      await this.persist();
      throw new Error("challenge expired");
    }

    let normalizedWalletAddress;
    let walletType;

    if (challenge.kind === "nostr") {
      if (!signedEvent || typeof signedEvent !== "object") {
        throw new Error("signedEvent is required for nostr challenges");
      }

      if (signedEvent.content !== challenge.message) {
        throw new Error("signed event content does not match challenge");
      }

      const challengeTag = (signedEvent.tags ?? []).find((t) => t[0] === "challenge");
      if (!challengeTag || challengeTag[1] !== challengeId) {
        throw new Error("signed event challenge tag does not match");
      }

      const verifiedPubkey = verifyNostrEvent(signedEvent);

      if (!verifiedPubkey) {
        throw new Error("invalid nostr event signature");
      }

      normalizedWalletAddress = verifiedPubkey;
      walletType = "nostr";
    } else if (challenge.kind === "webln") {
      assertString(signature, "signature");
      const recoveredPub = recoverLightningSignMessagePubkey(challenge.message, signature);

      if (!recoveredPub) {
        throw new Error("invalid wallet signature");
      }

      normalizedWalletAddress = recoveredPub;
      walletType = "webln";
    } else {
      assertString(signature, "signature");
      assertString(walletAddress, "walletAddress");
      normalizedWalletAddress = normalizeWalletAddress(walletAddress);

      if (challenge.walletAddress !== normalizedWalletAddress) {
        throw new Error("walletAddress does not match challenge");
      }

      const verification = await this.verifier.verifySignature({
        walletAddress: normalizedWalletAddress,
        message: challenge.message,
        signature,
      });

      if (!verification.valid) {
        throw new Error("invalid wallet signature");
      }

      walletType = verification.walletType ?? "bitcoin";
    }
    const user = await this.findOrCreateUser({
      walletAddress: normalizedWalletAddress,
      displayName,
      walletType,
    });
    const session = {
      token: crypto.randomBytes(32).toString("hex"),
      userId: user.id,
      walletAddress: user.walletAddress,
      createdAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + this.sessionTtlMs).toISOString(),
    };

    this.sessions.set(session.token, session);
    this.challenges.delete(challengeId);
    await this.persist();

    return {
      user,
      session,
    };
  }

  async authenticateSession(token) {
    assertString(token, "token");

    const session = this.sessions.get(token);

    if (!session) {
      return null;
    }

    if (new Date(session.expiresAt).getTime() < this.now().getTime()) {
      this.sessions.delete(token);
      await this.persist();
      return null;
    }

    const user = this.users.get(session.userId) ?? null;

    if (!user) {
      this.sessions.delete(token);
      await this.persist();
      return null;
    }

    return { user, session };
  }

  async revokeSession(token) {
    const removed = this.sessions.delete(token);

    if (removed) {
      await this.persist();
    }

    return { revoked: removed };
  }

  listUsers() {
    return [...this.users.values()];
  }

  getUser(userId) {
    return this.users.get(userId) ?? null;
  }

  async updateUserProfile(userId, { displayName, bio } = {}) {
    assertString(userId, "userId");

    const user = this.users.get(userId);

    if (!user) {
      throw new Error(`user not found: ${userId}`);
    }

    if (displayName !== undefined) {
      user.displayName = normalizeOptionalString(displayName);
    }

    if (bio !== undefined) {
      user.bio = normalizeOptionalString(bio);
    }

    user.updatedAt = this.now().toISOString();
    await this.persist();
    return user;
  }

  async findOrCreateUser({ walletAddress, displayName = null, walletType = "bitcoin" }) {
    const existingUserId = this.userIdsByWalletAddress.get(walletAddress);

    if (existingUserId) {
      const user = this.users.get(existingUserId);

      if (displayName && user.displayName !== displayName) {
        user.displayName = displayName;
        user.updatedAt = this.now().toISOString();
        await this.persist();
      }

      return user;
    }

    const nowIso = this.now().toISOString();
    const user = {
      id: crypto.randomUUID(),
      walletAddress,
      displayName: normalizeOptionalString(displayName),
      bio: null,
      walletType,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    this.users.set(user.id, user);
    this.userIdsByWalletAddress.set(walletAddress, user.id);
    await this.persist();
    return user;
  }

  async persist() {
    await writeFile(
      this.statePath,
      JSON.stringify(
        {
          users: this.listUsers(),
          challenges: [...this.challenges.values()],
          sessions: [...this.sessions.values()],
        },
        null,
        2,
      ),
    );
  }
}
