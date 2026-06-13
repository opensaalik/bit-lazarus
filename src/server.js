import express from "express";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { AuthService } from "./auth-service.js";
import { ARC_TESTNET_CHAIN_ID } from "./arc-escrow-service.js";
import { BountyService } from "./bounty-service.js";
import { ProtocolService } from "./protocol-service.js";
import { createResourceLocatorServiceFromEnv } from "./resource-locator-service.js";
import { createWalrusServiceFromEnv } from "./walrus-service.js";
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

function canAccessBounty(userId, bounty) {
  return bounty.creatorUserId === userId || bounty.hunters.some((hunter) => hunter.userId === userId);
}

function canAccessDeliveryContract(userId, contract) {
  return [contract.payerUserId, contract.hunterUserId].includes(userId);
}

function parseRewardAmountUnits(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("rewardAmountUnits must be a positive integer");
  }

  return parsed;
}

function sanitizeDownloadFilename(value, fallback = "bit-lazarus-archive.bin") {
  const normalized = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const sanitized = normalized
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 160)
    .trim();

  return sanitized || fallback;
}

function getArcEscrowService(resourceLocatorService) {
  return resourceLocatorService.arcEscrowService;
}

function sortContractsNewestFirst(left, right) {
  const leftTime = new Date(left?.updatedAt ?? left?.createdAt ?? 0).getTime();
  const rightTime = new Date(right?.updatedAt ?? right?.createdAt ?? 0).getTime();

  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }

  return String(right?.id ?? "").localeCompare(String(left?.id ?? ""));
}

function getBountyProtocolStateFromContracts(contracts) {
  const sortedContracts = [...contracts].sort(sortContractsNewestFirst);
  const activeContract = sortedContracts.find((contract) => !String(contract?.state ?? "").startsWith("RESOLVED_"));
  const latestContract = activeContract ?? sortedContracts[0] ?? null;

  return {
    deliveryStatus: latestContract?.state ?? "IDLE",
    completionReadiness: latestContract?.resolutionReadiness ?? "PENDING",
  };
}

