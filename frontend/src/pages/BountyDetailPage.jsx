import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import BountyCard from "../components/BountyCard.jsx";
import { requestBytes, requestJson } from "../lib/api.js";
import { useApp } from "../context/AppContext.jsx";
import { createSignedNostrEvent } from "../lib/nostr.js";
import { computeSha256Hex } from "../lib/sha256.js";
import { createInvoiceWithWebLn, sendPaymentWithWebLn, signMessageWithWebLn } from "../lib/webln.js";
import {
  addTorrent,
  destroyWebTorrentClient,
  removeTorrent,
  seedTorrent,
} from "../lib/webtorrent-client.js";
import {
  generatePieceProof,
  parseTorrentMetadata,
  verifyPieceProofFromRound,
} from "../lib/torrent-piece-proof.js";

const POLL_INTERVAL_MS = 3000;
const HOLD_INVOICE_TIMEOUT_MS = 5000;

function sortNewestFirst(left, right) {
  return String(right?.createdAt ?? "").localeCompare(String(left?.createdAt ?? ""));
}

function getLatestById(records, preferredIds = []) {
  if (!Array.isArray(records) || records.length === 0) {
    return null;
  }

  for (let index = preferredIds.length - 1; index >= 0; index -= 1) {
    const preferred = records.find((record) => record.id === preferredIds[index]);
    if (preferred) {
      return preferred;
    }
  }

  return [...records].sort(sortNewestFirst)[0];
}

function getProtocolHeadline({ bounty, activeSession, activeContract }) {
  if (!bounty) {
    return "Loading workflow";
  }

  if (String(activeContract?.state ?? "").startsWith("RESOLVED_")) {
    return "Resolution complete";
  }

  if (activeContract?.deliveryVerificationMode === "torrent-hash") {
    if (activeContract?.deliveryHashStatus === "MISMATCHED") {
      return "Hash mismatch detected";
    }

    if (activeContract?.state === "DELIVERY_VERIFIED") {
      return "Waiting for final settlement";
    }

    if (activeContract?.state === "DELIVERY_IN_PROGRESS" && !activeContract?.hunterDeliveryFileSha256) {
      return "Hunter must seed the file";
    }

    if (activeContract?.state === "DELIVERY_IN_PROGRESS" && activeContract?.hunterDeliveryFileSha256) {
      return "Requester download and verify the file";
    }
  }

  if (activeContract?.state === "DELIVERY_VERIFIED") {
    return "Waiting for final settlement";
  }

  if (activeContract?.state === "DELIVERY_IN_PROGRESS") {
    return "Delivery receipt required";
  }

  if (activeContract?.state === "BOND_PENDING") {
    return "Fund the collateral bonds";
  }

  if (activeSession?.status === "PROOF_SUBMITTED") {
    return "Proof ready for review";
  }

  if (activeSession?.status === "PROOF_VERIFIED") {
    return "Proof accepted, contract can start";
  }

  if (activeSession?.status === "PROOF_CHALLENGE_OPEN") {
    return "Generate and submit proof";
  }

  if (bounty.escrowStatus === "AWAITING_FUNDING") {
    return "Fund the bounty escrow";
  }

  if (bounty.status === "OPEN") {
    return "Open for hunters";
  }

  return "Protocol workspace";
}

function formatProtocolRole({ bounty, currentUser, isJoinedHunter }) {
  if (!bounty || !currentUser) {
    return "Viewer";
  }

  if (bounty.creatorUserId === currentUser.id) {
    return "Requester";
  }

  if (isJoinedHunter) {
    return "Hunter";
  }

  return "Viewer";
}

function uniquePieceIndexes(pieceIndexes) {
  return [...new Set((pieceIndexes ?? []).filter((pieceIndex) => Number.isInteger(pieceIndex)))].sort((a, b) => a - b);
}

function getUserBondEscrowId(contract, userId) {
  if (!contract || !userId) {
    return null;
  }

  if (contract.payerUserId === userId) {
    return contract.payerBondEscrowId;
  }

  if (contract.hunterUserId === userId) {
    return contract.hunterBondEscrowId;
  }

  return null;
}

function getOutstandingReceiptPieceIndexes(contract, receipts) {
  if (!contract || (contract.deliveryVerificationMode ?? "receipt") !== "receipt") {
    return [];
  }

  const submittedPieceIndexes = new Set((receipts ?? []).map((receipt) => receipt.pieceIndex));
  return contract.pieceIndexes.filter((pieceIndex) => !submittedPieceIndexes.has(pieceIndex));
}

function formatPercent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function getTrackerAnnounceUrls(health) {
  const announceUrls = Array.isArray(health?.webTorrent?.announceUrls) ? health.webTorrent.announceUrls : [];
  return [...new Set(announceUrls.filter((value) => typeof value === "string" && value.trim()))];
}

async function safelyRemoveTorrent(torrent) {
  if (!torrent) {
    return;
  }

  try {
    await removeTorrent(torrent);
  } catch (_error) {
    // Ignore client cleanup failures while switching torrents.
  }
}

