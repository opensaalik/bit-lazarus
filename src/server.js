import express from "express";
import path from "node:path";
import { EscrowService } from "./escrow-service.js";
import { createLightningClientFromEnv } from "./lightning-client.js";
import { WalletNode } from "./wallet-node.js";

export function createApp({ walletNode, escrowService }) {
  const app = express();

  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.json({ ok: true, nodeId: walletNode.nodeId });
  });

  app.get("/wallets", (_request, response) => {
    response.json({ wallets: walletNode.listWallets() });
  });

  app.post("/wallets", async (request, response) => {
    const wallet = await walletNode.createWallet(request.body ?? {});
    response.status(201).json({ wallet });
  });

  app.get("/wallets/:walletId", (request, response) => {
    const wallet = walletNode.getWallet(request.params.walletId);

    if (!wallet) {
      response.status(404).json({ error: "wallet not found" });
      return;
    }

    response.json({ wallet });
  });

  app.get("/transactions", (_request, response) => {
    response.json({ transactions: walletNode.listTransactions() });
  });

  app.post("/transactions", async (request, response) => {
    const transaction = await walletNode.createTransaction(request.body ?? {});
    response.status(201).json({ transaction });
  });

  app.get("/peers", (_request, response) => {
    response.json({ peers: walletNode.listPeers() });
  });

  app.post("/peers", async (request, response) => {
    const peer = await walletNode.addPeer(request.body?.url);
    const sync = await walletNode.syncFromPeer(request.body?.url);
    response.status(201).json({ peer, sync });
  });

  app.get("/events", (_request, response) => {
    response.json({ events: walletNode.listEvents() });
  });

  app.post("/events", async (request, response) => {
    const result = await walletNode.receiveEvent(request.body?.event);
    response.status(202).json(result);
  });

  app.get("/escrows", (_request, response) => {
    response.json({ escrows: escrowService.listEscrows() });
  });

  app.post("/escrows", async (request, response) => {
    const escrow = await escrowService.createEscrow(request.body ?? {});
    response.status(201).json({ escrow });
  });

  app.get("/escrows/:escrowId", (request, response) => {
    const escrow = escrowService.getEscrow(request.params.escrowId);

    if (!escrow) {
      response.status(404).json({ error: "escrow not found" });
      return;
    }

    response.json({ escrow });
  });

  app.post("/escrows/:escrowId/sync", async (request, response) => {
    const escrow = await escrowService.syncEscrow(request.params.escrowId);
    response.json({ escrow });
  });

  app.post("/escrows/:escrowId/release", async (request, response) => {
    const escrow = await escrowService.releaseEscrow(request.params.escrowId);
    response.json({ escrow });
  });

  app.post("/escrows/:escrowId/cancel", async (request, response) => {
    const escrow = await escrowService.cancelEscrow(request.params.escrowId);
    response.json({ escrow });
  });

  app.use((request, response) => {
    response.status(404).json({ error: "not found" });
  });

  app.use((error, _request, response, _next) => {
    response.status(400).json({ error: error.message });
  });

  return app;
}

export async function startServer({
  port = Number.parseInt(process.env.PORT ?? "3000", 10),
  host = process.env.HOST ?? "127.0.0.1",
  dataDir = process.env.DATA_DIR ?? path.resolve("data"),
} = {}) {
  const walletNode = new WalletNode({ dataDir: path.join(dataDir, "wallet-node") });
  await walletNode.init();
  const lightningClient = createLightningClientFromEnv(process.env);
  const escrowService = new EscrowService({
    dataDir: path.join(dataDir, "escrow"),
    lightningClient,
  });
  await escrowService.init();

  const app = createApp({ walletNode, escrowService });

  const server = await new Promise((resolve) => {
    const instance = app.listen(port, host, () => resolve(instance));
  });

  return { app, server, walletNode, escrowService, port, host };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port, host } = await startServer();
  console.log(`Bit Lazarus node listening on http://${host}:${port}`);
}