export function createApp({
  authService,
  bountyService,
  protocolService,
  resourceLocatorService = null,
  walrusService,
  webTorrentTrackerService = null,
}) {
  if (!walrusService) {
    throw new Error("walrusService is required");
  }

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

      request.auth = await authService.authenticateSession(token);
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get("/health", (_request, response) => {
    const arcEscrowService = getArcEscrowService(resourceLocatorService);

    response.json({
      ok: true,
      payments: {
        network: "arc",
        escrow: arcEscrowService.contractAddress,
      },
      webTorrent: webTorrentTrackerService?.getPublicConfig?.() ?? {
        enabled: false,
        announceUrls: [],
      },
      walrus: walrusService.getPublicConfig(),
    });
  });

  app.get("/arc/config", (_request, response) => {
    const arcEscrowService = getArcEscrowService(resourceLocatorService);

    response.json({
      arc: {
        chainId: ARC_TESTNET_CHAIN_ID,
        chainName: "Arc Testnet",
        rpcUrl: arcEscrowService.rpcUrl,
        escrowContractAddress: arcEscrowService.contractAddress,
        usdcAddress: arcEscrowService.usdcAddress,
      },
    });
  });

  app.get("/walrus/config", (_request, response) => {
    response.json({
      walrus: walrusService.getPublicConfig(),
    });
  });

  app.put(
    "/walrus/blobs",
    requireAuth,
    express.raw({
      limit: process.env.WALRUS_UPLOAD_LIMIT ?? "100mb",
      type: "application/octet-stream",
    }),
    async (request, response, next) => {
      try {
        const bytes = request.body;

        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
          response.status(400).json({ error: "request body must be non-empty application/octet-stream bytes" });
          return;
        }

        const storedBlob = await walrusService.storeBlob({ bytes });
        response.status(201).json(storedBlob);
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/arc/bounties/by-infohash/:torrentInfoHash", requireAuth, async (request, response, next) => {
    try {
      const arcEscrowService = getArcEscrowService(resourceLocatorService);
      const bounty = await arcEscrowService.getBountyByInfoHash(request.params.torrentInfoHash);
      if (!bounty) {
        response.status(404).json({ error: "Arc bounty not found" });
        return;
      }

      response.json({ bounty });
    } catch (error) {
      next(error);
    }
  });

  app.post("/arc/transactions/create-bounty", requireAuth, async (request, response, next) => {
    try {
      const arcEscrowService = getArcEscrowService(resourceLocatorService);
      const rewardAmountUnits = parseRewardAmountUnits(request.body?.rewardAmountUnits);
      const spec = typeof request.body?.spec === "string" ? request.body.spec : "";
      const deadlineAt = request.body?.deadlineAt ?? 0;
      const existingBounty = await arcEscrowService.getBountyByInfoHash(request.body?.torrentInfoHash);

      if (existingBounty) {
        response.status(409).json({
          error: `Arc bounty already exists for this torrent infohash: ${existingBounty.bountyId}`,
          bounty: existingBounty,
        });
        return;
      }

      response.json({
        approvalTransaction: arcEscrowService.buildApprovalTransaction({ rewardAmountUnits }),
        createBountyTransaction: arcEscrowService.buildCreateBountyTransaction({
          torrentInfoHash: request.body?.torrentInfoHash,
          rewardAmountUnits,
          spec,
          deadlineAt,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/arc/transactions/claim-bounty", requireAuth, (request, response) => {
    const arcEscrowService = getArcEscrowService(resourceLocatorService);
    response.json({
      transaction: arcEscrowService.buildClaimBountyTransaction({
        bountyId: request.body?.bountyId,
      }),
    });
  });

  app.post("/arc/transactions/submit-delivery", requireAuth, (request, response) => {
    const arcEscrowService = getArcEscrowService(resourceLocatorService);
    response.json({
      transaction: arcEscrowService.buildSubmitDeliveryTransaction({
        bountyId: request.body?.bountyId,
        deliveryHash: request.body?.deliveryHash,
        walrusBlobId: request.body?.walrusBlobId ?? "",
      }),
    });
  });

  app.post("/arc/transactions/confirm-delivery", requireAuth, (request, response) => {
    const arcEscrowService = getArcEscrowService(resourceLocatorService);
    response.json({
      transaction: arcEscrowService.buildConfirmDeliveryTransaction({
        bountyId: request.body?.bountyId,
        walrusBlobId: request.body?.walrusBlobId,
      }),
    });
  });

  app.post("/arc/transactions/refund-expired", requireAuth, (request, response) => {
    const arcEscrowService = getArcEscrowService(resourceLocatorService);
    response.json({
      transaction: arcEscrowService.buildRefundExpiredTransaction({
        bountyId: request.body?.bountyId,
      }),
    });
  });

  app.get("/ens/ccip/:sender/:data", async (request, response, next) => {
    if (!resourceLocatorService) {
      response.status(503).json({ error: "resource locator service is not configured" });
      return;
    }

    try {
      response.json(await resourceLocatorService.answerCcipRead({
        sender: request.params.sender,
        data: request.params.data,
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/ens/ccip", async (request, response, next) => {
    if (!resourceLocatorService) {
      response.status(503).json({ error: "resource locator service is not configured" });
      return;
    }

    try {
      response.json(await resourceLocatorService.answerCcipRead({
        sender: request.body?.sender,
        data: request.body?.data,
      }));
    } catch (error) {
      next(error);
    }
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

    const rewardAmountUnits = parseRewardAmountUnits(body.rewardAmountUnits);
    const rewardToken = typeof body.rewardToken === "string" && body.rewardToken.trim()
      ? body.rewardToken.trim().toUpperCase()
      : "USDC";
    const escrowStatus = typeof body.escrowStatus === "string" && body.escrowStatus.trim()
      ? body.escrowStatus.trim().toUpperCase()
      : "PENDING";
    const escrowId = typeof body.escrowId === "string" && body.escrowId.trim()
      ? body.escrowId.trim()
      : null;
    const resourceResult = resourceLocatorService
      ? await resourceLocatorService.ensureResourceForBounty({
        torrentInfoHash: body.torrentInfoHash,
        bountyId,
        title: body.title,
        description: body.description,
        rewardAmountUnits,
        rewardToken,
      })
      : null;

    const bounty = await bountyService.createBounty({
      ...body,
      bountyId,
      creatorUserId: request.auth.user.id,
      rewardAmountUnits,
      rewardToken,
      escrowId,
      escrowStatus,
      funding: body.funding ?? null,
      resourceLocator: resourceResult?.resource ?? null,
    });
    response.status(201).json({ bounty });
  });

  app.get("/resources/:torrentInfoHash/resolve", requireAuth, async (request, response, next) => {
    if (!resourceLocatorService) {
      response.status(503).json({ error: "resource locator service is not configured" });
      return;
    }

    try {
      response.json({
        resolution: await resourceLocatorService.resolveLocator(request.params.torrentInfoHash),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/resources/resolve", requireAuth, async (request, response, next) => {
    if (!resourceLocatorService) {
      response.status(503).json({ error: "resource locator service is not configured" });
      return;
    }

    try {
      const locator = typeof request.query.locator === "string" ? request.query.locator : "";
      const resolution = await resourceLocatorService.resolveLocator(locator);
      const bounty = bountyService
        .listBounties({})
        .find((candidate) => candidate.torrentInfoHash === resolution.torrentInfoHash) ?? null;

      response.json({
        resolution,
        bounty,
      });
    } catch (error) {
      next(error);
    }
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

  app.get("/resources/:torrentInfoHash/download", requireAuth, async (request, response, next) => {
    if (!resourceLocatorService) {
      response.status(503).json({ error: "resource locator service is not configured" });
      return;
    }

    try {
      const resolution = await resourceLocatorService.resolveLocator(request.params.torrentInfoHash);
      const { ensName, torrentInfoHash, walrusBlobId } = resolution;

      if (resolution.mode !== "walrus" || !walrusBlobId) {
        response.status(404).json({ error: "Walrus archive not found for this torrent resource" });
        return;
      }

      const walrusResponse = await walrusService.fetchBlob(walrusBlobId);
      const bounty = bountyService
        .listBounties({})
        .find((candidate) => candidate.torrentInfoHash === torrentInfoHash);
      const filename = sanitizeDownloadFilename(bounty?.torrentMeta?.name ?? bounty?.torrentName);

      response.setHeader("Content-Type", walrusResponse.headers.get("content-type") ?? "application/octet-stream");
      response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      response.setHeader("X-Bit-Lazarus-ENS-Name", ensName);
      response.setHeader("X-Bit-Lazarus-Walrus-Blob-Id", walrusBlobId);

      const contentLength = walrusResponse.headers.get("content-length");
      if (contentLength) {
        response.setHeader("Content-Length", contentLength);
      }

      if (!walrusResponse.body) {
        response.end();
        return;
      }

      Readable.fromWeb(walrusResponse.body).pipe(response);
    } catch (error) {
      next(error);
    }
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
      .find((contract) => !String(contract.state ?? "").startsWith("RESOLVED_"));

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
      rewardAmountUnits: bounty.rewardAmountUnits,
      rewardToken: bounty.rewardToken,
    });

    await bountyService.registerDeliveryContract({
      bountyId: bounty.id,
      contractId: contract.id,
    });
    await bountyService.updateProtocolState({
      bountyId: bounty.id,
      deliveryStatus: contract.state,
      completionReadiness: contract.resolutionReadiness,
    });

    response.status(201).json({ contract });
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

  app.delete("/contracts/:contractId", requireAuth, async (request, response) => {
    const contract = protocolService.getDeliveryContract(request.params.contractId);

    if (!contract) {
      response.status(404).json({ error: "delivery contract not found" });
      return;
    }

    if (contract.payerUserId !== request.auth.user.id) {
      response.status(403).json({ error: "only the requester can delete a delivery contract" });
      return;
    }

    if (contract.state === "RESOLVED_SUCCESS") {
      response.status(409).json({ error: "successful delivery contracts cannot be deleted" });
      return;
    }

    const deletedContract = await protocolService.deleteDeliveryContract(contract.id);
    const remainingContracts = protocolService.listDeliveryContracts({ bountyId: deletedContract.bountyId });
    const nextProtocolState = getBountyProtocolStateFromContracts(remainingContracts);
    const bounty = await bountyService.unregisterDeliveryContract({
      bountyId: deletedContract.bountyId,
      contractId: deletedContract.id,
      ...nextProtocolState,
    });

    response.json({
      contract: deletedContract,
      bounty,
    });
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
  protocolSweepIntervalMs = Number.parseInt(process.env.PROTOCOL_SWEEP_INTERVAL_MS ?? "30000", 10),
} = {}) {
  const authVerifier = createWalletAuthVerifierFromEnv(process.env);
  const authService = new AuthService({
    dataDir: path.join(dataDir, "auth"),
    verifier: authVerifier,
  });
  await authService.init();
  const bountyService = new BountyService({
    dataDir: path.join(dataDir, "bounties"),
  });
  await bountyService.init();
  const protocolService = new ProtocolService({
    dataDir: path.join(dataDir, "protocol"),
  });
  await protocolService.init();
  const resourceLocatorService = createResourceLocatorServiceFromEnv(process.env, {
    dataDir: path.join(dataDir, "resources"),
  });
  await resourceLocatorService.init();
  const walrusService = createWalrusServiceFromEnv(process.env);
  const webTorrentTrackerService = createWebTorrentTrackerServiceFromEnv(process.env, { host, port });

  const app = createApp({
    authService,
    bountyService,
    protocolService,
    resourceLocatorService,
    walrusService,
    webTorrentTrackerService,
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(port, host, () => resolve(instance));
  });

  if (webTorrentTrackerService) {
    webTorrentTrackerService.attach(server);
  }

  const protocolSweepTimer = setInterval(() => {
    void protocolService.sweepExpiredStates();
  }, protocolSweepIntervalMs);

  if (typeof protocolSweepTimer.unref === "function") {
    protocolSweepTimer.unref();
  }

  server.on("close", () => {
    clearInterval(protocolSweepTimer);
    if (webTorrentTrackerService) {
      void webTorrentTrackerService.stop();
    }
  });

  return {
    app,
    server,
    authService,
    bountyService,
    protocolService,
    walrusService,
    webTorrentTrackerService,
    port,
    host,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { port, host } = await startServer();
  console.log(`Bit Lazarus node listening on http://${host}:${port}`);
}
