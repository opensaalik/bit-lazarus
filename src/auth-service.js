import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
}

function normalizeWalletAddress(walletAddress) {
  assertString(walletAddress, "walletAddress");
  return walletAddress.trim();
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

  async issueChallenge({ walletAddress }) {
    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
    const now = this.now();
    const challenge = {
      id: crypto.randomUUID(),
      walletAddress: normalizedWalletAddress,
      nonce: crypto.randomBytes(16).toString("hex"),
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

  async verifyChallenge({ challengeId, walletAddress, signature, displayName = null }) {
    assertString(challengeId, "challengeId");
    assertString(signature, "signature");

    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
    const challenge = this.challenges.get(challengeId);

    if (!challenge) {
      throw new Error("challenge not found");
    }

    if (challenge.walletAddress !== normalizedWalletAddress) {
      throw new Error("walletAddress does not match challenge");
    }

    if (new Date(challenge.expiresAt).getTime() < this.now().getTime()) {
      this.challenges.delete(challengeId);
      await this.persist();
      throw new Error("challenge expired");
    }

    const verification = await this.verifier.verifySignature({
      walletAddress: normalizedWalletAddress,
      message: challenge.message,
      signature,
    });

    if (!verification.valid) {
      throw new Error("invalid wallet signature");
    }

    const user = await this.findOrCreateUser({
      walletAddress: normalizedWalletAddress,
      displayName,
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

  async findOrCreateUser({ walletAddress, displayName = null }) {
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
      displayName,
      walletType: "bitcoin",
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

