import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function normalizeUrl(rawUrl) {
  const normalized = new URL(rawUrl);
  normalized.pathname = "";
  normalized.search = "";
  normalized.hash = "";
  return normalized.toString().replace(/\/$/, "");
}

function assertNumber(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
}

export class WalletNode {
  constructor({
    nodeId = crypto.randomUUID(),
    dataDir = path.resolve("data"),
    now = () => new Date().toISOString(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.nodeId = nodeId;
    this.dataDir = dataDir;
    this.statePath = path.join(this.dataDir, "state.json");
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.wallets = new Map();
    this.events = [];
    this.eventIds = new Set();
    this.peers = new Set();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });

    try {
      const raw = await readFile(this.statePath, "utf8");
      const state = JSON.parse(raw);

      this.nodeId = state.nodeId ?? this.nodeId;
      this.wallets = new Map(Object.entries(state.wallets ?? {}));
      this.events = Array.isArray(state.events) ? state.events : [];
      this.eventIds = new Set(this.events.map((event) => event.id));
      this.peers = new Set(state.peers ?? []);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.persist();
    }
  }

  listWallets() {
    return [...this.wallets.values()];
  }

  getWallet(walletId) {
    return this.wallets.get(walletId) ?? null;
  }

  listTransactions() {
    return this.events.filter((event) => event.type === "TRANSFER");
  }

  listEvents() {
    return [...this.events];
  }

  listPeers() {
    return [...this.peers];
  }

  async addPeer(rawUrl) {
    const peerUrl = normalizeUrl(rawUrl);
    const previousSize = this.peers.size;

    this.peers.add(peerUrl);

    if (this.peers.size !== previousSize) {
      await this.persist();
    }

    return { url: peerUrl };
  }

  async createWallet({ owner, initialBalance = 0, walletId = crypto.randomUUID() }) {
    if (!owner || typeof owner !== "string") {
      throw new Error("owner is required");
    }

    assertNumber(initialBalance, "initialBalance");

    if (initialBalance < 0) {
      throw new Error("initialBalance must be non-negative");
    }

    const event = {
      id: crypto.randomUUID(),
      type: "WALLET_CREATED",
      nodeId: this.nodeId,
      timestamp: this.now(),
      payload: {
        walletId,
        owner,
        balance: initialBalance,
      },
    };

    await this.applyEvent(event);
    this.gossipEvent(event);

    return this.getWallet(walletId);
  }

  async createTransaction({ from, to, amount }) {
    if (!from || typeof from !== "string") {
      throw new Error("from is required");
    }

    if (!to || typeof to !== "string") {
      throw new Error("to is required");
    }

    if (from === to) {
      throw new Error("from and to must be different wallets");
    }

    assertNumber(amount, "amount");

    if (amount <= 0) {
      throw new Error("amount must be greater than zero");
    }

    const event = {
      id: crypto.randomUUID(),
      type: "TRANSFER",
      nodeId: this.nodeId,
      timestamp: this.now(),
      payload: {
        from,
        to,
        amount,
      },
    };

    await this.applyEvent(event);
    this.gossipEvent(event);

    return event;
  }

  async receiveEvent(event) {
    const wasApplied = await this.applyEvent(event);
    return { applied: wasApplied };
  }

  async syncFromPeer(rawUrl) {
    const peerUrl = normalizeUrl(rawUrl);
    const response = await this.fetchImpl(`${peerUrl}/events`);

    if (!response.ok) {
      throw new Error(`failed to sync peer ${peerUrl}: ${response.status}`);
    }

    const body = await response.json();

    for (const event of body.events ?? []) {
      await this.applyEvent(event);
    }

    return {
      peer: peerUrl,
      eventCount: Array.isArray(body.events) ? body.events.length : 0,
    };
  }

  async applyEvent(event) {
    this.validateEventShape(event);

    if (this.eventIds.has(event.id)) {
      return false;
    }

    if (event.type === "WALLET_CREATED") {
      this.applyWalletCreated(event);
    } else if (event.type === "TRANSFER") {
      this.applyTransfer(event);
    } else {
      throw new Error(`unsupported event type: ${event.type}`);
    }

    this.events.push(event);
    this.eventIds.add(event.id);
    await this.persist();
    return true;
  }

  applyWalletCreated(event) {
    const { walletId, owner, balance } = event.payload;

    if (this.wallets.has(walletId)) {
      throw new Error(`wallet already exists: ${walletId}`);
    }

    this.wallets.set(walletId, {
      id: walletId,
      owner,
      balance,
      createdAt: event.timestamp,
    });
  }

  applyTransfer(event) {
    const { from, to, amount } = event.payload;
    const sender = this.wallets.get(from);
    const recipient = this.wallets.get(to);

    if (!sender) {
      throw new Error(`unknown sender wallet: ${from}`);
    }

    if (!recipient) {
      throw new Error(`unknown recipient wallet: ${to}`);
    }

    if (sender.balance < amount) {
      throw new Error(`insufficient balance in wallet: ${from}`);
    }

    sender.balance -= amount;
    recipient.balance += amount;
  }

  validateEventShape(event) {
    if (!event || typeof event !== "object") {
      throw new Error("event must be an object");
    }

    if (!event.id || typeof event.id !== "string") {
      throw new Error("event.id is required");
    }

    if (!event.type || typeof event.type !== "string") {
      throw new Error("event.type is required");
    }

    if (!event.timestamp || typeof event.timestamp !== "string") {
      throw new Error("event.timestamp is required");
    }

    if (!event.payload || typeof event.payload !== "object") {
      throw new Error("event.payload is required");
    }

    if (event.type === "WALLET_CREATED") {
      const { walletId, owner, balance } = event.payload;

      if (!walletId || typeof walletId !== "string") {
        throw new Error("walletId is required");
      }

      if (!owner || typeof owner !== "string") {
        throw new Error("owner is required");
      }

      assertNumber(balance, "balance");

      if (balance < 0) {
        throw new Error("balance must be non-negative");
      }
    }

    if (event.type === "TRANSFER") {
      const { from, to, amount } = event.payload;

      if (!from || typeof from !== "string") {
        throw new Error("from is required");
      }

      if (!to || typeof to !== "string") {
        throw new Error("to is required");
      }

      assertNumber(amount, "amount");

      if (amount <= 0) {
        throw new Error("amount must be greater than zero");
      }
    }
  }

  async persist() {
    const state = {
      nodeId: this.nodeId,
      wallets: Object.fromEntries(this.wallets),
      events: this.events,
      peers: [...this.peers],
    };

    await writeFile(this.statePath, JSON.stringify(state, null, 2));
  }

  async gossipEvent(event) {
    const peers = this.listPeers();

    await Promise.allSettled(
      peers.map(async (peerUrl) => {
        try {
          const response = await this.fetchImpl(`${peerUrl}/events`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ event }),
          });

          if (!response.ok) {
            throw new Error(`peer responded ${response.status}`);
          }
        } catch (error) {
          // Gossip is best-effort so one bad peer does not block the local node.
          console.warn(`failed to gossip event ${event.id} to ${peerUrl}: ${error.message}`);
        }
      }),
    );
  }
}

