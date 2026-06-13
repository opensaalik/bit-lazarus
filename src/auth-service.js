import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getAddress } from "viem";
import { normalize } from "viem/ens";

const DEFAULT_ENS_PARENT_NAME = "bitlazarus.eth";
const WORD_CONSONANTS = "bcdfghjklmnpqrstvwxyz";
const WORD_VOWELS = "aeiou";

function assertString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }
}

function normalizeWalletAddress(walletAddress) {
  assertString(walletAddress, "walletAddress");
  return getAddress(walletAddress.trim());
}

function normalizeEnsParentName(parentName) {
  assertString(parentName, "ENS_PARENT_NAME");
  return normalize(parentName.trim());
}

function normalizeEnsLabel(label) {
  assertString(label, "ensLabel");
  const normalized = label.trim().toLowerCase();

  if (!/^[a-z]{6}$/.test(normalized)) {
    throw new Error("ensLabel must be a six-letter lowercase word");
  }

  return normalized;
}

function createRandomWordLabel() {
  const bytes = crypto.randomBytes(6);
  let label = "";

  for (let index = 0; index < bytes.length; index += 1) {
    const alphabet = index % 2 === 0 ? WORD_CONSONANTS : WORD_VOWELS;
    label += alphabet[bytes[index] % alphabet.length];
  }

  return label;
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
    ensParentName = DEFAULT_ENS_PARENT_NAME,
    ensLabelGenerator = createRandomWordLabel,
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
    this.ensParentName = normalizeEnsParentName(ensParentName);
    this.ensLabelGenerator = ensLabelGenerator;
    this.users = new Map();
    this.userIdsByWalletAddress = new Map();
    this.userIdsByEnsLabel = new Map();
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
      let changed = false;
      this.userIdsByEnsLabel = new Map();
      for (const user of this.users.values()) {
        changed = this.ensureUserEnsName(user) || changed;
      }
      this.challenges = new Map((state.challenges ?? []).map((challenge) => [challenge.id, challenge]));
      this.sessions = new Map((state.sessions ?? []).map((session) => [session.token, session]));
      if (changed) {
        await this.persist();
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.persist();
    }
  }

  async issueChallenge({ walletAddress } = {}) {
    const now = this.now();
    const id = crypto.randomUUID();
    const nonceBytes = crypto.randomBytes(16).toString("hex");

    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
    const challenge = {
      id,
      kind: "ethereum",
      walletAddress: normalizedWalletAddress,
      nonce: nonceBytes,
      message: [
        "Bit Lazarus Ethereum wallet login",
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

    const challenge = this.challenges.get(challengeId);

    if (!challenge) {
      throw new Error("challenge not found");
    }

    if (new Date(challenge.expiresAt).getTime() < this.now().getTime()) {
      this.challenges.delete(challengeId);
      await this.persist();
      throw new Error("challenge expired");
    }

    assertString(signature, "signature");
    assertString(walletAddress, "walletAddress");
    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);

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
    const user = await this.findOrCreateUser({
      walletAddress: normalizedWalletAddress,
      displayName,
      walletType: verification.walletType ?? "ethereum",
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

  getUserByEnsLabel(label) {
    const normalizedLabel = normalizeEnsLabel(label);
    const userId = this.userIdsByEnsLabel.get(normalizedLabel);
    return userId ? this.getUser(userId) : null;
  }

  getUserByEnsName(ensName) {
    assertString(ensName, "ensName");
    const normalizedName = normalize(ensName.trim());
    const suffix = `.${this.ensParentName}`;

    if (!normalizedName.endsWith(suffix)) {
      return null;
    }

    return this.getUserByEnsLabel(normalizedName.slice(0, -suffix.length));
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

  async findOrCreateUser({ walletAddress, displayName = null, walletType = "ethereum" }) {
    const existingUserId = this.userIdsByWalletAddress.get(walletAddress);

    if (existingUserId) {
      const user = this.users.get(existingUserId);
      const hadEnsName = this.ensureUserEnsName(user);

      if (displayName && user.displayName !== displayName) {
        user.displayName = displayName;
        user.updatedAt = this.now().toISOString();
        await this.persist();
        return user;
      }

      if (hadEnsName) {
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
      ensLabel: null,
      ensName: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.ensureUserEnsName(user);

    this.users.set(user.id, user);
    this.userIdsByWalletAddress.set(walletAddress, user.id);
    await this.persist();
    return user;
  }

  ensureUserEnsName(user) {
    if (user.ensLabel && user.ensName) {
      const label = normalizeEnsLabel(user.ensLabel);
      const ensName = normalize(`${label}.${this.ensParentName}`);
      const changed = user.ensLabel !== label || user.ensName !== ensName;
      user.ensLabel = label;
      user.ensName = ensName;
      this.userIdsByEnsLabel.set(label, user.id);
      return changed;
    }

    const label = this.createUniqueEnsLabel();
    user.ensLabel = label;
    user.ensName = normalize(`${label}.${this.ensParentName}`);
    user.updatedAt = this.now().toISOString();
    this.userIdsByEnsLabel.set(label, user.id);
    return true;
  }

  createUniqueEnsLabel() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const label = normalizeEnsLabel(this.ensLabelGenerator());

      if (!this.userIdsByEnsLabel.has(label)) {
        return label;
      }
    }

    throw new Error("unable to allocate wallet ENS label");
  }

  async persist() {
    await mkdir(this.dataDir, { recursive: true });
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
