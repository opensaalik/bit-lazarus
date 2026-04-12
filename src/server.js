import express from "express";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { AuthService } from "./auth-service.js";
import { startBountyEscrowSync } from "./bounty-escrow-sync.js";
import { BountyService } from "./bounty-service.js";
import { EscrowService } from "./escrow-service.js";
import { createLightningClientFromEnv } from "./lightning-client.js";
import { createPolarDemoServiceFromEnv } from "./polar-demo-service.js";
import { ProtocolService } from "./protocol-service.js";
import { parseTorrentMetadata } from "./torrent-piece-proof.js";
import { createWalletAuthVerifierFromEnv } from "./wallet-auth-verifier.js";
import { WalletNode } from "./wallet-node.js";
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

function canAccessVerificationSession(userId, session) {
  return [session.payerUserId, session.hunterUserId].includes(userId);
}

function canAccessDeliveryContract(userId, contract) {
  return [contract.payerUserId, contract.hunterUserId].includes(userId);
}

export function createApp({
  walletNode,
  escrowService,
  authService,
  bountyService,
  protocolService,
  polarDemoService = null,
  webTorrentTrackerService = null,
  enableManualEscrowActions = false,
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
      nodeId: walletNode.nodeId,
      demoCapabilities: polarDemoService?.getCapabilities?.() ?? {
        backendPayments: false,
        backendPayoutInvoices: false,
        backendReceiptSigning: false,
      },
      webTorrent: webTorrentTrackerService?.getPublicConfig?.() ?? {
        enabled: false,
        announceUrls: [],
      },
    });
  });

  app.post("/auth/challenges", async (request, response) => {
    const requestedKind = request.body?.kind;
    const kind = requestedKind === "webln" ? "webln" : requestedKind === "nostr" ? "nostr" : "bitcoin";
    const challenge = await authService.issueChallenge({
      walletAddress: request.body?.walletAddress,
      kind,
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
    const body = request.body ?? {};
    const requestedBountyId = body.bountyId;
    const bountyId =
      typeof requestedBountyId === "string" && requestedBountyId.trim()
        ? requestedBountyId.trim()
        : crypto.randomUUID();
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
    });
    response.status(201).json({ bounty });
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

  app.get("/bounties/:bountyId/verification-sessions", requireAuth, (request, response) => {
    const bounty = bountyService.getBounty(request.params.bountyId);

    if (!bounty) {
      response.status(404).json({ error: "bounty not found" });
      return;
    }

    if (!canAccessBounty(request.auth.user.id, bounty)) {
      response.status(403).json({ error: "bounty access denied" });
      return;
    }

    const verificationSessions = protocolService.listVerificationSessions({ bountyId: bounty.id });
    response.json({ verificationSessions });
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

  app.post("/bounties/:bountyId/verification-sessions", requireAuth, async (request, response) => {
    const bounty = bountyService.getBounty(request.params.bountyId);

    if (!bounty) {
      response.status(404).json({ error: "bounty not found" });
      return;
    }

    if (bounty.status !== "OPEN") {
      response.status(409).json({ error: "bounty must be OPEN before verification can start" });
      return;
    }

    if (request.auth.user.id === bounty.creatorUserId) {
      response.status(403).json({ error: "bounty creators cannot open hunter verification sessions" });
      return;
    }

    if (!bounty.hunters.some((hunter) => hunter.userId === request.auth.user.id)) {
      response.status(403).json({ error: "only joined hunters can start verification sessions" });
      return;
    }

    const pieceIndexes = Array.isArray(request.body?.pieceIndexes)
      ? request.body.pieceIndexes
      : bounty.missingPieces;

    for (const pieceIndex of pieceIndexes) {
      if (!bounty.missingPieces.includes(pieceIndex)) {
        response.status(400).json({ error: `piece ${pieceIndex} is not listed as missing for this bounty` });
        return;
      }
    }

    const verificationSession = await protocolService.createVerificationSession({
      bountyId: bounty.id,
      payerUserId: bounty.creatorUserId,
      hunterUserId: request.auth.user.id,
      pieceIndexes,
      torrentInfoHash: bounty.torrentInfoHash,
    });
    await bountyService.registerVerificationSession({
      bountyId: bounty.id,
      verificationSessionId: verificationSession.id,
    });
    await bountyService.updateProtocolState({
      bountyId: bounty.id,
      deliveryStatus: "PROOF_IN_PROGRESS",
    });
    response.status(201).json({ verificationSession });
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

  app.get("/verification-sessions/:sessionId", requireAuth, (request, response) => {
    const verificationSession = protocolService.getVerificationSession(request.params.sessionId);

    if (!verificationSession) {
      response.status(404).json({ error: "verification session not found" });
      return;
    }

    if (!canAccessVerificationSession(request.auth.user.id, verificationSession)) {
      response.status(403).json({ error: "verification session access denied" });
      return;
    }

    response.json({ verificationSession });
  });

  app.post("/verification-sessions/:sessionId/proof", requireAuth, async (request, response) => {
    const verificationSession = protocolService.getVerificationSession(request.params.sessionId);

    if (!verificationSession) {
      response.status(404).json({ error: "verification session not found" });
      return;
    }

    if (verificationSession.hunterUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the assigned hunter can submit proof" });
      return;
    }

    const updatedSession = await protocolService.submitProofArtifacts({
      sessionId: verificationSession.id,
      hunterUserId: request.auth.user.id,
      proofArtifacts: request.body?.proofArtifacts,
    });
    response.json({ verificationSession: updatedSession });
  });

  app.post("/verification-sessions/:sessionId/verify", requireAuth, async (request, response) => {
    const verificationSession = protocolService.getVerificationSession(request.params.sessionId);

    if (!verificationSession) {
      response.status(404).json({ error: "verification session not found" });
      return;
    }

    if (verificationSession.payerUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the payer can verify proof sessions" });
      return;
    }

    const updatedSession = await protocolService.markProofVerified({
      sessionId: verificationSession.id,
      payerUserId: request.auth.user.id,
      verifiedPieceIndexes: request.body?.verifiedPieceIndexes,
      verificationSummary: request.body?.verificationSummary,
    });
    await bountyService.updateProtocolState({
      bountyId: updatedSession.bountyId,
      deliveryStatus: "PROOF_VERIFIED",
    });
    response.json({ verificationSession: updatedSession });
  });

  app.post("/verification-sessions/:sessionId/contracts", requireAuth, async (request, response) => {
    const verificationSession = protocolService.getVerificationSession(request.params.sessionId);

    if (!verificationSession) {
      response.status(404).json({ error: "verification session not found" });
      return;
    }

    if (verificationSession.payerUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the payer can create delivery contracts" });
      return;
    }

    const bounty = bountyService.getBounty(verificationSession.bountyId);
    const payer = authService.getUser(verificationSession.payerUserId);
    const hunter = authService.getUser(verificationSession.hunterUserId);
    const contract = await protocolService.createDeliveryContract({
      sessionId: verificationSession.id,
      bountyId: verificationSession.bountyId,
      payerUserId: verificationSession.payerUserId,
      hunterUserId: verificationSession.hunterUserId,
      payerWalletAddress: payer.walletAddress,
      hunterWalletAddress: hunter.walletAddress,
      pieceIndexes: request.body?.pieceIndexes ?? verificationSession.verifiedPieceIndexes,
      rewardEscrowId: bounty.escrowId,
      deliveryVerificationMode: bounty.deliveryVerificationMode ?? "torrent-hash",
    });

    const bondResult = await protocolService.createBondEscrows({
      contractId: contract.id,
      bondAmountSats: bounty.bondAmountSats,
    });

    await bountyService.registerDeliveryContract({
      bountyId: bounty.id,
      contractId: contract.id,
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

  app.post("/contracts/:contractId/payout-invoice", requireAuth, async (request, response) => {
    const contract = protocolService.getDeliveryContract(request.params.contractId);

    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (!canAccessDeliveryContract(request.auth.user.id, contract)) {
      response.status(403).json({ error: "delivery contract access denied" });
      return;
    }

    const updatedContract = await protocolService.registerContractPayoutInvoice({
      contractId: contract.id,
      userId: request.auth.user.id,
      paymentRequest: request.body?.paymentRequest,
    });

    await bountyService.updateProtocolState({
      bountyId: updatedContract.bountyId,
      deliveryStatus: updatedContract.state,
      completionReadiness: updatedContract.resolutionReadiness,
    });

    response.json({ contract: updatedContract });
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

  app.post("/contracts/:contractId/bonds", requireAuth, async (request, response) => {
    const contract = protocolService.getDeliveryContract(request.params.contractId);

    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (contract.payerUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the payer can update bond status" });
      return;
    }

    const updatedContract = await protocolService.updateContractBondEscrows({
      contractId: contract.id,
      payerUserId: request.auth.user.id,
      payerBondEscrowId: request.body?.payerBondEscrowId,
      hunterBondEscrowId: request.body?.hunterBondEscrowId,
      payerBondStatus: request.body?.payerBondStatus,
      hunterBondStatus: request.body?.hunterBondStatus,
    });
    await bountyService.updateProtocolState({
      bountyId: updatedContract.bountyId,
      deliveryStatus: updatedContract.state,
    });
    response.json({ contract: updatedContract });
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

  app.get("/contracts/:contractId/receipts", requireAuth, (request, response) => {
    const contract = protocolService.getDeliveryContract(request.params.contractId);

    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (!canAccessDeliveryContract(request.auth.user.id, contract)) {
      response.status(403).json({ error: "delivery contract access denied" });
      return;
    }

    const receipts = protocolService.listPieceReceipts({ contractId: contract.id });
    response.json({ receipts });
  });

  app.post("/contracts/:contractId/receipts", requireAuth, async (request, response) => {
    const contract = protocolService.getDeliveryContract(request.params.contractId);

    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (contract.payerUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the payer can submit receipts" });
      return;
    }

    const receipt = await protocolService.submitPieceReceipt({
      contractId: contract.id,
      payerUserId: request.auth.user.id,
      receiptSignerWalletAddress: request.body?.receiptSignerWalletAddress,
      pieceIndex: request.body?.pieceIndex,
      receiptMessage: request.body?.receiptMessage,
      receiptSignature: request.body?.receiptSignature,
      receiptSignedEvent: request.body?.receiptSignedEvent,
    });
    const updatedContract = protocolService.getDeliveryContract(contract.id);
    await bountyService.updateProtocolState({
      bountyId: updatedContract.bountyId,
      deliveryStatus: updatedContract.state,
      completionReadiness: updatedContract.resolutionReadiness,
    });
    response.status(201).json({ receipt, contract: updatedContract });
  });

  app.post("/contracts/:contractId/demo-submit-receipts", requireAuth, async (request, response) => {
    if (!polarDemoService?.getCapabilities()?.backendReceiptSigning) {
      response.status(503).json({ error: "Polar demo receipt signing is not configured on this server" });
      return;
    }

    const contract = protocolService.getDeliveryContract(request.params.contractId);

    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (contract.payerUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the payer can submit receipts" });
      return;
    }

    const bounty = bountyService.getBounty(contract.bountyId);
    const torrentBuffer = await bountyService.getTorrentFile(bounty.torrentInfoHash);

    if (!torrentBuffer) {
      response.status(409).json({ error: "torrent file is required to build receipt messages in demo mode" });
      return;
    }

    const torrentMetadata = parseTorrentMetadata(torrentBuffer);
    const existingReceipts = protocolService.listPieceReceipts({ contractId: contract.id });
    const submittedPieceIndexes = new Set(existingReceipts.map((receipt) => receipt.pieceIndex));
    const outstandingPieceIndexes = contract.pieceIndexes.filter((pieceIndex) => !submittedPieceIndexes.has(pieceIndex));
    const createdReceipts = [];

    for (const pieceIndex of outstandingPieceIndexes) {
      const pieceHash = torrentMetadata.pieces[pieceIndex];
      const receiptMessage = `deliveryContractId=${contract.id}|pieceIndex=${pieceIndex}|pieceHash=${pieceHash}`;
      const receiptSignature = await polarDemoService.signRequesterReceipt({
        walletAddress: contract.payerWalletAddress,
        message: receiptMessage,
      });
      const receipt = await protocolService.submitPieceReceipt({
        contractId: contract.id,
        payerUserId: request.auth.user.id,
        receiptSignerWalletAddress: contract.payerWalletAddress,
        pieceIndex,
        receiptMessage,
        receiptSignature,
      });
      createdReceipts.push(receipt);
    }

    const updatedContract = protocolService.getDeliveryContract(contract.id);
    await bountyService.updateProtocolState({
      bountyId: updatedContract.bountyId,
      deliveryStatus: updatedContract.state,
      completionReadiness: updatedContract.resolutionReadiness,
    });
    response.status(201).json({ receipts: createdReceipts, contract: updatedContract });
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
    if (!enableManualEscrowActions) {
      response.status(403).json({ error: "manual escrow release is disabled; use contract resolution instead" });
      return;
    }

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
    if (!enableManualEscrowActions) {
      response.status(403).json({ error: "manual escrow cancel is disabled; use contract resolution instead" });
      return;
    }

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
  enableManualEscrowActions = process.env.ENABLE_MANUAL_ESCROW_ACTIONS === "1",
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
  const protocolService = new ProtocolService({
    dataDir: path.join(dataDir, "protocol"),
    verifier: authVerifier,
    escrowService,
  });
  await protocolService.init();
  const polarDemoService = createPolarDemoServiceFromEnv(process.env);
  const webTorrentTrackerService = createWebTorrentTrackerServiceFromEnv(process.env);

  if (webTorrentTrackerService) {
    await webTorrentTrackerService.start();
  }

  const app = createApp({
    walletNode,
    escrowService,
    authService,
    bountyService,
    protocolService,
    polarDemoService,
    webTorrentTrackerService,
    enableManualEscrowActions,
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
    walletNode,
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
