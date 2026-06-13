import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { formatBytes, parseTorrentFile, torrentToBase64 } from "../lib/torrent-parser.js";
import { requestJson } from "../lib/api.js";
import {
  findArcBountyByInfoHash,
  getArcBountyByInfoHash,
  getArcConfig,
  sendPreparedArcTransaction,
} from "../lib/arc-actions.js";
import { requestWalletAddress, signWalletMessage } from "../lib/wallet-auth.js";

const AppContext = createContext(null);

export function useApp() {
  const value = useContext(AppContext);

  if (!value) {
    throw new Error("useApp must be used within AppProvider");
  }

  return value;
}

export function AppProvider({ children }) {
  const [health, setHealth] = useState(null);
  const [statusMessage, setStatusMessage] = useState("Booting Bit Lazarus...");
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState(() => window.localStorage.getItem("bit-lazarus-token") ?? "");
  const [currentUser, setCurrentUser] = useState(null);
  const [bounties, setBounties] = useState([]);
  const [loading, setLoading] = useState(false);
  const [torrentMeta, setTorrentMeta] = useState(null);
  const [torrentBase64, setTorrentBase64] = useState(null);
  const [rewardAmountUsdc, setRewardAmountUsdc] = useState("25");
  const [bountyDescription, setBountyDescription] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const refreshBounties = useCallback(async () => {
    if (!token) {
      return;
    }

    try {
      const payload = await requestJson("/bounties", { token });
      startTransition(() => {
        setBounties(payload.bounties);
      });
    } catch (error) {
      setStatusMessage(error.message);
    }
  }, [token]);

  useEffect(() => {
    requestJson("/health")
      .then((payload) => {
        setHealth(payload);
      })
      .catch((error) => {
        setStatusMessage(error.message);
      });
  }, []);

  useEffect(() => {
    if (!token) {
      setCurrentUser(null);
      setBounties([]);
      window.localStorage.removeItem("bit-lazarus-token");
      return;
    }

    window.localStorage.setItem("bit-lazarus-token", token);

    requestJson("/users/me", { token })
      .then((payload) => {
        startTransition(() => {
          setCurrentUser(payload.user);
          setStatusMessage(`Session active for ${payload.user.ensName ?? payload.user.walletAddress}`);
        });
      })
      .catch((error) => {
        setToken("");
        setStatusMessage(error.message);
      });

    requestJson("/bounties", { token })
      .then((payload) => {
        startTransition(() => {
          setBounties(payload.bounties);
        });
      })
      .catch((error) => {
        setStatusMessage(error.message);
      });
  }, [token]);

  async function handleWalletLogin(event) {
    event.preventDefault();
    setLoading(true);

    try {
      setStatusMessage("Requesting wallet account.");
      const walletAddress = await requestWalletAddress();
      const challengePayload = await requestJson("/auth/challenges", {
        method: "POST",
        body: {
          walletAddress,
        },
      });

      setStatusMessage("Waiting for wallet signature.");
      const nextSignature = await signWalletMessage({
        walletAddress,
        message: challengePayload.challenge.message,
      });

      const payload = await requestJson("/auth/verify", {
        method: "POST",
        body: {
          challengeId: challengePayload.challenge.id,
          walletAddress,
          signature: nextSignature,
          displayName,
        },
      });
      setToken(payload.session.token);
      setStatusMessage(`Connected as ${payload.user.ensName ?? payload.user.displayName ?? payload.user.walletAddress}`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  const handleTorrentFile = useCallback(async (file) => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const meta = await parseTorrentFile(arrayBuffer);
      setTorrentMeta(meta);
      setTorrentBase64(torrentToBase64(arrayBuffer));
      setStatusMessage(`Parsed ${meta.name} (${meta.pieceCount} pieces, ${formatBytes(meta.totalSize)})`);
    } catch (error) {
      setStatusMessage(`Failed to parse torrent: ${error.message}`);
      setTorrentMeta(null);
      setTorrentBase64(null);
    }
  }, []);

  function handleDrop(event) {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer?.files?.[0];

    if (file) {
      void handleTorrentFile(file);
    }
  }

  function handleFileSelect(event) {
    const file = event.target.files?.[0];

    if (file) {
      void handleTorrentFile(file);
    }
  }

  function clearTorrent() {
    setTorrentMeta(null);
    setTorrentBase64(null);
  }

  async function handleCreateBounty(event, { onCreated, onArchiveHit } = {}) {
    event?.preventDefault();

    if (!torrentMeta) {
      setStatusMessage("Upload a .torrent file first.");
      return null;
    }

    setLoading(true);

    try {
      const rewardAmount = Number.parseFloat(rewardAmountUsdc);

      if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
        throw new Error("Reward must be a positive USDC amount.");
      }

      const rewardAmountUnits = Math.round(rewardAmount * 1_000_000);
      const resourcePayload = await requestJson(`/resources/${torrentMeta.infoHash}/resolve`, {
        token,
      });

      if (resourcePayload.resolution?.mode === "walrus") {
        setStatusMessage(`Archive already exists at ${resourcePayload.resolution.ensName}.`);

        if (typeof onArchiveHit === "function") {
          await onArchiveHit(resourcePayload.resolution);
        }

        return null;
      }

      const existingArcBounty = await findArcBountyByInfoHash({
        token,
        torrentInfoHash: torrentMeta.infoHash,
      });

      if (existingArcBounty) {
        const existingLocalBounty = bounties.find((record) => record.torrentInfoHash === torrentMeta.infoHash);

        if (existingLocalBounty && typeof onCreated === "function") {
          onCreated(existingLocalBounty);
        }

        setStatusMessage(
          `Arc bounty ${existingArcBounty.bountyId} already exists for this torrent (${existingArcBounty.contractStatus}).`,
        );
        return null;
      }

      const arcConfig = await getArcConfig();
      const transactionPayload = await requestJson("/arc/transactions/create-bounty", {
        method: "POST",
        token,
        body: {
          torrentInfoHash: torrentMeta.infoHash,
          rewardAmountUnits,
          spec: bountyDescription || `Bounty for ${torrentMeta.name}`,
        },
      });

      setStatusMessage("Switching wallet to Arc Testnet.");

      let approvalTxHash = null;

      if (transactionPayload.approvalTransaction) {
        setStatusMessage("Approving USDC for the Arc escrow.");
        approvalTxHash = await sendPreparedArcTransaction({
          arcConfig,
          transaction: transactionPayload.approvalTransaction,
        });
      }

      setStatusMessage("Creating Arc bounty escrow.");
      const createTxHash = await sendPreparedArcTransaction({
        arcConfig,
        transaction: transactionPayload.createBountyTransaction,
      });

      const payload = await requestJson("/bounties", {
        method: "POST",
        token,
        body: {
          title: torrentMeta.name,
          description: bountyDescription || `Bounty for ${torrentMeta.name}`,
          torrentInfoHash: torrentMeta.infoHash,
          torrentName: torrentMeta.name,
          rewardAmountUnits,
          rewardToken: "USDC",
          escrowId: createTxHash,
          escrowStatus: "FUNDED",
          funding: {
            chain: "arc",
            approvalTxHash,
            createTxHash,
            escrowContractAddress: arcConfig.escrowContractAddress,
          },
          tags: ["arc"],
          torrentFileBase64: torrentBase64,
          pieceCount: torrentMeta.pieceCount || undefined,
          pieceLength: torrentMeta.pieceLength ?? undefined,
          totalSize: torrentMeta.totalSize || undefined,
          files: torrentMeta.files.length > 0 ? torrentMeta.files : undefined,
        },
      });

      const bounty = payload.bounty;
      setBounties((currentBounties) => [bounty, ...currentBounties]);

      setStatusMessage(`Bounty "${bounty.title}" created on Arc.`);

      setTorrentMeta(null);
      setTorrentBase64(null);
      setRewardAmountUsdc("25");
      setBountyDescription("");

      if (typeof onCreated === "function") {
        onCreated(bounty);
      }

      return bounty;
    } catch (error) {
      setStatusMessage(error.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function handleHuntBounty(bountyId) {
    setLoading(true);

    try {
      const bounty = bounties.find((record) => record.id === bountyId);
      if (!bounty) {
        throw new Error("Bounty not found.");
      }

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
      setBounties((currentBounties) =>
        currentBounties.map((bounty) => (bounty.id === bountyId ? payload.bounty : bounty)),
      );
      setStatusMessage("Joined bounty as a hunter.");
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  const mergeBounty = useCallback((bounty) => {
    setBounties((currentBounties) => {
      const index = currentBounties.findIndex((record) => record.id === bounty.id);

      if (index === -1) {
        return [bounty, ...currentBounties];
      }

      return currentBounties.map((record) => (record.id === bounty.id ? bounty : record));
    });
  }, []);

  async function handleLogout() {
    if (!token) {
      return;
    }

    setLoading(true);

    try {
      await requestJson("/auth/logout", {
        method: "POST",
        token,
      });
    } catch (_error) {
      // Clear the local session even if the server-side token is already gone.
    } finally {
      setToken("");
      setStatusMessage("Disconnected session.");
      setLoading(false);
    }
  }

  const openBounties = useMemo(
    () => bounties.filter((bounty) => bounty.status === "OPEN"),
    [bounties],
  );
  const awaitingFunding = useMemo(
    () => bounties.filter((bounty) => bounty.status === "AWAITING_FUNDING"),
    [bounties],
  );
  const completedBounties = useMemo(
    () => bounties.filter((bounty) => bounty.status === "COMPLETED"),
    [bounties],
  );

  const value = {
    health,
    statusMessage,
    setStatusMessage,
    displayName,
    setDisplayName,
    token,
    setToken,
    currentUser,
    bounties,
    setBounties,
    loading,
    torrentMeta,
    rewardAmountUsdc,
    setRewardAmountUsdc,
    bountyDescription,
    setBountyDescription,
    dragOver,
    setDragOver,
    refreshBounties,
    handleWalletLogin,
    handleDrop,
    handleFileSelect,
    clearTorrent,
    handleCreateBounty,
    handleHuntBounty,
    handleLogout,
    mergeBounty,
    openBounties,
    awaitingFunding,
    completedBounties,
    formatBytes,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