export default function BountyDetailPage() {
  const { bountyId } = useParams();
  const { token, currentUser, mergeBounty, bounties, hasNostr, hasWebLn, health, setStatusMessage } = useApp();
  const [bounty, setBounty] = useState(() => bounties.find((record) => record.id === bountyId) ?? null);
  const [verificationSessions, setVerificationSessions] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [currentBondEscrow, setCurrentBondEscrow] = useState(null);
  const [rewardEscrow, setRewardEscrow] = useState(null);
  const [torrentBytes, setTorrentBytes] = useState(null);
  const [torrentMetadata, setTorrentMetadata] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [protocolError, setProtocolError] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedPieces, setSelectedPieces] = useState([]);
  const [contentFileName, setContentFileName] = useState("");
  const [contentBytes, setContentBytes] = useState(null);
  const [generatedProofs, setGeneratedProofs] = useState([]);
  const [browserVerification, setBrowserVerification] = useState([]);
  const [verificationSummary, setVerificationSummary] = useState("Browser-assisted verification");
  const [autoReceiptKey, setAutoReceiptKey] = useState("");
  const [deliverySeedStatus, setDeliverySeedStatus] = useState({
    phase: "idle",
    infoHash: null,
    peers: 0,
    uploadedBytes: 0,
    fileSha256: null,
  });
  const [deliveryDownloadStatus, setDeliveryDownloadStatus] = useState({
    phase: "idle",
    infoHash: null,
    peers: 0,
    downloadedBytes: 0,
    progress: 0,
    expectedSha256: null,
    fileSha256: null,
  });
  const hunterSeedTorrentRef = useRef(null);
  const requesterDownloadTorrentRef = useRef(null);

  useEffect(() => {
    const fromList = bounties.find((record) => record.id === bountyId);
    if (fromList) {
      setBounty(fromList);
    }
  }, [bounties, bountyId]);

  useEffect(() => {
    setTorrentBytes(null);
    setTorrentMetadata(null);
    setGeneratedProofs([]);
    setBrowserVerification([]);
    setContentBytes(null);
    setContentFileName("");
  }, [bountyId]);

  const isCreator = bounty?.creatorUserId === currentUser?.id;
  const isJoinedHunter = Boolean(currentUser && bounty?.hunters.some((hunter) => hunter.userId === currentUser.id));
  const isParticipant = Boolean(token && currentUser && (isCreator || isJoinedHunter));
  const usingWebLnIdentity = currentUser?.walletType === "webln";
  const usingNostrIdentity = currentUser?.walletType === "nostr";
  const demoCapabilities = health?.demoCapabilities ?? {};
  const hasBackendDemoPayments = Boolean(demoCapabilities.backendPayments);
  const hasBackendDemoPayoutInvoices = Boolean(demoCapabilities.backendPayoutInvoices);
  const hasBackendDemoReceipts = Boolean(demoCapabilities.backendReceiptSigning);
  const trackerAnnounceUrls = useMemo(() => getTrackerAnnounceUrls(health), [health]);
  const canUseWebLnPayments = hasWebLn || hasBackendDemoPayments;
  const canCreatePayoutInvoice = hasWebLn || hasBackendDemoPayoutInvoices;
  const canSignReceipts = (
    (usingWebLnIdentity && hasWebLn)
    || (usingNostrIdentity && hasNostr)
    || (isCreator && hasBackendDemoReceipts)
  );
  const canUseWebTorrentTransfer = trackerAnnounceUrls.length > 0;
  const activeContract = useMemo(
    () => getLatestById(contracts, bounty?.activeContractIds ?? []),
    [contracts, bounty?.activeContractIds],
  );
  const activeSession = useMemo(() => {
    if (activeContract) {
      return verificationSessions.find((record) => record.id === activeContract.sessionId) ?? null;
    }

    return getLatestById(verificationSessions, bounty?.verificationSessionIds ?? []);
  }, [activeContract, bounty?.verificationSessionIds, verificationSessions]);
  const currentRole = formatProtocolRole({ bounty, currentUser, isJoinedHunter });
  const outstandingReceiptPieceIndexes = useMemo(
    () => getOutstandingReceiptPieceIndexes(activeContract, receipts),
    [activeContract, receipts],
  );
  const allProofsValid = browserVerification.length > 0 && browserVerification.every((result) => result.valid);
  const usesTorrentHashDelivery = (activeContract?.deliveryVerificationMode ?? "receipt") === "torrent-hash";
  const shouldPoll = Boolean(
    token &&
      bountyId &&
      (
        bounty?.escrowStatus === "AWAITING_FUNDING" ||
        activeSession?.status === "PROOF_SUBMITTED" ||
        activeContract?.state === "BOND_PENDING" ||
        activeContract?.state === "DELIVERY_IN_PROGRESS" ||
        activeContract?.state === "DELIVERY_VERIFIED" ||
        activeContract?.resolutionReadiness === "READY_FOR_RESOLUTION_SUCCESS"
      ),
  );

  const ensureTorrentMetadataLoaded = useCallback(async () => {
    if (torrentBytes && torrentMetadata) {
      return { torrentBytes, torrentMetadata };
    }

    if (!bounty?.hasTorrentFile) {
      throw new Error("This bounty was created without a .torrent file. Browser proof flow requires the torrent file.");
    }

    const bytes = await requestBytes(`/bounties/${bounty.id}/torrent`, { token });
    const metadata = await parseTorrentMetadata(bytes);

    setTorrentBytes(bytes);
    setTorrentMetadata(metadata);
    return {
      torrentBytes: bytes,
      torrentMetadata: metadata,
    };
  }, [bounty, token, torrentBytes, torrentMetadata]);

  const refreshDetail = useCallback(async ({ syncEscrow = false, quiet = false } = {}) => {
    if (!token || !bountyId) {
      return null;
    }

    if (!quiet) {
      setLoadingDetail(true);
      setLoadError(null);
      setProtocolError(null);
    }

    try {
      const bountyPayload = syncEscrow
        ? await requestJson(`/bounties/${bountyId}/sync-escrow`, { method: "POST", token })
        : await requestJson(`/bounties/${bountyId}`, { token });
      const nextBounty = bountyPayload.bounty;
      setBounty(nextBounty);
      mergeBounty(nextBounty);

      const canViewProtocol = Boolean(
        currentUser &&
          (nextBounty.creatorUserId === currentUser.id ||
            nextBounty.hunters.some((hunter) => hunter.userId === currentUser.id)),
      );

      if (!canViewProtocol) {
        setVerificationSessions([]);
        setContracts([]);
        setReceipts([]);
        setCurrentBondEscrow(null);
        setRewardEscrow(null);
        return nextBounty;
      }

      const [sessionPayload, contractPayload] = await Promise.all([
        requestJson(`/bounties/${bountyId}/verification-sessions`, { token }),
        requestJson(`/bounties/${bountyId}/contracts`, { token }),
      ]);
      const nextSessions = [...sessionPayload.verificationSessions].sort(sortNewestFirst);
      const nextContracts = [...contractPayload.contracts].sort(sortNewestFirst);

      setVerificationSessions(nextSessions);
      setContracts(nextContracts);

      const nextActiveContract = getLatestById(nextContracts, nextBounty.activeContractIds ?? []);

      if (!nextActiveContract) {
        setReceipts([]);
        setCurrentBondEscrow(null);
        setRewardEscrow(null);
        return nextBounty;
      }

      const receiptPromise = requestJson(`/contracts/${nextActiveContract.id}/receipts`, { token });
      const bondEscrowId = getUserBondEscrowId(nextActiveContract, currentUser?.id);
      const escrowRequests = [];

      if (bondEscrowId) {
        escrowRequests.push(
          requestJson(`/escrows/${bondEscrowId}`, { token })
            .then((payload) => ({ kind: "bond", escrow: payload.escrow }))
            .catch(() => ({ kind: "bond", escrow: null })),
        );
      }

      if (nextActiveContract.rewardEscrowId && nextActiveContract.payerUserId === currentUser?.id) {
        escrowRequests.push(
          requestJson(`/escrows/${nextActiveContract.rewardEscrowId}`, { token })
            .then((payload) => ({ kind: "reward", escrow: payload.escrow }))
            .catch(() => ({ kind: "reward", escrow: null })),
        );
      }

      const [receiptPayload, ...escrowPayloads] = await Promise.all([receiptPromise, ...escrowRequests]);

      setReceipts(receiptPayload.receipts);
      setCurrentBondEscrow(escrowPayloads.find((record) => record.kind === "bond")?.escrow ?? null);
      setRewardEscrow(escrowPayloads.find((record) => record.kind === "reward")?.escrow ?? null);

      return nextBounty;
    } catch (error) {
      if (!quiet) {
        setLoadError(error.message);
      } else {
        setProtocolError(error.message);
      }

      return null;
    } finally {
      if (!quiet) {
        setLoadingDetail(false);
      }
    }
  }, [bountyId, currentUser, mergeBounty, token]);

  useEffect(() => {
    if (!token || !bountyId) {
      setLoadingDetail(false);
      return;
    }

    let cancelled = false;

    refreshDetail().then(() => {
      if (cancelled) {
        return;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [bountyId, refreshDetail, token]);

  useEffect(() => {
    if (selectedPieces.length > 0) {
      return;
    }

    if (activeSession?.pieceIndexes?.length) {
      setSelectedPieces(uniquePieceIndexes(activeSession.pieceIndexes));
      return;
    }

    if (bounty?.missingPieces?.length) {
      setSelectedPieces([bounty.missingPieces[0]]);
    }
  }, [activeSession?.pieceIndexes, bounty?.missingPieces, selectedPieces.length]);

  useEffect(() => {
    setGeneratedProofs([]);
    setBrowserVerification([]);
  }, [activeSession?.id]);

  useEffect(() => {
    setDeliverySeedStatus({
      phase: "idle",
      infoHash: null,
      peers: 0,
      uploadedBytes: 0,
      fileSha256: null,
    });
    setDeliveryDownloadStatus({
      phase: "idle",
      infoHash: null,
      peers: 0,
      downloadedBytes: 0,
      progress: 0,
      expectedSha256: null,
      fileSha256: null,
    });

    return () => {
      const seedTorrentInstance = hunterSeedTorrentRef.current;
      const downloadTorrentInstance = requesterDownloadTorrentRef.current;
      hunterSeedTorrentRef.current = null;
      requesterDownloadTorrentRef.current = null;

      void Promise.all([
        safelyRemoveTorrent(seedTorrentInstance),
        safelyRemoveTorrent(downloadTorrentInstance),
      ]).then(() => destroyWebTorrentClient()).catch(() => {});
    };
  }, [activeContract?.id]);

  useEffect(() => {
    if (!shouldPoll) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      refreshDetail({
        syncEscrow: bounty?.escrowStatus === "AWAITING_FUNDING",
        quiet: true,
      });
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [bounty?.escrowStatus, refreshDetail, shouldPoll]);

  const runAction = useCallback(async (fn) => {
    setActionLoading(true);

    try {
      await fn();
    } catch (error) {
      setStatusMessage(error.message ?? String(error));
    } finally {
      setActionLoading(false);
    }
  }, [setStatusMessage]);

  const handleSyncEscrow = useCallback(() => {
    void runAction(async () => {
      await refreshDetail({ syncEscrow: true });
      setStatusMessage(`Escrow sync complete for bounty ${bountyId}.`);
    });
  }, [bountyId, refreshDetail, runAction, setStatusMessage]);

  const handleJoinBounty = useCallback(() => {
    void runAction(async () => {
      const payload = await requestJson(`/bounties/${bountyId}/hunt`, {
        method: "POST",
        token,
      });
      setBounty(payload.bounty);
      mergeBounty(payload.bounty);
      await refreshDetail({ quiet: true });
      setStatusMessage("Joined bounty as a hunter.");
    });
  }, [bountyId, mergeBounty, refreshDetail, runAction, setStatusMessage, token]);

  const handleFundEscrow = useCallback(() => {
    void runAction(async () => {
      if (!bounty.funding?.paymentRequest) {
        throw new Error("No Lightning invoice is available for this bounty escrow.");
      }

      const paymentResult = hasWebLn
        ? await sendPaymentWithWebLn(bounty.funding.paymentRequest, {
          timeoutMs: HOLD_INVOICE_TIMEOUT_MS,
        })
        : await requestJson(`/bounties/${bountyId}/demo-fund`, {
          method: "POST",
          token,
        });
      await refreshDetail({ syncEscrow: true });
      setStatusMessage(
        paymentResult.timedOut ?? paymentResult.payment?.timedOut
          ? "Funding request sent. Syncing escrow state..."
          : hasWebLn
            ? "Escrow payment sent and synced."
            : "Escrow funded from Polar and synced.",
      );
    });
  }, [bounty.funding?.paymentRequest, bountyId, hasWebLn, refreshDetail, runAction, setStatusMessage, token]);

  const handleStartVerificationSession = useCallback(() => {
    void runAction(async () => {
      const pieceIndexes = uniquePieceIndexes(selectedPieces);

      if (pieceIndexes.length === 0) {
        throw new Error("Select at least one missing piece before opening a verification session.");
      }

      await requestJson(`/bounties/${bountyId}/verification-sessions`, {
        method: "POST",
        token,
        body: { pieceIndexes },
      });
      await refreshDetail({ quiet: true });
      setStatusMessage(`Opened a verification session for piece${pieceIndexes.length === 1 ? "" : "s"} ${pieceIndexes.join(", ")}.`);
    });
  }, [bountyId, refreshDetail, runAction, selectedPieces, setStatusMessage, token]);

  const handleContentFileSelect = useCallback(async (event) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    setContentBytes(bytes);
    setContentFileName(file.name);
    setGeneratedProofs([]);
    setStatusMessage(`Loaded content file ${file.name}.`);
  }, [setStatusMessage]);

  const handleGenerateProofs = useCallback(() => {
    void runAction(async () => {
      if (!activeSession) {
        throw new Error("Open a verification session before generating proof.");
      }

      if (!contentBytes) {
        throw new Error("Load the recovered content file before generating proof.");
      }

      const { torrentBytes: loadedTorrentBytes } = await ensureTorrentMetadataLoaded();
      const proofs = [];

      for (const pieceIndex of activeSession.pieceIndexes) {
        const proof = await generatePieceProof({
          torrentBytes: loadedTorrentBytes,
          contentBytes,
          pieceIndex,
        });
        proofs.push(proof);
      }

      setGeneratedProofs(proofs);
      setStatusMessage(`Generated ${proofs.length} proof artifact${proofs.length === 1 ? "" : "s"} from ${contentFileName || "the selected file"}.`);
    });
  }, [activeSession, contentBytes, contentFileName, ensureTorrentMetadataLoaded, runAction, setStatusMessage]);

  const handleSubmitProofs = useCallback(() => {
    void runAction(async () => {
      if (!activeSession) {
        throw new Error("No verification session is active.");
      }

      if (generatedProofs.length === 0) {
        throw new Error("Generate proof artifacts before submitting them.");
      }

      await requestJson(`/verification-sessions/${activeSession.id}/proof`, {
        method: "POST",
        token,
        body: {
          proofArtifacts: {
            torrentInfoHash: bounty?.torrentInfoHash,
            torrentName: bounty?.torrentName ?? "torrent",
            proofs: generatedProofs,
          },
        },
      });
      await refreshDetail({ quiet: true });
      setStatusMessage("Submitted proof artifacts for requester review.");
    });
  }, [activeSession, bounty?.torrentInfoHash, bounty?.torrentName, generatedProofs, refreshDetail, runAction, setStatusMessage, token]);

  const handleRunBrowserVerification = useCallback(() => {
    void runAction(async () => {
      if (!activeSession?.proofArtifacts?.proofs?.length) {
        throw new Error("No submitted proof artifacts are available to verify.");
      }

      const { torrentMetadata: loadedTorrentMetadata } = await ensureTorrentMetadataLoaded();
      const results = activeSession.proofArtifacts.proofs.map((proof) => {
        const expectedPieceHashHex = loadedTorrentMetadata.pieces[proof.pieceIndex];
        const verification = verifyPieceProofFromRound({
          pieceHashHex: expectedPieceHashHex,
          revealRound: proof.revealRound,
          preBlockState: proof.preBlockState,
          roundRevealState: proof.roundRevealState,
          remainingScheduleWords: proof.remainingScheduleWords,
        });
        const metadataMatches = expectedPieceHashHex === String(proof.pieceHashHex).toLowerCase();

        return {
          pieceIndex: proof.pieceIndex,
          expectedPieceHashHex,
          proofPieceHashHex: proof.pieceHashHex,
          computedPieceHashHex: verification.computedPieceHashHex,
          valid: verification.valid && metadataMatches,
        };
      });

      setBrowserVerification(results);
      setStatusMessage(results.every((result) => result.valid) ? "Browser verification passed for all submitted pieces." : "Browser verification found one or more invalid pieces.");
    });
  }, [activeSession?.proofArtifacts?.proofs, ensureTorrentMetadataLoaded, runAction, setStatusMessage]);

  const handleConfirmProofVerification = useCallback(() => {
    void runAction(async () => {
      if (!activeSession) {
        throw new Error("No verification session is active.");
      }

      if (browserVerification.length === 0) {
        throw new Error("Run browser verification before confirming the proof.");
      }

      const verifiedPieceIndexes = browserVerification.filter((result) => result.valid).map((result) => result.pieceIndex);

      if (verifiedPieceIndexes.length === 0) {
        throw new Error("No valid pieces are available to confirm.");
      }

      await requestJson(`/verification-sessions/${activeSession.id}/verify`, {
        method: "POST",
        token,
        body: {
          verifiedPieceIndexes,
          verificationSummary: verificationSummary.trim() || "Browser-assisted verification",
        },
      });
      await refreshDetail({ quiet: true });
      setStatusMessage(`Marked ${verifiedPieceIndexes.length} piece${verifiedPieceIndexes.length === 1 ? "" : "s"} as verified.`);
    });
  }, [activeSession, browserVerification, refreshDetail, runAction, setStatusMessage, token, verificationSummary]);

  const handleCreateContract = useCallback(() => {
    void runAction(async () => {
      if (!activeSession) {
        throw new Error("Proof must be verified before creating a contract.");
      }

      const pieceIndexes = uniquePieceIndexes(activeSession.verifiedPieceIndexes);

      if (pieceIndexes.length === 0) {
        throw new Error("No verified pieces are available for a delivery contract.");
      }

      await requestJson(`/verification-sessions/${activeSession.id}/contracts`, {
        method: "POST",
        token,
        body: { pieceIndexes },
      });
      await refreshDetail({ quiet: true });
      setStatusMessage("Created the delivery contract and opened both bond escrows.");
    });
  }, [activeSession, refreshDetail, runAction, setStatusMessage, token]);

  const handleRegisterPayoutInvoice = useCallback(() => {
    void runAction(async () => {
      if (!activeContract) {
        throw new Error("A delivery contract is required before registering payout details.");
      }

      if (hasWebLn) {
        const invoice = await createInvoiceWithWebLn({
          amountSats: bounty?.rewardSats ?? 0,
          memo: `Bit Lazarus payout for ${activeContract.id}`,
        });

        await requestJson(`/contracts/${activeContract.id}/payout-invoice`, {
          method: "POST",
          token,
          body: {
            paymentRequest: invoice.paymentRequest,
          },
        });
      } else {
        await requestJson(`/contracts/${activeContract.id}/demo-payout-invoice`, {
          method: "POST",
          token,
        });
      }
      await refreshDetail({ quiet: true });
      setStatusMessage(hasWebLn ? "Registered the hunter payout invoice from your WebLN wallet." : "Created and registered the hunter payout invoice from Polar.");
    });
  }, [activeContract, bounty?.rewardSats, hasWebLn, refreshDetail, runAction, setStatusMessage, token]);

  const handlePayBond = useCallback(() => {
    void runAction(async () => {
      if (!activeContract || !currentBondEscrow?.funding?.paymentRequest) {
        throw new Error("Your bond invoice is not available.");
      }

      const paymentResult = hasWebLn
        ? await sendPaymentWithWebLn(currentBondEscrow.funding.paymentRequest, {
          timeoutMs: HOLD_INVOICE_TIMEOUT_MS,
        })
        : await requestJson(`/contracts/${activeContract.id}/demo-pay-bond`, {
          method: "POST",
          token,
        });

      if (hasWebLn) {
        await requestJson(`/contracts/${activeContract.id}/sync-bonds`, {
          method: "POST",
          token,
        });
      }
      await refreshDetail({ quiet: true });
      setStatusMessage(
        paymentResult.timedOut ?? paymentResult.payment?.timedOut
          ? "Bond payment requested. Syncing contract state..."
          : hasWebLn
            ? "Bond payment sent and synced."
            : "Bond payment sent from Polar and synced.",
      );
    });
  }, [activeContract, currentBondEscrow?.funding?.paymentRequest, hasWebLn, refreshDetail, runAction, setStatusMessage, token]);

  const handleSyncBonds = useCallback(() => {
    void runAction(async () => {
      if (!activeContract) {
        throw new Error("No delivery contract is active.");
      }

      await requestJson(`/contracts/${activeContract.id}/sync-bonds`, {
        method: "POST",
        token,
      });
      await refreshDetail({ quiet: true });
      setStatusMessage("Bond escrow state synced.");
    });
  }, [activeContract, refreshDetail, runAction, setStatusMessage, token]);

  const waitForResolvedContract = useCallback(async (contractId) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const payload = await requestJson(`/contracts/${contractId}`, { token });

      if (String(payload.contract.state ?? "").startsWith("RESOLVED_")) {
        return payload.contract;
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, 1500);
      });
    }

    return null;
  }, [token]);

  const handleCommitDeliveryHashAndSeed = useCallback(() => {
    void runAction(async () => {
      if (!activeContract) {
        throw new Error("No delivery contract is active.");
      }

      if (!contentBytes) {
        throw new Error("Load the recovered file before starting the WebTorrent seed.");
      }

      if (!canUseWebTorrentTransfer) {
        throw new Error("The backend WebTorrent tracker is not configured.");
      }

      const { torrentMetadata: loadedTorrentMetadata } = await ensureTorrentMetadataLoaded();

      if (!loadedTorrentMetadata?.name || !loadedTorrentMetadata?.pieceLength) {
        throw new Error("This torrent does not include enough metadata to reproduce the original swarm.");
      }

      if (loadedTorrentMetadata.totalLength !== contentBytes.byteLength) {
        throw new Error("The selected file size does not match the expected torrent payload size.");
      }

      const fileSha256 = await computeSha256Hex(contentBytes);

      await requestJson(`/contracts/${activeContract.id}/delivery-commitment`, {
        method: "POST",
        token,
        body: {
          fileSha256,
          fileName: contentFileName || loadedTorrentMetadata.name,
          fileSize: contentBytes.byteLength,
        },
      });

      if (hunterSeedTorrentRef.current) {
        await safelyRemoveTorrent(hunterSeedTorrentRef.current);
        hunterSeedTorrentRef.current = null;
      }

      setDeliverySeedStatus({
        phase: "starting",
        infoHash: bounty?.torrentInfoHash ?? null,
        peers: 0,
        uploadedBytes: 0,
        fileSha256,
      });

      const seedFile = new File([contentBytes], loadedTorrentMetadata.name, {
        type: "application/octet-stream",
      });
      const torrent = await seedTorrent(seedFile, {
        name: loadedTorrentMetadata.name,
        pieceLength: loadedTorrentMetadata.pieceLength,
        announce: trackerAnnounceUrls,
        private: loadedTorrentMetadata.isPrivate ? 1 : undefined,
        info: loadedTorrentMetadata.infoOverrides,
      });

      if (String(torrent.infoHash).toLowerCase() !== String(bounty?.torrentInfoHash ?? "").toLowerCase()) {
        await safelyRemoveTorrent(torrent);
        setDeliverySeedStatus((current) => ({
          ...current,
          phase: "error",
        }));
        throw new Error("The selected file does not reproduce the original torrent info hash.");
      }

      hunterSeedTorrentRef.current = torrent;

      const updateSeedStatus = () => {
        setDeliverySeedStatus((current) => ({
          ...current,
          phase: "seeding",
          infoHash: torrent.infoHash,
          peers: torrent.numPeers ?? 0,
          uploadedBytes: torrent.uploaded ?? current.uploadedBytes,
          fileSha256,
        }));
      };

      torrent.on("wire", updateSeedStatus);
      torrent.on("upload", updateSeedStatus);
      torrent.on("error", (error) => {
        setProtocolError(error.message ?? String(error));
        setDeliverySeedStatus((current) => ({
          ...current,
          phase: "error",
        }));
      });

      updateSeedStatus();
      await refreshDetail({ quiet: true });
      setStatusMessage("Committed the hunter file hash and started seeding over WebTorrent.");
    });
  }, [
    activeContract,
    bounty?.torrentInfoHash,
    canUseWebTorrentTransfer,
    contentBytes,
    contentFileName,
    ensureTorrentMetadataLoaded,
    refreshDetail,
    runAction,
    setStatusMessage,
    token,
    trackerAnnounceUrls,
  ]);

  const handleStartRequesterDownload = useCallback(() => {
    void runAction(async () => {
      if (!activeContract) {
        throw new Error("No delivery contract is active.");
      }

      if (!activeContract.hunterDeliveryFileSha256) {
        throw new Error("Wait for the hunter to commit the file hash before downloading.");
      }

      if (!canUseWebTorrentTransfer) {
        throw new Error("The backend WebTorrent tracker is not configured.");
      }

      const { torrentBytes: loadedTorrentBytes, torrentMetadata: loadedTorrentMetadata } = await ensureTorrentMetadataLoaded();

      if (requesterDownloadTorrentRef.current) {
        await safelyRemoveTorrent(requesterDownloadTorrentRef.current);
        requesterDownloadTorrentRef.current = null;
      }

      const expectedSha256 = activeContract.hunterDeliveryFileSha256;
      const contractId = activeContract.id;

      setDeliveryDownloadStatus({
        phase: "starting",
        infoHash: bounty?.torrentInfoHash ?? null,
        peers: 0,
        downloadedBytes: 0,
        progress: 0,
        expectedSha256,
        fileSha256: null,
      });

      const torrent = await addTorrent(loadedTorrentBytes, {
        announce: trackerAnnounceUrls,
      });
      requesterDownloadTorrentRef.current = torrent;

      const updateDownloadStatus = (phase = "downloading") => {
        setDeliveryDownloadStatus((current) => ({
          ...current,
          phase,
          infoHash: torrent.infoHash ?? current.infoHash,
          peers: torrent.numPeers ?? 0,
          downloadedBytes: torrent.downloaded ?? current.downloadedBytes,
          progress: torrent.progress ?? current.progress,
          expectedSha256,
        }));
      };

      torrent.on("wire", updateDownloadStatus);
      torrent.on("download", () => updateDownloadStatus("downloading"));
      torrent.on("error", (error) => {
        setProtocolError(error.message ?? String(error));
        setDeliveryDownloadStatus((current) => ({
          ...current,
          phase: "error",
        }));
      });

      torrent.on("done", async () => {
        try {
          updateDownloadStatus("verifying");
          const primaryFile = torrent.files?.[0];

          if (!primaryFile) {
            throw new Error("Downloaded torrent does not contain a file to verify.");
          }

          const fileBuffer = await primaryFile.arrayBuffer();
          const fileSha256 = await computeSha256Hex(fileBuffer);

          setDeliveryDownloadStatus((current) => ({
            ...current,
            phase: "confirming",
            progress: 1,
            downloadedBytes: loadedTorrentMetadata.totalLength ?? current.downloadedBytes,
            fileSha256,
          }));

          let latestContract = (await requestJson(`/contracts/${contractId}/delivery-confirmation`, {
            method: "POST",
            token,
            body: { fileSha256 },
          })).contract;

          if (latestContract.deliveryHashStatus === "MATCHED" && !String(latestContract.state ?? "").startsWith("RESOLVED_")) {
            latestContract = (await waitForResolvedContract(contractId)) ?? latestContract;
          }

          await refreshDetail({ quiet: true });
          setDeliveryDownloadStatus((current) => ({
            ...current,
            phase: latestContract.deliveryHashStatus === "MATCHED" ? "matched" : "mismatched",
            progress: 1,
            fileSha256,
          }));
          setStatusMessage(
            latestContract.deliveryHashStatus === "MATCHED"
              ? `Download complete. SHA-256 matched and contract ${latestContract.state}.`
              : "Download complete, but the requester hash did not match the hunter commitment.",
          );
        } catch (error) {
          setProtocolError(error.message ?? String(error));
          setDeliveryDownloadStatus((current) => ({
            ...current,
            phase: "error",
          }));
        }
      });

      updateDownloadStatus("downloading");
      setStatusMessage("Started the requester download from the hunter over WebTorrent.");
    });
  }, [
    activeContract,
    bounty?.torrentInfoHash,
    canUseWebTorrentTransfer,
    ensureTorrentMetadataLoaded,
    refreshDetail,
    runAction,
    setStatusMessage,
    token,
    trackerAnnounceUrls,
    waitForResolvedContract,
  ]);

  const handleSubmitReceipts = useCallback(() => {
    void runAction(async () => {
      if (!activeContract) {
        throw new Error("No delivery contract is active.");
      }

      if (outstandingReceiptPieceIndexes.length === 0) {
        throw new Error("All required receipts have already been submitted.");
      }

      let latestContract = activeContract;

      if (isCreator && hasBackendDemoReceipts && currentUser?.walletType === "bitcoin") {
        const payload = await requestJson(`/contracts/${activeContract.id}/demo-submit-receipts`, {
          method: "POST",
          token,
        });

        latestContract = payload.contract;
      } else {
        const { torrentMetadata: loadedTorrentMetadata } = await ensureTorrentMetadataLoaded();

        for (const pieceIndex of outstandingReceiptPieceIndexes) {
          const pieceHash = loadedTorrentMetadata.pieces[pieceIndex];
          const receiptMessage = `deliveryContractId=${activeContract.id}|pieceIndex=${pieceIndex}|pieceHash=${pieceHash}`;
          const receiptBody = {
            pieceIndex,
            receiptMessage,
            receiptSignerWalletAddress: currentUser?.walletAddress,
          };

          if (usingNostrIdentity) {
            const { signedEvent } = await createSignedNostrEvent({
              kind: 27235,
              content: receiptMessage,
              tags: [
                ["bit-lazarus", "piece-receipt"],
                ["contract", activeContract.id],
                ["piece", String(pieceIndex)],
              ],
            });
            receiptBody.receiptSignedEvent = signedEvent;
          } else if (usingWebLnIdentity) {
            receiptBody.receiptSignature = await signMessageWithWebLn(receiptMessage);
          } else {
            throw new Error("This browser session cannot sign receipts. Reconnect with a supported wallet provider.");
          }

          const payload = await requestJson(`/contracts/${activeContract.id}/receipts`, {
            method: "POST",
            token,
            body: receiptBody,
          });

          latestContract = payload.contract;
        }
      }

      if (!String(latestContract.state ?? "").startsWith("RESOLVED_")) {
        latestContract = (await waitForResolvedContract(activeContract.id)) ?? latestContract;
      }

      await refreshDetail({ quiet: true });
      setStatusMessage(String(latestContract.state ?? "").startsWith("RESOLVED_") ? `Contract ${latestContract.state} confirmed.` : "Receipts submitted. Waiting for final resolution.");
    });
  }, [
    activeContract,
    currentUser?.walletAddress,
    ensureTorrentMetadataLoaded,
    hasBackendDemoReceipts,
    isCreator,
    outstandingReceiptPieceIndexes,
    refreshDetail,
    runAction,
    setStatusMessage,
    token,
    usingNostrIdentity,
    usingWebLnIdentity,
    waitForResolvedContract,
  ]);

  useEffect(() => {
    if (
      !isCreator ||
      !hasBackendDemoReceipts ||
      currentUser?.walletType !== "bitcoin" ||
      activeContract?.state !== "DELIVERY_IN_PROGRESS" ||
      outstandingReceiptPieceIndexes.length === 0
    ) {
      return;
    }

    const nextKey = `${activeContract.id}:${outstandingReceiptPieceIndexes.join(",")}`;

    if (autoReceiptKey === nextKey) {
      return;
    }

    setAutoReceiptKey(nextKey);

    void (async () => {
      try {
        const payload = await requestJson(`/contracts/${activeContract.id}/demo-submit-receipts`, {
          method: "POST",
          token,
        });
        await refreshDetail({ quiet: true });
        setStatusMessage(
          String(payload.contract?.state ?? "").startsWith("RESOLVED_")
            ? `Contract ${payload.contract.state} confirmed.`
            : "Submitted requester receipts automatically from Polar.",
        );
      } catch (error) {
        setProtocolError(error.message ?? String(error));
        setAutoReceiptKey("");
      }
    })();
  }, [
    activeContract?.id,
    activeContract?.state,
    autoReceiptKey,
    currentUser?.walletType,
    hasBackendDemoReceipts,
    isCreator,
    outstandingReceiptPieceIndexes,
    refreshDetail,
    setStatusMessage,
    token,
  ]);

  if (!token) {
    return (
      <main className="page-main">
        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Bounty</p>
            <h2>Authentication required</h2>
          </div>
          <p className="muted-copy">Connect your wallet from Home to view this bounty.</p>
          <Link className="primary-button" to="/">
            Go to Home
          </Link>
        </section>
      </main>
    );
  }

  if (loadingDetail && !bounty) {
    return (
      <main className="page-main">
        <section className="glass-panel stack">
          <p className="muted-copy">Loading bounty…</p>
        </section>
      </main>
    );
  }

  if (loadError && !bounty) {
    return (
      <main className="page-main">
        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Bounty</p>
            <h2>Could not load</h2>
          </div>
          <p className="muted-copy">{loadError}</p>
          <Link className="secondary-button" to="/marketplace">
            Back to marketplace
          </Link>
        </section>
      </main>
    );
  }

  if (!bounty) {
    return (
      <main className="page-main">
        <section className="glass-panel stack">
          <p className="muted-copy">Bounty not found.</p>
          <Link className="secondary-button" to="/marketplace">
            Back to marketplace
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="page-main">
      <div className="detail-back">
        <Link className="secondary-button detail-back-link" to="/marketplace">
          ← Marketplace
        </Link>
      </div>

      <section className="glass-panel detail-panel">
        <BountyCard bounty={bounty} hideActions />
      </section>

      <section className="protocol-grid">
        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Workflow</p>
            <h2>{getProtocolHeadline({ bounty, activeSession, activeContract })}</h2>
          </div>

          <div className="chip-row">
            <span className="chip">Role: {currentRole}</span>
            <span className="chip">Wallet: {currentUser?.walletType ?? "unknown"}</span>
            <span className="chip">Escrow: {bounty.escrowStatus}</span>
            <span className="chip">Delivery: {bounty.deliveryStatus}</span>
            <span className="chip">Completion: {bounty.completionReadiness}</span>
          </div>

          {protocolError ? <p className="muted-copy">{protocolError}</p> : null}
          {loadError && bounty ? <p className="muted-copy">{loadError}</p> : null}

          <div className="protocol-list">
            <div className={`protocol-card${activeSession ? " is-active" : ""}`}>
              <span>Active session</span>
              <strong>{activeSession ? activeSession.status : "No verification session yet"}</strong>
              <small>{activeSession ? activeSession.id : "A joined hunter opens the proof session."}</small>
            </div>
            <div className={`protocol-card${activeContract ? " is-active" : ""}`}>
              <span>Active contract</span>
              <strong>{activeContract ? activeContract.state : "No contract yet"}</strong>
              <small>{activeContract ? activeContract.id : "Requester creates the contract after proof verification."}</small>
            </div>
          </div>

          {activeSession?.pieceIndexes?.length ? (
            <div className="protocol-subsection">
              <h3>Tracked pieces</h3>
              <div className="chip-row">
                {activeSession.pieceIndexes.map((pieceIndex) => (
                  <span className="chip" key={pieceIndex}>
                    Piece {pieceIndex}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {activeContract ? (
            <div className="detail-grid protocol-detail-grid">
              <div>
                <span>Requester bond</span>
                <strong>{activeContract.payerBondStatus}</strong>
              </div>
              <div>
                <span>Hunter bond</span>
                <strong>{activeContract.hunterBondStatus}</strong>
              </div>
              <div>
                <span>{usesTorrentHashDelivery ? "Delivery hash" : "Receipts"}</span>
                <strong>
                  {usesTorrentHashDelivery
                    ? activeContract.deliveryHashStatus
                    : `${receipts.length}/${activeContract.requiredReceipts}`}
                </strong>
              </div>
              <div>
                <span>Payout invoice</span>
                <strong>{activeContract.hunterPayoutPaymentRequest ? "Registered" : "Missing"}</strong>
              </div>
            </div>
          ) : null}

          {!canUseWebLnPayments ? (
            <p className="muted-copy">
              Lightning funding and payout actions on this page require either a WebLN wallet in this browser or a Polar demo backend configured on the server.
            </p>
          ) : null}
          {usesTorrentHashDelivery && !canUseWebTorrentTransfer ? (
            <p className="muted-copy">
              The backend WebTorrent tracker is not configured, so the hash-verified delivery phase cannot start in the browser.
            </p>
          ) : null}
          {!usesTorrentHashDelivery && !canSignReceipts ? (
            <p className="muted-copy">
              Receipt signing requires a supported identity provider, or a Polar demo receipt signer on the backend for Bitcoin-authenticated requester sessions.
            </p>
          ) : null}
        </section>

        <section className="glass-panel stack">
          {!isParticipant && !isCreator ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Join</p>
                <h3>Become the hunter</h3>
              </div>
              <p className="muted-copy">
                Join this bounty to open a verification session and submit proof from your browser.
              </p>
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={actionLoading || bounty.status !== "OPEN"}
                  onClick={handleJoinBounty}
                  type="button"
                >
                  Hunt bounty
                </button>
                <button
                  className="secondary-button"
                  disabled={actionLoading}
                  onClick={handleSyncEscrow}
                  type="button"
                >
                  Sync escrow
                </button>
              </div>
            </div>
          ) : null}

          {isCreator && bounty.escrowStatus === "AWAITING_FUNDING" ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Funding</p>
                <h3>Escrow still needs funding</h3>
              </div>
              <p className="muted-copy">
                Fund the bounty invoice to open the hunt. In demo mode the backend can pay it directly from the Polar requester node.
              </p>
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={actionLoading || !bounty.funding?.paymentRequest || !canUseWebLnPayments}
                  onClick={handleFundEscrow}
                  type="button"
                >
                  {hasWebLn ? "Pay escrow via WebLN" : "Fund escrow from Polar"}
                </button>
                <button
                  className="secondary-button"
                  disabled={actionLoading}
                  onClick={handleSyncEscrow}
                  type="button"
                >
                  Sync escrow
                </button>
              </div>
            </div>
          ) : null}

          {isJoinedHunter && bounty.status === "OPEN" && !activeSession ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Session</p>
                <h3>Open a verification session</h3>
              </div>
              <p className="muted-copy">
                Choose the missing pieces you can prove and start the browser-side proof flow.
              </p>
              <div className="piece-picker">
                {bounty.missingPieces.map((pieceIndex) => {
                  const checked = selectedPieces.includes(pieceIndex);

                  return (
                    <label className="piece-option" key={pieceIndex}>
                      <input
                        checked={checked}
                        onChange={(event) => {
                          setSelectedPieces((current) => (
                            event.target.checked
                              ? uniquePieceIndexes([...current, pieceIndex])
                              : current.filter((value) => value !== pieceIndex)
                          ));
                        }}
                        type="checkbox"
                      />
                      <span>Piece {pieceIndex}</span>
                    </label>
                  );
                })}
              </div>
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={actionLoading}
                  onClick={handleStartVerificationSession}
                  type="button"
                >
                  Start verification session
                </button>
              </div>
            </div>
          ) : null}

          {isJoinedHunter && activeSession?.status === "PROOF_CHALLENGE_OPEN" ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Hunter proof</p>
                <h3>Generate proof from the recovered file</h3>
              </div>
              <p className="muted-copy">
                Load the single-file torrent content in your browser, generate the SHA-1 round disclosure, then submit it for requester review.
              </p>
              <label className="field">
                <span>Recovered content file</span>
                <input accept="*" onChange={handleContentFileSelect} type="file" />
              </label>
              {contentFileName ? <p className="muted-copy">Loaded: {contentFileName}</p> : null}
              {generatedProofs.length > 0 ? (
                <div className="protocol-list">
                  {generatedProofs.map((proof) => (
                    <div className="protocol-card is-active" key={proof.pieceIndex}>
                      <span>Generated proof</span>
                      <strong>Piece {proof.pieceIndex}</strong>
                      <small>{proof.pieceHashHex}</small>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="button-row">
                <button
                  className="secondary-button"
                  disabled={actionLoading}
                  onClick={handleGenerateProofs}
                  type="button"
                >
                  Generate proof
                </button>
                <button
                  className="primary-button"
                  disabled={actionLoading || generatedProofs.length === 0}
                  onClick={handleSubmitProofs}
                  type="button"
                >
                  Submit proof
                </button>
              </div>
            </div>
          ) : null}

          {isCreator && activeSession?.status === "PROOF_SUBMITTED" ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Requester review</p>
                <h3>Verify the hunter proof in-browser</h3>
              </div>
              <p className="muted-copy">
                Recompute the disclosed SHA-1 suffix rounds in the browser, then confirm the valid pieces on-chain.
              </p>
              {browserVerification.length > 0 ? (
                <div className="protocol-list">
                  {browserVerification.map((result) => (
                    <div className={`protocol-card${result.valid ? " is-active" : ""}`} key={result.pieceIndex}>
                      <span>Piece {result.pieceIndex}</span>
                      <strong>{result.valid ? "Verified" : "Invalid"}</strong>
                      <small>{result.computedPieceHashHex}</small>
                    </div>
                  ))}
                </div>
              ) : null}
              <label className="field">
                <span>Verification summary</span>
                <textarea
                  onChange={(event) => setVerificationSummary(event.target.value)}
                  rows={3}
                  value={verificationSummary}
                />
              </label>
              <div className="button-row">
                <button
                  className="secondary-button"
                  disabled={actionLoading}
                  onClick={handleRunBrowserVerification}
                  type="button"
                >
                  Run browser verification
                </button>
                <button
                  className="primary-button"
                  disabled={actionLoading || !allProofsValid}
                  onClick={handleConfirmProofVerification}
                  type="button"
                >
                  Confirm verified pieces
                </button>
              </div>
            </div>
          ) : null}

          {isCreator && activeSession?.status === "PROOF_VERIFIED" && !activeContract ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Contract</p>
                <h3>Lock in delivery</h3>
              </div>
              <p className="muted-copy">
                Create the delivery contract to open the payer and hunter bond escrows for the verified pieces.
              </p>
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={actionLoading}
                  onClick={handleCreateContract}
                  type="button"
                >
                  Create delivery contract
                </button>
              </div>
            </div>
          ) : null}

          {isJoinedHunter && activeContract && !activeContract.hunterPayoutPaymentRequest ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Payout</p>
                <h3>Register your payout invoice</h3>
              </div>
              <p className="muted-copy">
                Create the hunter payout invoice for the {bounty.rewardSats.toLocaleString()} sat reward. In demo mode this comes directly from the Polar hunter node.
              </p>
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={actionLoading || !canCreatePayoutInvoice}
                  onClick={handleRegisterPayoutInvoice}
                  type="button"
                >
                  Create and register payout invoice
                </button>
              </div>
            </div>
          ) : null}

          {activeContract ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Bond</p>
                <h3>Collateral funding</h3>
              </div>
              <p className="muted-copy">
                Each side funds a bond hold invoice. In demo mode these payments are sent directly from the corresponding Polar nodes.
              </p>
              <div className="detail-grid protocol-detail-grid">
                <div>
                  <span>Your bond state</span>
                  <strong>
                    {currentUser?.id === activeContract.payerUserId
                      ? activeContract.payerBondStatus
                      : currentUser?.id === activeContract.hunterUserId
                        ? activeContract.hunterBondStatus
                        : "N/A"}
                  </strong>
                </div>
                <div>
                  <span>Invoice</span>
                  <strong>{currentBondEscrow?.funding?.paymentRequest ? "Ready" : "Unavailable"}</strong>
                </div>
              </div>
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={actionLoading || !currentBondEscrow?.funding?.paymentRequest || !canUseWebLnPayments}
                  onClick={handlePayBond}
                  type="button"
                >
                  {hasWebLn ? "Pay my bond" : "Pay my bond from Polar"}
                </button>
                <button
                  className="secondary-button"
                  disabled={actionLoading}
                  onClick={handleSyncBonds}
                  type="button"
                >
                  Sync bonds
                </button>
              </div>
            </div>
          ) : null}

          {isJoinedHunter && usesTorrentHashDelivery && activeContract?.state === "DELIVERY_IN_PROGRESS" ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Seed</p>
                <h3>Commit the file hash and start seeding</h3>
              </div>
              <p className="muted-copy">
                Load the recovered file, send its SHA-256 commitment to the backend, then seed the exact torrent payload to the requester over WebTorrent.
              </p>
              <label className="field">
                <span>Recovered content file</span>
                <input accept="*" onChange={handleContentFileSelect} type="file" />
              </label>
              {contentFileName ? <p className="muted-copy">Loaded: {contentFileName}</p> : null}
              {activeContract.hunterDeliveryFileSha256 ? (
                <div className="protocol-list">
                  <div className="protocol-card is-active">
                    <span>Committed hash</span>
                    <strong>{activeContract.deliveryHashStatus}</strong>
                    <small>{activeContract.hunterDeliveryFileSha256}</small>
                  </div>
                </div>
              ) : null}
              {deliverySeedStatus.phase !== "idle" ? (
                <div className="detail-grid protocol-detail-grid">
                  <div>
                    <span>Seed status</span>
                    <strong>{deliverySeedStatus.phase}</strong>
                  </div>
                  <div>
                    <span>Peers</span>
                    <strong>{deliverySeedStatus.peers}</strong>
                  </div>
                  <div>
                    <span>Uploaded</span>
                    <strong>{deliverySeedStatus.uploadedBytes.toLocaleString()} bytes</strong>
                  </div>
                  <div>
                    <span>Info hash</span>
                    <strong>{deliverySeedStatus.infoHash ?? "pending"}</strong>
                  </div>
                </div>
              ) : null}
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={actionLoading || !contentBytes || !canUseWebTorrentTransfer}
                  onClick={handleCommitDeliveryHashAndSeed}
                  type="button"
                >
                  {activeContract.hunterDeliveryFileSha256 ? "Recommit hash and reseed" : "Commit hash and start seeding"}
                </button>
              </div>
            </div>
          ) : null}

          {isCreator && usesTorrentHashDelivery && activeContract?.state === "DELIVERY_IN_PROGRESS" ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Download</p>
                <h3>Download from the hunter and confirm the SHA-256</h3>
              </div>
              <p className="muted-copy">
                Once the hunter commits a file hash, start the WebTorrent download. The browser will hash the completed file and submit the result to the contract automatically.
              </p>
              <div className="detail-grid protocol-detail-grid">
                <div>
                  <span>Hunter hash</span>
                  <strong>{activeContract.hunterDeliveryFileSha256 ? "Committed" : "Waiting"}</strong>
                </div>
                <div>
                  <span>Download status</span>
                  <strong>{deliveryDownloadStatus.phase}</strong>
                </div>
                <div>
                  <span>Progress</span>
                  <strong>{formatPercent(deliveryDownloadStatus.progress)}</strong>
                </div>
                <div>
                  <span>Peers</span>
                  <strong>{deliveryDownloadStatus.peers}</strong>
                </div>
              </div>
              {deliveryDownloadStatus.fileSha256 ? (
                <div className="protocol-list">
                  <div className={`protocol-card${deliveryDownloadStatus.phase === "matched" ? " is-active" : ""}`}>
                    <span>Requester hash</span>
                    <strong>{deliveryDownloadStatus.phase === "matched" ? "Matched" : deliveryDownloadStatus.phase === "mismatched" ? "Mismatched" : "Computed"}</strong>
                    <small>{deliveryDownloadStatus.fileSha256}</small>
                  </div>
                </div>
              ) : null}
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={actionLoading || !activeContract.hunterDeliveryFileSha256 || !canUseWebTorrentTransfer}
                  onClick={handleStartRequesterDownload}
                  type="button"
                >
                  Start requester download
                </button>
              </div>
            </div>
          ) : null}

          {isCreator && !usesTorrentHashDelivery && activeContract?.state === "DELIVERY_IN_PROGRESS" ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Receipt</p>
                <h3>{isCreator && hasBackendDemoReceipts && currentUser?.walletType === "bitcoin" ? "Automatic delivery receipts" : "Sign the delivery receipt"}</h3>
              </div>
              <p className="muted-copy">
                {isCreator && hasBackendDemoReceipts && currentUser?.walletType === "bitcoin"
                  ? "Receipts are auto-signed with the requester Polar/Bitcoin wallet once delivery is live. No extra confirmation step is required in demo mode."
                  : "Submit one signed receipt for each verified piece. This works with Nostr-signed receipts for Nostr sessions and WebLN message signatures for Lightning-signature sessions."}
              </p>
              {outstandingReceiptPieceIndexes.length > 0 ? (
                <div className="chip-row">
                  {outstandingReceiptPieceIndexes.map((pieceIndex) => (
                    <span className="chip" key={pieceIndex}>
                      Outstanding receipt: piece {pieceIndex}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted-copy">All required receipts have already been submitted.</p>
              )}
              {!(isCreator && hasBackendDemoReceipts && currentUser?.walletType === "bitcoin") ? (
                <div className="button-row">
                  <button
                    className="primary-button"
                    disabled={actionLoading || outstandingReceiptPieceIndexes.length === 0 || !canSignReceipts}
                    onClick={handleSubmitReceipts}
                    type="button"
                  >
                    Sign and submit receipts
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeContract && String(activeContract.state).startsWith("RESOLVED_") ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Resolved</p>
                <h3>{activeContract.state}</h3>
              </div>
              <p className="muted-copy">
                Contract resolution is complete. The protocol backend marked this bounty as {activeContract.state}.
              </p>
              {rewardEscrow?.settlement?.disbursement ? (
                <div className="detail-grid protocol-detail-grid">
                  <div>
                    <span>Reward disbursement</span>
                    <strong>{rewardEscrow.settlement.disbursement.status}</strong>
                  </div>
                  <div>
                    <span>Escrow state</span>
                    <strong>{rewardEscrow.status}</strong>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {!isParticipant ? (
            <p className="muted-copy">
              Join the hunt to unlock protocol actions. Requesters can also monitor the same bounty from their own wallet session.
            </p>
          ) : null}
        </section>
      </section>
    </main>
  );
}
