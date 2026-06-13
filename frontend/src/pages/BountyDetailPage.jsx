import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import BountyCard from "../components/BountyCard.jsx";
import { requestBytes, requestJson } from "../lib/api.js";
import { getArcBountyByInfoHash, getArcConfig, sendPreparedArcTransaction } from "../lib/arc-actions.js";
import { useApp } from "../context/AppContext.jsx";
import { computeSha256Hex } from "../lib/sha256.js";
import { downloadArchiveResource, uploadWalrusBlob } from "../lib/walrus.js";
import {
  addTorrent,
  destroyWebTorrentClient,
  loadTorrentData,
  removeTorrent,
} from "../lib/webtorrent-client.js";
import { parseTorrentFile } from "../lib/torrent-parser.js";

const POLL_INTERVAL_MS = 3000;

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

function getProtocolHeadline({ bounty, activeContract, hunterCount }) {
  if (!bounty) {
    return "Loading workflow";
  }

  if (String(activeContract?.state ?? "").startsWith("RESOLVED_")) {
    return "Resolution complete";
  }

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

  if (bounty.escrowStatus === "AWAITING_FUNDING") {
    return "Fund the Arc bounty escrow";
  }

  if (bounty.status === "OPEN" && hunterCount > 0) {
    return "Create the delivery contract";
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

function formatPercent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function getTrackerAnnounceUrls(health) {
  const announceUrls = Array.isArray(health?.webTorrent?.announceUrls) ? health.webTorrent.announceUrls : [];
  return [...new Set(announceUrls.filter((value) => typeof value === "string" && value.trim()))];
}

function getExpectedTorrentPayloadSize(torrentMetadata) {
  if (!torrentMetadata) {
    return null;
  }

  if (Array.isArray(torrentMetadata.files) && torrentMetadata.files.length === 1) {
    return Number(torrentMetadata.files[0]?.length ?? 0);
  }

  if (Number.isFinite(torrentMetadata.totalSize)) {
    return Number(torrentMetadata.totalSize);
  }

  return null;
}

function getArchiveFilename(bounty, activeContract) {
  const firstFile = bounty?.torrentMeta?.files?.[0]?.path;
  return (
    activeContract?.hunterDeliveryFileName ||
    firstFile ||
    bounty?.torrentName ||
    bounty?.torrentMeta?.name ||
    "bit-lazarus-archive.bin"
  );
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
  const { token, currentUser, mergeBounty, bounties, health, setStatusMessage } = useApp();
  const [bounty, setBounty] = useState(() => bounties.find((record) => record.id === bountyId) ?? null);
  const [contracts, setContracts] = useState([]);
  const [torrentBytes, setTorrentBytes] = useState(null);
  const [torrentMetadata, setTorrentMetadata] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [protocolError, setProtocolError] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedHunterUserId, setSelectedHunterUserId] = useState("");
  const [contentFileName, setContentFileName] = useState("");
  const [contentBytes, setContentBytes] = useState(null);
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
  const [downloadedFileBlob, setDownloadedFileBlob] = useState(null);
  const [downloadedFileUrl, setDownloadedFileUrl] = useState(null);
  const [downloadedFileName, setDownloadedFileName] = useState("");
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
    setContentBytes(null);
    setContentFileName("");
  }, [bountyId]);

  const bountyHunters = Array.isArray(bounty?.hunters) ? bounty.hunters : [];
  const isCreator = bounty?.creatorUserId === currentUser?.id;
  const isJoinedHunter = Boolean(currentUser && bountyHunters.some((hunter) => hunter.userId === currentUser.id));
  const isParticipant = Boolean(token && currentUser && (isCreator || isJoinedHunter));
  const trackerAnnounceUrls = useMemo(() => getTrackerAnnounceUrls(health), [health]);
  const canUseWebTorrentTransfer = trackerAnnounceUrls.length > 0;
  const activeContract = useMemo(
    () => getLatestById(contracts, bounty?.activeContractIds ?? []),
    [contracts, bounty?.activeContractIds],
  );
  const activeHunter = useMemo(() => {
    if (activeContract) {
      return bountyHunters.find((hunter) => hunter.userId === activeContract.hunterUserId) ?? null;
    }

    return bountyHunters.find((hunter) => hunter.userId === selectedHunterUserId) ?? bountyHunters[0] ?? null;
  }, [activeContract, bountyHunters, selectedHunterUserId]);
  const currentRole = formatProtocolRole({ bounty, currentUser, isJoinedHunter });
  const isActiveRequester = activeContract?.payerUserId === currentUser?.id;
  const isActiveHunter = activeContract?.hunterUserId === currentUser?.id;
  const requesterDownloadedFileName = downloadedFileName || activeContract?.hunterDeliveryFileName || "recovered-file.bin";
  const contractResolved = String(activeContract?.state ?? "").startsWith("RESOLVED_");
  const archiveDownloadAvailable = bounty?.status === "COMPLETED" || activeContract?.state === "RESOLVED_SUCCESS";
  const shouldPoll = Boolean(
    token &&
      bountyId &&
      currentUser &&
      bounty &&
      (isCreator || isJoinedHunter) &&
      !contractResolved &&
      bounty.status !== "CANCELED",
  );

  useEffect(() => {
    if (activeContract || bountyHunters.length === 0) {
      return;
    }

    if (!selectedHunterUserId || !bountyHunters.some((hunter) => hunter.userId === selectedHunterUserId)) {
      setSelectedHunterUserId(bountyHunters[0].userId);
    }
  }, [activeContract, bountyHunters, selectedHunterUserId]);

  const ensureTorrentMetadataLoaded = useCallback(async () => {
    if (torrentBytes && torrentMetadata) {
      return { torrentBytes, torrentMetadata };
    }

    if (!bounty?.hasTorrentFile) {
      throw new Error("This bounty was created without a .torrent file. Browser delivery requires the torrent file.");
    }

    const bytes = await requestBytes(`/bounties/${bounty.id}/torrent`, { token });
    const metadata = await parseTorrentFile(bytes);

    setTorrentBytes(bytes);
    setTorrentMetadata(metadata);
    return {
      torrentBytes: bytes,
      torrentMetadata: metadata,
    };
  }, [bounty, token, torrentBytes, torrentMetadata]);

  const refreshDetail = useCallback(async ({ quiet = false } = {}) => {
    if (!token || !bountyId) {
      return null;
    }

    if (!quiet) {
      setLoadingDetail(true);
      setLoadError(null);
      setProtocolError(null);
    }

    try {
      const bountyPayload = await requestJson(`/bounties/${bountyId}`, { token });
      const nextBounty = bountyPayload.bounty;
      setBounty(nextBounty);
      mergeBounty(nextBounty);

      const canViewProtocol = Boolean(
        currentUser &&
          (nextBounty.creatorUserId === currentUser.id ||
            (Array.isArray(nextBounty.hunters) ? nextBounty.hunters : []).some((hunter) => hunter.userId === currentUser.id)),
      );

      if (!canViewProtocol) {
        setContracts([]);
        return nextBounty;
      }

      const contractPayload = await requestJson(`/bounties/${bountyId}/contracts`, { token });
      const nextContracts = [...contractPayload.contracts].sort(sortNewestFirst);
      setContracts(nextContracts);

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
    setDownloadedFileName("");
    setDownloadedFileBlob(null);
    setDownloadedFileUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }

      return null;
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
        quiet: true,
      });
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshDetail, shouldPoll]);

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

  const handleJoinBounty = useCallback(() => {
    void runAction(async () => {
      const arcConfig = await getArcConfig();
      const arcBounty = await getArcBountyByInfoHash({
        token,
        torrentInfoHash: bounty.torrentInfoHash,
      });
      const transactionPayload = await requestJson("/arc/transactions/claim-bounty", {
        method: "POST",
        token,
        body: { bountyId: arcBounty.bountyId },
      });

      setStatusMessage("Claiming the Arc bounty.");
      await sendPreparedArcTransaction({
        arcConfig,
        transaction: transactionPayload.transaction,
      });

      const payload = await requestJson(`/bounties/${bountyId}/hunt`, {
        method: "POST",
        token,
      });
      setBounty(payload.bounty);
      mergeBounty(payload.bounty);
      await refreshDetail({ quiet: true });
      setStatusMessage("Joined bounty as a hunter.");
    });
  }, [bounty?.torrentInfoHash, bountyId, mergeBounty, refreshDetail, runAction, setStatusMessage, token]);

  const handleCreateContract = useCallback(() => {
    void runAction(async () => {
      const hunterUserId = activeHunter?.userId ?? selectedHunterUserId;

      if (!hunterUserId) {
        throw new Error("A joined hunter is required before a delivery contract can be created.");
      }

      await requestJson(`/bounties/${bountyId}/contracts`, {
        method: "POST",
        token,
        body: { hunterUserId },
      });
      await refreshDetail({ quiet: true });
      setStatusMessage("Created the delivery contract.");
    });
  }, [activeHunter?.userId, bountyId, refreshDetail, runAction, selectedHunterUserId, setStatusMessage, token]);

  const handleContentFileSelect = useCallback(async (event) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    setContentBytes(bytes);
    setContentFileName(file.name);
    setStatusMessage(`Loaded content file ${file.name}.`);
  }, [setStatusMessage]);

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

      const {
        torrentBytes: loadedTorrentBytes,
        torrentMetadata: loadedTorrentMetadata,
      } = await ensureTorrentMetadataLoaded();

      if (!loadedTorrentMetadata?.name || !loadedTorrentMetadata?.pieceLength) {
        throw new Error("This torrent does not include enough metadata to reproduce the original swarm.");
      }

      if (Array.isArray(loadedTorrentMetadata.files) && loadedTorrentMetadata.files.length > 1) {
        throw new Error("Browser seeding currently supports single-file torrents.");
      }

      const expectedPayloadSize = getExpectedTorrentPayloadSize(loadedTorrentMetadata);

      if (!Number.isFinite(expectedPayloadSize) || expectedPayloadSize <= 0) {
        throw new Error("Could not determine the expected payload size from the torrent metadata.");
      }

      if (expectedPayloadSize !== contentBytes.byteLength) {
        throw new Error(
          `The selected file size (${contentBytes.byteLength} bytes) does not match the expected torrent payload size (${expectedPayloadSize} bytes).`,
        );
      }

      const fileSha256 = await computeSha256Hex(contentBytes);
      const arcConfig = await getArcConfig();
      const arcBounty = await getArcBountyByInfoHash({
        token,
        torrentInfoHash: bounty.torrentInfoHash,
      });
      const transactionPayload = await requestJson("/arc/transactions/submit-delivery", {
        method: "POST",
        token,
        body: {
          bountyId: arcBounty.bountyId,
          deliveryHash: fileSha256,
          walrusBlobId: "",
        },
      });

      setStatusMessage("Submitting delivery hash to Arc.");
      await sendPreparedArcTransaction({
        arcConfig,
        transaction: transactionPayload.transaction,
      });

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
      const torrent = await addTorrent(loadedTorrentBytes, {
        announce: trackerAnnounceUrls,
      });

      if (String(torrent.infoHash).toLowerCase() !== String(bounty?.torrentInfoHash ?? "").toLowerCase()) {
        await safelyRemoveTorrent(torrent);
        setDeliverySeedStatus((current) => ({
          ...current,
          phase: "error",
        }));
        throw new Error("The selected file does not reproduce the original torrent info hash.");
      }

      await loadTorrentData(torrent, seedFile);

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
      setDownloadedFileName("");
      setDownloadedFileBlob(null);
      setDownloadedFileUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return null;
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

      torrent.on("wire", () => updateDownloadStatus("downloading"));
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
          const fileBlob = new Blob([fileBuffer], { type: "application/octet-stream" });
          const nextDownloadUrl = URL.createObjectURL(fileBlob);
          const nextDownloadName = activeContract.hunterDeliveryFileName || primaryFile.name || loadedTorrentMetadata.name;

          setDownloadedFileBlob(fileBlob);
          setDownloadedFileUrl((current) => {
            if (current) {
              URL.revokeObjectURL(current);
            }

            return nextDownloadUrl;
          });
          setDownloadedFileName(nextDownloadName);

          setDeliveryDownloadStatus((current) => ({
            ...current,
            phase: "confirming",
            progress: 1,
            downloadedBytes: getExpectedTorrentPayloadSize(loadedTorrentMetadata) ?? current.downloadedBytes,
            fileSha256,
          }));

          let walrusUpload = null;
          if (fileSha256 === expectedSha256) {
            setStatusMessage("Uploading verified file to Walrus.");
            walrusUpload = await uploadWalrusBlob({
              token,
              blob: fileBlob,
            });

            const arcConfig = await getArcConfig();
            const arcBounty = await getArcBountyByInfoHash({
              token,
              torrentInfoHash: bounty.torrentInfoHash,
            });
            const transactionPayload = await requestJson("/arc/transactions/confirm-delivery", {
              method: "POST",
              token,
              body: {
                bountyId: arcBounty.bountyId,
                walrusBlobId: walrusUpload.blobId,
              },
            });

            setStatusMessage("Confirming delivery and Walrus archive on Arc.");
            await sendPreparedArcTransaction({
              arcConfig,
              transaction: transactionPayload.transaction,
            });
          }

          let latestContract = (await requestJson(`/contracts/${contractId}/delivery-confirmation`, {
            method: "POST",
            token,
            body: { fileSha256 },
          })).contract;

          if (latestContract.deliveryHashStatus === "MATCHED" && !String(latestContract.state ?? "").startsWith("RESOLVED_")) {
            latestContract = (await waitForResolvedContract(contractId)) ?? latestContract;
          }

          if (latestContract.deliveryHashStatus === "MATCHED" && walrusUpload?.blobId) {
            await requestJson(`/resources/${bounty.torrentInfoHash}/archive`, {
              method: "POST",
              token,
              body: {
                contractId,
                walrusBlobId: walrusUpload.blobId,
                walrusObjectId: walrusUpload.objectId ?? null,
              },
            });
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
              ? `Download complete. SHA-256 matched, archived to Walrus, and contract ${latestContract.state}.`
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

  const handleDownloadRecoveredFile = useCallback(() => {
    if (!downloadedFileBlob && !downloadedFileUrl) {
      return;
    }

    const downloadUrl = downloadedFileBlob ? URL.createObjectURL(downloadedFileBlob) : downloadedFileUrl;
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = requesterDownloadedFileName;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    if (downloadedFileBlob) {
      window.setTimeout(() => {
        URL.revokeObjectURL(downloadUrl);
      }, 1000);
    }
  }, [downloadedFileBlob, downloadedFileUrl, requesterDownloadedFileName]);

  const handleDownloadArchivedFile = useCallback(() => {
    void runAction(async () => {
      setStatusMessage("Resolving ENS resource and downloading Walrus archive.");
      await downloadArchiveResource({
        token,
        torrentInfoHash: bounty.torrentInfoHash,
        filename: getArchiveFilename(bounty, activeContract),
      });
      setStatusMessage("Archive download started.");
    });
  }, [activeContract, bounty, runAction, setStatusMessage, token]);

  const activeHunterLabel = activeHunter?.userId ?? "No hunter selected";

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
            <h2>{getProtocolHeadline({ bounty, activeContract, hunterCount: bountyHunters.length })}</h2>
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
            <div className={`protocol-card${bountyHunters.length > 0 ? " is-active" : ""}`}>
              <span>Joined hunters</span>
              <strong>{bountyHunters.length}</strong>
              <small>{activeHunterLabel}</small>
            </div>
            <div className={`protocol-card${activeContract ? " is-active" : ""}`}>
              <span>Active contract</span>
              <strong>{activeContract ? activeContract.state : "No contract yet"}</strong>
              <small>{activeContract ? activeContract.id : "Requester creates the contract after a hunter joins."}</small>
            </div>
          </div>

          {activeContract ? (
            <div className="detail-grid protocol-detail-grid">
              <div>
                <span>Delivery hash</span>
                <strong>{activeContract.deliveryHashStatus}</strong>
              </div>
              <div>
                <span>Reward</span>
                <strong>
                  {Number.isFinite(activeContract.rewardAmountUnits)
                    ? `${(activeContract.rewardAmountUnits / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${activeContract.rewardToken ?? "USDC"}`
                    : activeContract.rewardToken ?? "USDC"}
                </strong>
              </div>
            </div>
          ) : null}

          {!canUseWebTorrentTransfer ? (
            <p className="muted-copy">
              The backend WebTorrent tracker is not configured, so the hash-verified delivery phase cannot start in the browser.
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
                Join this bounty to enter the delivery flow.
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
                Arc escrow funding is the next integration point. Once the Arc contract reports the bounty as funded,
                this bounty can open for hunters.
              </p>
            </div>
          ) : null}

          {isCreator && bounty.status === "OPEN" && !activeContract && bountyHunters.length === 0 ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Waiting</p>
                <h3>No hunter has joined yet</h3>
              </div>
              <p className="muted-copy">
                Once a hunter joins, create the delivery contract.
              </p>
            </div>
          ) : null}

          {isCreator && bounty.status === "OPEN" && !activeContract && bountyHunters.length > 0 ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Contract</p>
                <h3>Choose the hunter and lock in delivery</h3>
              </div>
              <p className="muted-copy">
                The requester and hunter will use final SHA-256 verification before archiving to Walrus.
              </p>
              <label className="field">
                <span>Hunter</span>
                <select
                  onChange={(event) => setSelectedHunterUserId(event.target.value)}
                  value={selectedHunterUserId}
                >
                  {bountyHunters.map((hunter) => (
                    <option key={hunter.userId} value={hunter.userId}>
                      {hunter.userId}
                    </option>
                  ))}
                </select>
              </label>
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={actionLoading || !selectedHunterUserId}
                  onClick={handleCreateContract}
                  type="button"
                >
                  Create delivery contract
                </button>
              </div>
            </div>
          ) : null}

          {isJoinedHunter && !activeContract && bounty.status === "OPEN" ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Waiting</p>
                <h3>Requester must create the contract</h3>
              </div>
              <p className="muted-copy">
                The requester will choose a hunter and create the delivery contract before delivery starts.
              </p>
            </div>
          ) : null}

          {isActiveHunter && activeContract?.state === "DELIVERY_IN_PROGRESS" ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Hunter delivery</p>
                <h3>Seed the recovered file</h3>
              </div>
              <p className="muted-copy">
                Load the recovered file, commit its SHA-256 to the backend, then seed it over WebTorrent to the requester.
              </p>
              <label className="field">
                <span>Recovered content file</span>
                <input accept="*" onChange={handleContentFileSelect} type="file" />
              </label>
              {contentFileName ? <p className="muted-copy">Loaded: {contentFileName}</p> : null}
              <div className="detail-grid protocol-detail-grid">
                <div>
                  <span>Status</span>
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
              </div>
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={actionLoading || !contentBytes || !canUseWebTorrentTransfer}
                  onClick={handleCommitDeliveryHashAndSeed}
                  type="button"
                >
                  Commit hash and start seeding
                </button>
              </div>
            </div>
          ) : null}

          {isActiveRequester && activeContract?.state === "DELIVERY_IN_PROGRESS" ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Requester delivery</p>
                <h3>Download and verify the recovered file</h3>
              </div>
              <p className="muted-copy">
                Download the file from the hunter over WebTorrent. The browser will hash it and send the SHA-256 back to the backend for final settlement.
              </p>
              <div className="detail-grid protocol-detail-grid">
                <div>
                  <span>Status</span>
                  <strong>{deliveryDownloadStatus.phase}</strong>
                </div>
                <div>
                  <span>Peers</span>
                  <strong>{deliveryDownloadStatus.peers}</strong>
                </div>
                <div>
                  <span>Progress</span>
                  <strong>{formatPercent(deliveryDownloadStatus.progress)}</strong>
                </div>
                <div>
                  <span>Downloaded</span>
                  <strong>{deliveryDownloadStatus.downloadedBytes.toLocaleString()} bytes</strong>
                </div>
              </div>
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

          {downloadedFileBlob || downloadedFileUrl ? (
            <div className="protocol-subsection">
              <div className="panel-head">
                <p className="eyebrow">Download</p>
                <h3>Recovered file ready</h3>
              </div>
              <p className="muted-copy">
                The recovered file is stored in this browser session and can be saved locally.
              </p>
              <div className="button-row">
                <button
                  className="primary-button"
                  onClick={handleDownloadRecoveredFile}
                  type="button"
                >
                  Download recovered file
                </button>
              </div>
            </div>
          ) : null}

          <div className="protocol-subsection">
            <div className="panel-head">
              <p className="eyebrow">Archive</p>
              <h3>Download from ENS/Walrus</h3>
            </div>
            <p className="muted-copy">
              Resolve the torrent infohash resource and save the archived recovered file from Walrus.
            </p>
            <div className="button-row">
              <button
                className="secondary-button"
                disabled={actionLoading || !archiveDownloadAvailable}
                onClick={handleDownloadArchivedFile}
                type="button"
              >
                Download archived file
              </button>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
