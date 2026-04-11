import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { WalletNode } from "../src/wallet-node.js";

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bit-lazarus-"));

  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function waitFor(assertion, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw lastError;
}

test("wallet node creates wallets and applies transfers", async () => {
  await withTempDir(async (tempDir) => {
    const node = new WalletNode({ dataDir: tempDir });
    await node.init();

    await node.createWallet({ walletId: "alice", owner: "Alice", initialBalance: 75 });
    await node.createWallet({ walletId: "bob", owner: "Bob", initialBalance: 20 });
    await node.createTransaction({ from: "alice", to: "bob", amount: 15 });

    assert.deepEqual(node.getWallet("alice"), {
      id: "alice",
      owner: "Alice",
      balance: 60,
      createdAt: node.getWallet("alice").createdAt,
    });
    assert.equal(node.getWallet("bob").balance, 35);
    assert.equal(node.listTransactions().length, 1);
  });
});

test("peer nodes synchronize events and balances", async () => {
  await withTempDir(async (tempDir) => {
    const firstDataDir = path.join(tempDir, "node-a");
    const secondDataDir = path.join(tempDir, "node-b");
    const peerRegistry = new Map();

    const makeFetch = () => async (url, options = {}) => {
      const targetUrl = new URL(url);
      const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
      const targetNode = peerRegistry.get(baseUrl);

      if (!targetNode) {
        return {
          ok: false,
          status: 404,
          async json() {
            return {};
          },
        };
      }

      if (targetUrl.pathname === "/events" && (!options.method || options.method === "GET")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { events: targetNode.listEvents() };
          },
        };
      }

      if (targetUrl.pathname === "/events" && options.method === "POST") {
        const body = JSON.parse(options.body);
        const result = await targetNode.receiveEvent(body.event);
        return {
          ok: true,
          status: 202,
          async json() {
            return result;
          },
        };
      }

      return {
        ok: false,
        status: 400,
        async json() {
          return {};
        },
      };
    };

    const first = new WalletNode({ dataDir: firstDataDir, fetchImpl: makeFetch() });
    const second = new WalletNode({ dataDir: secondDataDir, fetchImpl: makeFetch() });
    await first.init();
    await second.init();

    const firstBaseUrl = "http://node-a.local";
    const secondBaseUrl = "http://node-b.local";
    peerRegistry.set(firstBaseUrl, first);
    peerRegistry.set(secondBaseUrl, second);

    await second.addPeer(firstBaseUrl);
    await second.syncFromPeer(firstBaseUrl);
    await first.addPeer(secondBaseUrl);
    await first.syncFromPeer(secondBaseUrl);

    await first.createWallet({ walletId: "alice", owner: "Alice", initialBalance: 50 });
    await first.createWallet({ walletId: "bob", owner: "Bob", initialBalance: 10 });
    await first.createTransaction({ from: "alice", to: "bob", amount: 20 });

    await waitFor(async () => {
      assert.equal(second.getWallet("alice").balance, 30);
    });

    assert.equal(second.getWallet("bob").balance, 30);
  });
});
