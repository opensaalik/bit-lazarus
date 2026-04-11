import http from "node:http";
import path from "node:path";
import { WalletNode } from "./wallet-node.js";

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("invalid JSON request body"));
      }
    });
    request.on("error", reject);
  });
}

export function createServer({ walletNode }) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, nodeId: walletNode.nodeId });
        return;
      }

      if (request.method === "GET" && url.pathname === "/wallets") {
        json(response, 200, { wallets: walletNode.listWallets() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/wallets") {
        const body = await readJson(request);
        const wallet = await walletNode.createWallet(body);
        json(response, 201, { wallet });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/wallets/")) {
        const walletId = url.pathname.split("/")[2];
        const wallet = walletNode.getWallet(walletId);

        if (!wallet) {
          json(response, 404, { error: "wallet not found" });
          return;
        }

        json(response, 200, { wallet });
        return;
      }

      if (request.method === "GET" && url.pathname === "/transactions") {
        json(response, 200, { transactions: walletNode.listTransactions() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/transactions") {
        const body = await readJson(request);
        const transaction = await walletNode.createTransaction(body);
        json(response, 201, { transaction });
        return;
      }

      if (request.method === "GET" && url.pathname === "/peers") {
        json(response, 200, { peers: walletNode.listPeers() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/peers") {
        const body = await readJson(request);
        const peer = await walletNode.addPeer(body.url);
        const sync = await walletNode.syncFromPeer(body.url);
        json(response, 201, { peer, sync });
        return;
      }

      if (request.method === "GET" && url.pathname === "/events") {
        json(response, 200, { events: walletNode.listEvents() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/events") {
        const body = await readJson(request);
        const result = await walletNode.receiveEvent(body.event);
        json(response, 202, result);
        return;
      }

      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
  });
}

export async function startServer({
  port = Number.parseInt(process.env.PORT ?? "3000", 10),
  host = process.env.HOST ?? "127.0.0.1",
  dataDir = process.env.DATA_DIR ?? path.resolve("data"),
} = {}) {
  const walletNode = new WalletNode({ dataDir });
  await walletNode.init();

  const server = createServer({ walletNode });

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });

  return { server, walletNode, port, host };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port, host } = await startServer();
  console.log(`Bit Lazarus node listening on http://${host}:${port}`);
}
