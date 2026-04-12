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
  const [statusMessage, setStatusMessage] = useState("Booting the demo relay...");
  const [walletAddress, setWalletAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [challenge, setChallenge] = useState(null);
  const [signature, setSignature] = useState("");
  const [token, setToken] = useState(() => window.localStorage.getItem("bit-lazarus-token") ?? "");
  const [currentUser, setCurrentUser] = useState(null);
  const [bounties, setBounties] = useState([]);
  const [loading, setLoading] = useState(false);
  const [torrentMeta, setTorrentMeta] = useState(null);
  const [torrentBase64, setTorrentBase64] = useState(null);
  const [rewardSats, setRewardSats] = useState("25000");
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
          setStatusMessage(`Session active for ${payload.user.walletAddress}`);
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

  async function handleChallengeRequest(event) {
    event.preventDefault();
    setLoading(true);

    try {
      const payload = await requestJson("/auth/challenges", {
        method: "POST",
        body: {
          walletAddress,
        },
      });
      setChallenge(payload.challenge);
      setSignature("");
      setStatusMessage("Challenge issued. Sign it with the Polar/Bitcoin wallet, then verify the session.");
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(event) {
    event.preventDefault();
    setLoading(true);

    try {
      const payload = await requestJson("/auth/verify", {
        method: "POST",
        body: {
          challengeId: challenge?.id,
          walletAddress,
          signature,
          displayName,
        },
      });
      setToken(payload.session.token);
      setChallenge(null);
      setSignature("");
      setStatusMessage(`Connected as ${payload.user.displayName ?? payload.user.walletAddress}`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDemoLogin(role) {
    setLoading(true);

    try {
      const defaultName = role === "requester" ? "Requester" : role === "hunter" ? "Hunter" : "";
      const payload = await requestJson("/auth/demo-login", {
        method: "POST",
        body: {
          role,
          displayName: displayName || defaultName,
        },
      });
      setToken(payload.session.token);
      setChallenge(null);
      setSignature("");
      setWalletAddress(payload.user.walletAddress ?? "");
      setDisplayName(payload.user.displayName ?? defaultName);
      setStatusMessage(`Connected as ${payload.user.displayName ?? payload.user.walletAddress}`);
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

  async function handleCreateBounty(event, { onCreated } = {}) {
    event?.preventDefault();

    if (!torrentMeta) {
      setStatusMessage("Upload a .torrent file first.");
      return null;
    }

    setLoading(true);

    try {
      const sats = Number.parseInt(rewardSats, 10);

      const payload = await requestJson("/bounties", {
        method: "POST",
        token,
        body: {
          title: torrentMeta.name,
          description: bountyDescription || `Bounty for ${torrentMeta.name}`,
          torrentInfoHash: torrentMeta.infoHash,
          torrentName: torrentMeta.name,
          rewardSats: sats,
          tags: ["demo"],
          torrentFileBase64: torrentBase64,
          pieceCount: torrentMeta.pieceCount || undefined,
          pieceLength: torrentMeta.pieceLength ?? undefined,
          totalSize: torrentMeta.totalSize || undefined,
          files: torrentMeta.files.length > 0 ? torrentMeta.files : undefined,
        },
      });

      const bounty = payload.bounty;
      setBounties((currentBounties) => [bounty, ...currentBounties]);

      if (bounty.funding?.paymentRequest) {
        const demoPayload = await requestJson(`/bounties/${bounty.id}/demo-fund`, {
          method: "POST",
          token,
        });
        setBounties((currentBounties) =>
          currentBounties.map((record) => (record.id === bounty.id ? demoPayload.bounty : record)),
        );
        setStatusMessage(`Bounty "${bounty.title}" is live via Polar demo funding.`);
      } else {
        setStatusMessage(`Bounty "${bounty.title}" created.`);
      }

      setTorrentMeta(null);
      setTorrentBase64(null);
      setRewardSats("25000");
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

  async function handleSyncBounty(bountyId) {
    setLoading(true);

    try {
      const payload = await requestJson(`/bounties/${bountyId}/sync-escrow`, {
        method: "POST",
        token,
      });
      setBounties((currentBounties) =>
        currentBounties.map((bounty) => (bounty.id === bountyId ? payload.bounty : bounty)),
      );
      setStatusMessage(`Escrow sync complete for ${bountyId}.`);
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

  async function handleFundEscrow(bounty) {
    if (!bounty.funding?.paymentRequest) {
      setStatusMessage("No invoice available for this escrow.");
      return;
    }

    setLoading(true);

    try {
      const payload = await requestJson(`/bounties/${bounty.id}/demo-fund`, {
        method: "POST",
        token,
      });
      setBounties((currentBounties) =>
        currentBounties.map((record) => (record.id === bounty.id ? payload.bounty : record)),
      );
      setStatusMessage(`Escrow funded for bounty "${bounty.title}" via Polar demo.`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

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
    walletAddress,
    setWalletAddress,
    displayName,
    setDisplayName,
    challenge,
    setChallenge,
    signature,
    setSignature,
    token,
    setToken,
    currentUser,
    bounties,
    setBounties,
    loading,
    torrentMeta,
    rewardSats,
    setRewardSats,
    bountyDescription,
    setBountyDescription,
    dragOver,
    setDragOver,
    refreshBounties,
    handleChallengeRequest,
    handleVerify,
    handleDemoLogin,
    handleDrop,
    handleFileSelect,
    clearTorrent,
    handleCreateBounty,
    handleHuntBounty,
    handleSyncBounty,
    handleFundEscrow,
    handleLogout,
    mergeBounty,
    openBounties,
    awaitingFunding,
    completedBounties,
    formatBytes,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
