import express from "express";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { AuthService } from "./auth-service.js";
import { startBountyEscrowSync } from "./bounty-escrow-sync.js";
import { BountyService } from "./bounty-service.js";
import { EscrowService } from "./escrow-service.js";
import { createLightningClientFromEnv } from "./lightning-client.js";
import { createPolarDemoAuthServiceFromEnv } from "./polar-demo-auth-service.js";
import { createPolarDemoServiceFromEnv } from "./polar-demo-service.js";
import { ProtocolService } from "./protocol-service.js";
import { createResourceLocatorServiceFromEnv } from "./resource-locator-service.js";
import { createWalletAuthVerifierFromEnv } from "./wallet-auth-verifier.js";
import { createWebTorrentTrackerServiceFromEnv } from "./webtorrent-tracker-service.js";

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

function canAccessBounty(userId, bounty) {
  return bounty.creatorUserId === userId || bounty.hunters.some((hunter) => hunter.userId === userId);
}

function canAccessDeliveryContract(userId, contract) {
  return [contract.payerUserId, contract.hunterUserId].includes(userId);
}

export function createApp({
  escrowService,
  authService,
  bountyService,
  protocolService,
  resourceLocatorService = null,
  polarDemoService = null,
  polarDemoAuthService = null,
  webTorrentTrackerService = null,
}) {
  const app = express();
  const frontendDistPath = path.resolve("dist");

  app.use(express.json({ limit: "10mb" }));
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
    response.json({
      ok: true,
      demoCapabilities: polarDemoService?.getCapabilities?.() ?? {
        backendPayments: false,
        backendPayoutInvoices: false,
      },
      auth: polarDemoAuthService?.getCapabilities?.() ?? {
        backendDemoAuth: false,
      },
      webTorrent: webTorrentTrackerService?.getPublicConfig?.() ?? {
        enabled: false,
        announceUrls: [],
      },
    });
  });

  app.get("/ens/ccip/:sender/:data", (request, response) => {
    if (!resourceLocatorService) {
      response.status(503).json({ error: "resource locator service is not configured" });
      return;
    }

    response.json(resourceLocatorService.answerCcipRead({
      sender: request.params.sender,
      data: request.params.data,
    }));
  });

  app.post("/ens/ccip", (request, response) => {
    if (!resourceLocatorService) {
      response.status(503).json({ error: "resource locator service is not configured" });
      return;
    }

    response.json(resourceLocatorService.answerCcipRead({
      sender: request.body?.sender,
      data: request.body?.data,
    }));
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

  app.post("/auth/demo-login", async (request, response) => {
    if (!polarDemoAuthService?.getCapabilities()?.backendDemoAuth) {
      response.status(503).json({ error: "Polar demo auth is not configured on this server" });
      return;
    }

    const result = await polarDemoAuthService.createDemoSession({
      role: request.body?.role,
      displayName: request.body?.displayName ?? null,
    });
    response.status(201).json(result);
  });

  app.post("/auth/logout", requireAuth, async (request, response) => {
    const result = await authService.revokeSession(request.auth.session.token);
    response.json(result);
  });

  app.get("/users/me", requireAuth, (request, response) => {
    response.json({ user: request.auth.user, session: request.auth.session });
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
    const body = request.body ?? {};
    const requestedBountyId = body.bountyId;
    const bountyId =
      typeof requestedBountyId === "string" && requestedBountyId.trim()
        ? requestedBountyId.trim()
        : crypto.randomUUID();
    const existingResource = resourceLocatorService
      ? resourceLocatorService.getResource(body.torrentInfoHash)
      : null;

    if (existingResource?.locatorStatus === "ARCHIVED") {
      response.status(200).json({
        archiveHit: true,
        resource: existingResource,
        resolution: resourceLocatorService.resolveResource(body.torrentInfoHash),
      });
      return;
    }

    const resourceResult = resourceLocatorService
      ? await resourceLocatorService.ensureResourceForBounty({
        torrentInfoHash: body.torrentInfoHash,
        bountyId,
        title: body.title,
        description: body.description,
        rewardSats: body.rewardSats,
      })
      : null;

    const escrow = await escrowService.createEscrow({
      escrowId: `escrow-${bountyId}`,
      buyerId: request.auth.user.id,
      sellerId: `bounty:${bountyId}`,
      amountSats: body.rewardSats,
      description: body.title ?? "Torrent bounty escrow",
      metadata: {
        kind: "bounty",
        bountyId,
        torrentInfoHash: body.torrentInfoHash,
      },
    });
    const bounty = await bountyService.createBounty({
      ...body,
      bountyId,
      creatorUserId: request.auth.user.id,
      escrowId: escrow.id,
      escrowStatus: escrow.status,
      funding: escrow.funding,
      resourceLocator: resourceResult?.resource ?? null,
    });
    response.status(201).json({ bounty });
  });

  app.get("/resources/:torrentInfoHash", requireAuth, (request, response) => {
    if (!resourceLocatorService) {
      response.status(503).json({ error: "resource locator service is not configured" });
      return;
    }

    const resource = resourceLocatorService.getResource(request.params.torrentInfoHash);
    if (!resource) {
      response.status(404).json({ error: "resource not found" });
      return;
    }

    response.json({ resource });
  });

  app.get("/resources/:torrentInfoHash/resolve", requireAuth, (request, response) => {
    if (!resourceLocatorService) {
      response.status(503).json({ error: "resource locator service is not configured" });
      return;
    }

    response.json({ resolution: resourceLocatorService.resolveResource(request.params.torrentInfoHash) });
  });

  app.post("/resources/:torrentInfoHash/archive", requireAuth, async (request, response) => {
    if (!resourceLocatorService) {
      response.status(503).json({ error: "resource locator service is not configured" });
      return;
    }

    const contract = protocolService.getDeliveryContract(request.body?.contractId);
    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (!canAccessDeliveryContract(request.auth.user.id, contract)) {
      response.status(403).json({ error: "delivery contract access denied" });
      return;
    }

    if (contract.state !== "RESOLVED_SUCCESS") {
      response.status(409).json({ error: "only successfully resolved contracts can be archived" });
      return;
    }

    const bounty = bountyService.getBounty(contract.bountyId);
    if (!bounty || bounty.torrentInfoHash !== request.params.torrentInfoHash.trim().toLowerCase()) {
      response.status(409).json({ error: "contract does not match requested torrent resource" });
      return;
    }

    const resource = await resourceLocatorService.archiveResource({
      torrentInfoHash: bounty.torrentInfoHash,
      contractId: contract.id,
      walrusBlobId: request.body?.walrusBlobId,
      walrusObjectId: request.body?.walrusObjectId,
    });
    response.status(201).json({
      resource,
      resolution: resourceLocatorService.resolveResource(bounty.torrentInfoHash),
    });
  });

  app.get("/bounties/:bountyId/torrent", requireAuth, async (request, response) => {
    const bounty = bountyService.getBounty(request.params.bountyId);
    if (!bounty) {
      response.status(404).json({ error: "bounty not found" });
      return;
    }
    const fileBuffer = await bountyService.getTorrentFile(bounty.torrentInfoHash);
    if (!fileBuffer) {
      response.status(404).json({ error: "torrent file not available for this bounty" });
      return;
    }
    response.set("Content-Type", "application/x-bittorrent");
    response.set("Content-Disposition", `attachment; filename="${bounty.torrentInfoHash}.torrent"`);
    response.send(fileBuffer);
  });

  app.get("/bounties/:bountyId", requireAuth, (request, response) => {
    const bounty = bountyService.getBounty(request.params.bountyId);

    if (!bounty) {
      response.status(404).json({ error: "bounty not found" });
      return;
    }

    response.json({ bounty });
  });

  app.get("/bounties/:bountyId/contracts", requireAuth, (request, response) => {
    const bounty = bountyService.getBounty(request.params.bountyId);

    if (!bounty) {
      response.status(404).json({ error: "bounty not found" });
      return;
    }

    if (!canAccessBounty(request.auth.user.id, bounty)) {
      response.status(403).json({ error: "bounty access denied" });
      return;
    }

    const contracts = protocolService.listDeliveryContracts({ bountyId: bounty.id });
    response.json({ contracts });
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

  app.post("/bounties/:bountyId/demo-fund", requireAuth, async (request, response) => {
    if (!polarDemoService?.getCapabilities()?.backendPayments) {
      response.status(503).json({ error: "Polar demo funding is not configured on this server" });
      return;
    }

    const existingBounty = bountyService.getBounty(request.params.bountyId);

    if (!existingBounty) {
      response.status(404).json({ error: "bounty not found" });
      return;
    }

    if (existingBounty.creatorUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the requester can fund this bounty" });
      return;
    }

    if (!existingBounty.funding?.paymentRequest) {
      response.status(409).json({ error: "this bounty has no funding invoice" });
      return;
    }

    const payment = await polarDemoService.fundRequesterInvoice(existingBounty.funding.paymentRequest);
    const escrow = await escrowService.syncEscrow(existingBounty.escrowId);
    const bounty = await bountyService.syncBountyEscrow({
      bountyId: existingBounty.id,
      escrowId: escrow.id,
      escrowStatus: escrow.status,
      funding: escrow.funding,
    });
    response.json({ bounty, escrow, payment });
  });

  app.post("/bounties/:bountyId/contracts", requireAuth, async (request, response) => {
    const bounty = bountyService.getBounty(request.params.bountyId);

    if (!bounty) {
      response.status(404).json({ error: "bounty not found" });
      return;
    }

    if (bounty.creatorUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the requester can create delivery contracts" });
      return;
    }

    if (bounty.status !== "OPEN") {
      response.status(409).json({ error: "bounty must be OPEN before a delivery contract can be created" });
      return;
    }

    const hunterUserId = typeof request.body?.hunterUserId === "string" ? request.body.hunterUserId.trim() : "";
    const hunter = bounty.hunters.find((candidate) => candidate.userId === hunterUserId);

    if (!hunter) {
      response.status(400).json({ error: "hunterUserId must match a joined hunter on this bounty" });
      return;
    }

    const existingActiveContract = protocolService
      .listDeliveryContracts({ bountyId: bounty.id })
      .find((contract) => !String(contract.state ?? "").startsWith("RESOLVED_") && contract.state !== "EXPIRED");

    if (existingActiveContract) {
      response.status(409).json({ error: "this bounty already has an active delivery contract" });
      return;
    }

    const payer = authService.getUser(bounty.creatorUserId);
    const hunterUser = authService.getUser(hunter.userId);
    const contract = await protocolService.createDeliveryContract({
      bountyId: bounty.id,
      payerUserId: bounty.creatorUserId,
      hunterUserId: hunter.userId,
      payerWalletAddress: payer.walletAddress,
      hunterWalletAddress: hunterUser.walletAddress,
      rewardEscrowId: bounty.escrowId,
    });

    const bondResult = await protocolService.createBondEscrows({
      contractId: contract.id,
      bondAmountSats: bounty.bondAmountSats,
    });

    await bountyService.registerDeliveryContract({
      bountyId: bounty.id,
      contractId: contract.id,
    });
    await bountyService.updateProtocolState({
      bountyId: bounty.id,
      deliveryStatus: bondResult.contract.state,
      completionReadiness: bondResult.contract.resolutionReadiness,
    });

    response.status(201).json({
      contract: bondResult.contract,
      payerBondEscrow: bondResult.payerBondEscrow,
      hunterBondEscrow: bondResult.hunterBondEscrow,
    });
  });

  app.get("/contracts/:contractId", requireAuth, (request, response) => {
    const contract = protocolService.getDeliveryContract(request.params.contractId);

    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (!canAccessDeliveryContract(request.auth.user.id, contract)) {
      response.status(403).json({ error: "delivery contract access denied" });
      return;
    }

    response.json({ contract });
  });

  app.post("/contracts/:contractId/demo-payout-invoice", requireAuth, async (request, response) => {
    if (!polarDemoService?.getCapabilities()?.backendPayoutInvoices) {
      response.status(503).json({ error: "Polar demo payout invoices are not configured on this server" });
      return;
    }

    const contract = protocolService.getDeliveryContract(request.params.contractId);

    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (contract.hunterUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the hunter can register a payout invoice for this contract" });
      return;
    }

    const bounty = bountyService.getBounty(contract.bountyId);
    const invoice = await polarDemoService.createHunterPayoutInvoice({
      amountSats: bounty.rewardSats,
      memo: `Bit Lazarus hunter payout for ${contract.id}`,
    });
    const updatedContract = await protocolService.registerContractPayoutInvoice({
      contractId: contract.id,
      userId: request.auth.user.id,
      paymentRequest: invoice.paymentRequest,
    });

    await bountyService.updateProtocolState({
      bountyId: updatedContract.bountyId,
      deliveryStatus: updatedContract.state,
      completionReadiness: updatedContract.resolutionReadiness,
    });

    response.json({ contract: updatedContract, invoice });
  });

  app.post("/contracts/:contractId/sync-bonds", requireAuth, async (request, response) => {
    const contract = protocolService.getDeliveryContract(request.params.contractId);
    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }
    if (!canAccessDeliveryContract(request.auth.user.id, contract)) {
      response.status(403).json({ error: "delivery contract access denied" });
      return;
    }
    const updatedContract = await protocolService.syncBondStatus({ contractId: contract.id });
    await bountyService.updateProtocolState({
      bountyId: updatedContract.bountyId,
      deliveryStatus: updatedContract.state,
    });
    response.json({ contract: updatedContract });
  });

  app.post("/contracts/:contractId/demo-pay-bond", requireAuth, async (request, response) => {
    if (!polarDemoService?.getCapabilities()?.backendPayments) {
      response.status(503).json({ error: "Polar demo bond payments are not configured on this server" });
      return;
    }

    const contract = protocolService.getDeliveryContract(request.params.contractId);
    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }
    if (!canAccessDeliveryContract(request.auth.user.id, contract)) {
      response.status(403).json({ error: "delivery contract access denied" });
      return;
    }

    const isPayer = contract.payerUserId === request.auth.user.id;
    const bondEscrowId = isPayer ? contract.payerBondEscrowId : contract.hunterBondEscrowId;

    if (!bondEscrowId) {
      response.status(409).json({ error: "your bond escrow is not available" });
      return;
    }

    const bondEscrow = escrowService.getEscrow(bondEscrowId);

    if (!bondEscrow?.funding?.paymentRequest) {
      response.status(409).json({ error: "your bond invoice is not available" });
      return;
    }

    const payment = await polarDemoService.payBondInvoice({
      role: isPayer ? "payer" : "hunter",
      paymentRequest: bondEscrow.funding.paymentRequest,
    });
    const updatedContract = await protocolService.syncBondStatus({ contractId: contract.id });
    await bountyService.updateProtocolState({
      bountyId: updatedContract.bountyId,
      deliveryStatus: updatedContract.state,
    });
    response.json({ contract: updatedContract, payment });
  });

  app.post("/contracts/:contractId/delivery-commitment", requireAuth, async (request, response) => {
    const contract = protocolService.getDeliveryContract(request.params.contractId);

    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (contract.hunterUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the hunter can commit the seeded file hash" });
      return;
    }

    const updatedContract = await protocolService.registerHunterDeliveryFile({
      contractId: contract.id,
      hunterUserId: request.auth.user.id,
      fileSha256: request.body?.fileSha256,
      fileName: request.body?.fileName,
      fileSize: request.body?.fileSize,
    });
    const bounty = bountyService.getBounty(updatedContract.bountyId);
    if (resourceLocatorService && bounty) {
      await resourceLocatorService.markSeeding({
        torrentInfoHash: bounty.torrentInfoHash,
        contractId: updatedContract.id,
      });
    }

    await bountyService.updateProtocolState({
      bountyId: updatedContract.bountyId,
      deliveryStatus: updatedContract.state,
      completionReadiness: updatedContract.resolutionReadiness,
    });

    response.status(201).json({ contract: updatedContract });
  });

  app.post("/contracts/:contractId/delivery-confirmation", requireAuth, async (request, response) => {
    const contract = protocolService.getDeliveryContract(request.params.contractId);

    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (contract.payerUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the requester can confirm the delivered file hash" });
      return;
    }

    const updatedContract = await protocolService.confirmRequesterDeliveryFile({
      contractId: contract.id,
      payerUserId: request.auth.user.id,
      fileSha256: request.body?.fileSha256,
    });

    await bountyService.updateProtocolState({
      bountyId: updatedContract.bountyId,
      deliveryStatus: updatedContract.state,
      completionReadiness: updatedContract.resolutionReadiness,
    });

    response.status(201).json({ contract: updatedContract });
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

  if (existsSync(frontendDistPath)) {
    app.use("/app", express.static(frontendDistPath));
    app.get(/^\/app(?:\/.*)?$/, (_request, response) => {
      response.sendFile(path.join(frontendDistPath, "index.html"));
    });
  }

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
  bountyEscrowSyncIntervalMs = Number.parseInt(process.env.BOUNTY_ESCROW_SYNC_INTERVAL_MS ?? "30000", 10),
} = {}) {
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
  const protocolService = new ProtocolService({
    dataDir: path.join(dataDir, "protocol"),
    escrowService,
  });
  await protocolService.init();
  const resourceLocatorService = createResourceLocatorServiceFromEnv(process.env, {
    dataDir: path.join(dataDir, "resources"),
  });
  await resourceLocatorService.init();
  const polarDemoService = createPolarDemoServiceFromEnv(process.env);
  const polarDemoAuthService = createPolarDemoAuthServiceFromEnv({
    authService,
    environment: process.env,
  });
  const webTorrentTrackerService = createWebTorrentTrackerServiceFromEnv(process.env);

  if (webTorrentTrackerService) {
    await webTorrentTrackerService.start();
  }

  const app = createApp({
    escrowService,
    authService,
    bountyService,
    protocolService,
    resourceLocatorService,
    polarDemoService,
    polarDemoAuthService,
    webTorrentTrackerService,
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(port, host, () => resolve(instance));
  });

  const bountyEscrowSync = startBountyEscrowSync({
    bountyService,
    escrowService,
    intervalMs: bountyEscrowSyncIntervalMs,
  });
  const protocolSweepTimer = setInterval(() => {
    void protocolService.sweepExpiredStates();
  }, bountyEscrowSyncIntervalMs);

  if (typeof protocolSweepTimer.unref === "function") {
    protocolSweepTimer.unref();
  }

  server.on("close", () => {
    bountyEscrowSync.stop();
    clearInterval(protocolSweepTimer);
    if (webTorrentTrackerService) {
      void webTorrentTrackerService.stop();
    }
  });

  return {
    app,
    server,
    escrowService,
    authService,
    bountyService,
    protocolService,
    bountyEscrowSync,
    webTorrentTrackerService,
    port,
    host,
  };
}

import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { port, host } = await startServer();
  console.log(`Bit Lazarus node listening on http://${host}:${port}`);
}
