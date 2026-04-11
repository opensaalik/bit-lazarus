import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { AuthService } from "./auth-service.js";
import { BountyService } from "./bounty-service.js";
import { EscrowService } from "./escrow-service.js";
import { createLightningClientFromEnv } from "./lightning-client.js";
import { createWalletAuthVerifierFromEnv } from "./wallet-auth-verifier.js";
import { WalletNode } from "./wallet-node.js";

function getBearerToken(request) {
  const authorization = request.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

function requireAuth(request, response, next) {
  if (!request.auth) {
    response.status(401).json({ error: "authentication required" });
    return;
  }

  next();
}

function canAccessEscrow(userId, escrow) {
  return [escrow.buyerId, escrow.sellerId, escrow.mediatorId].filter(Boolean).includes(userId);
}

export function createApp({ walletNode, escrowService, authService, bountyService }) {
  const app = express();

  app.use(express.json());
  app.use(async (request, _response, next) => {
    try {
      const token = getBearerToken(request);

      if (!token) {
        request.auth = null;
        next();
        return;
      }

      const auth = await authService.authenticateSession(token);
      request.auth = auth;
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get("/health", (_request, response) => {
    response.json({ ok: true, nodeId: walletNode.nodeId });
  });

  app.post("/auth/challenges", async (request, response) => {
    const challenge = await authService.issueChallenge({
      walletAddress: request.body?.walletAddress,
    });
    response.status(201).json({ challenge });
  });

  app.post("/auth/verify", async (request, response) => {
    const result = await authService.verifyChallenge(request.body ?? {});
    response.status(201).json(result);
  });

  app.post("/auth/logout", requireAuth, async (request, response) => {
    const result = await authService.revokeSession(request.auth.session.token);
    response.json(result);
  });

  app.get("/me", requireAuth, (request, response) => {
    response.json({ user: request.auth.user, session: request.auth.session });
  });

  app.get("/users/me", requireAuth, (request, response) => {
    response.json({ user: request.auth.user, session: request.auth.session });
  });

  app.patch("/users/me", requireAuth, async (request, response) => {
    const user = await authService.updateUserProfile(request.auth.user.id, request.body ?? {});
    response.json({ user });
  });

  app.get("/users/:userId", requireAuth, (request, response) => {
    const user = authService.getUser(request.params.userId);

    if (!user) {
      response.status(404).json({ error: "user not found" });
      return;
    }

    response.json({ user });
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

  app.get("/bounties", requireAuth, (request, response) => {
    const { created, hunting, status } = request.query;
    const bounties = bountyService.listBounties({
      creatorUserId: created === "me" ? request.auth.user.id : undefined,
      hunterUserId: hunting === "me" ? request.auth.user.id : undefined,
      status: typeof status === "string" ? status : undefined,
    });
    response.json({ bounties });
  });

  app.post("/bounties", requireAuth, async (request, response) => {
    const requestedBountyId = request.body?.bountyId;
    const bountyId =
      typeof requestedBountyId === "string" && requestedBountyId.trim()
        ? requestedBountyId.trim()
        : crypto.randomUUID();
    const escrow = await escrowService.createEscrow({
      escrowId: `escrow-${bountyId}`,
      buyerId: request.auth.user.id,
      sellerId: `bounty:${bountyId}`,
      amountSats: request.body?.rewardSats,
      description: request.body?.title ?? "Torrent bounty escrow",
      metadata: {
        kind: "bounty",
        bountyId,
        torrentInfoHash: request.body?.torrentInfoHash,
      },
    });
    const bounty = await bountyService.createBounty({
      ...(request.body ?? {}),
      bountyId,
      creatorUserId: request.auth.user.id,
      escrowId: escrow.id,
      escrowStatus: escrow.status,
      funding: escrow.funding,
    });
    response.status(201).json({ bounty });
  });

  app.get("/bounties/:bountyId", requireAuth, (request, response) => {
    const bounty = bountyService.getBounty(request.params.bountyId);

    if (!bounty) {
      response.status(404).json({ error: "bounty not found" });
      return;
    }

    response.json({ bounty });
  });

  app.post("/bounties/:bountyId/hunt", requireAuth, async (request, response) => {
    const bounty = await bountyService.joinBounty({
      bountyId: request.params.bountyId,
      userId: request.auth.user.id,
    });
    response.json({ bounty });
  });

  app.post("/bounties/:bountyId/sync-escrow", requireAuth, async (request, response) => {
    const existingBounty = bountyService.getBounty(request.params.bountyId);

    if (!existingBounty) {
      response.status(404).json({ error: "bounty not found" });
      return;
    }

    const escrow = await escrowService.syncEscrow(existingBounty.escrowId);
    const bounty = await bountyService.syncBountyEscrow({
      bountyId: existingBounty.id,
      escrowId: escrow.id,
      escrowStatus: escrow.status,
      funding: escrow.funding,
    });
    response.json({ bounty, escrow });
  });

  app.get("/escrows", requireAuth, (request, response) => {
    const escrows = escrowService
      .listEscrows()
      .filter((escrow) => canAccessEscrow(request.auth.user.id, escrow));
    response.json({ escrows });
  });

  app.post("/escrows", requireAuth, async (request, response) => {
    if (request.body?.buyerId && request.body.buyerId !== request.auth.user.id) {
      response.status(403).json({ error: "buyerId must match the authenticated user" });
      return;
    }

    const escrow = await escrowService.createEscrow({
      ...(request.body ?? {}),
      buyerId: request.auth.user.id,
    });
    response.status(201).json({ escrow });
  });

  app.get("/escrows/:escrowId", requireAuth, (request, response) => {
    const escrow = escrowService.getEscrow(request.params.escrowId);

    if (!escrow) {
      response.status(404).json({ error: "escrow not found" });
      return;
    }

    if (!canAccessEscrow(request.auth.user.id, escrow)) {
      response.status(403).json({ error: "escrow access denied" });
      return;
    }

    response.json({ escrow });
  });

  app.post("/escrows/:escrowId/sync", requireAuth, async (request, response) => {
    const existingEscrow = escrowService.getEscrow(request.params.escrowId);

    if (!existingEscrow) {
      response.status(404).json({ error: "escrow not found" });
      return;
    }

    if (!canAccessEscrow(request.auth.user.id, existingEscrow)) {
      response.status(403).json({ error: "escrow access denied" });
      return;
    }

    const escrow = await escrowService.syncEscrow(request.params.escrowId);
    response.json({ escrow });
  });

  app.post("/escrows/:escrowId/release", requireAuth, async (request, response) => {
    const existingEscrow = escrowService.getEscrow(request.params.escrowId);

    if (!existingEscrow) {
      response.status(404).json({ error: "escrow not found" });
      return;
    }

    if (!canAccessEscrow(request.auth.user.id, existingEscrow)) {
      response.status(403).json({ error: "escrow access denied" });
      return;
    }

    const escrow = await escrowService.releaseEscrow(request.params.escrowId);
    response.json({ escrow });
  });

  app.post("/escrows/:escrowId/cancel", requireAuth, async (request, response) => {
    const existingEscrow = escrowService.getEscrow(request.params.escrowId);

    if (!existingEscrow) {
      response.status(404).json({ error: "escrow not found" });
      return;
    }

    if (!canAccessEscrow(request.auth.user.id, existingEscrow)) {
      response.status(403).json({ error: "escrow access denied" });
      return;
    }

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
  const authVerifier = createWalletAuthVerifierFromEnv(process.env);
  const authService = new AuthService({
    dataDir: path.join(dataDir, "auth"),
    verifier: authVerifier,
  });
  await authService.init();
  const lightningClient = createLightningClientFromEnv(process.env);
  const bountyService = new BountyService({
    dataDir: path.join(dataDir, "bounties"),
  });
  await bountyService.init();
  const escrowService = new EscrowService({
    dataDir: path.join(dataDir, "escrow"),
    lightningClient,
  });
  await escrowService.init();

  const app = createApp({ walletNode, escrowService, authService, bountyService });

  const server = await new Promise((resolve) => {
    const instance = app.listen(port, host, () => resolve(instance));
  });

  return { app, server, walletNode, escrowService, authService, bountyService, port, host };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port, host } = await startServer();
  console.log(`Bit Lazarus node listening on http://${host}:${port}`);
}
