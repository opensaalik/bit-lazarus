import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { parseTorrentFile, parseMagnetUri, torrentToBase64, formatBytes } from "../lib/torrent-parser.js";
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
  const [statusMessage, setStatusMessage] = useState("Warming up the Lazarus relay...");
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
  const [magnetInput, setMagnetInput] = useState("");
  const [hasWebLn, setHasWebLn] = useState(false);
  const [hasNostr, setHasNostr] = useState(false);
  const [showManualLogin, setShowManualLogin] = useState(false);

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

    const checkExtensions = () => {
      setHasWebLn(typeof window.webln !== "undefined");
      setHasNostr(typeof window.nostr !== "undefined");
    };
    checkExtensions();

    let attempts = 0;
    const poll = setInterval(() => {
      checkExtensions();
      attempts += 1;
      if ((window.nostr && window.webln) || attempts >= 20) {
        clearInterval(poll);
      }
    }, 150);

    return () => clearInterval(poll);
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
          setStatusMessage(`Wallet session active for ${payload.user.walletAddress}`);
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
      setStatusMessage("Challenge issued. Sign it with your wallet or use mock mode for local development.");
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
      setStatusMessage(`Wallet connected as ${payload.user.displayName ?? payload.user.walletAddress}`);
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
      setStatusMessage(`Parsed: ${meta.name} (${meta.pieceCount} pieces, ${formatBytes(meta.totalSize)})`);
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
    if (file) handleTorrentFile(file);
  }

  function handleFileSelect(event) {
    const file = event.target.files?.[0];
    if (file) handleTorrentFile(file);
  }

  async function handleMagnetSubmit(event) {
    event.preventDefault();
    if (!magnetInput.trim()) return;
    setLoading(true);
    try {
      const meta = await parseMagnetUri(magnetInput);
      setTorrentMeta(meta);
      setTorrentBase64(null);
      setMagnetInput("");
      setStatusMessage(`Parsed magnet: ${meta.name} (${meta.infoHash})`);
    } catch (error) {
      setStatusMessage(`Invalid magnet link: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  function clearTorrent() {
    setTorrentMeta(null);
    setTorrentBase64(null);
    setMagnetInput("");
  }

  async function handleCreateBounty(event, { onCreated } = {}) {
    event?.preventDefault();
    if (!torrentMeta) {
      setStatusMessage("Upload a .torrent file or paste a magnet link first.");
      return null;
    }
    setLoading(true);

    try {
      const sats = Number.parseInt(rewardSats, 10);
      const allPieces = torrentMeta.pieceCount > 0
        ? Array.from({ length: torrentMeta.pieceCount }, (_, i) => i)
        : [];

      const payload = await requestJson("/bounties", {
        method: "POST",
        token,
        body: {
          title: torrentMeta.name,
          description: bountyDescription || `Bounty for dead torrent: ${torrentMeta.name}`,
          torrentInfoHash: torrentMeta.infoHash,
          torrentName: torrentMeta.name,
          rewardSats: sats,
          missingPieces: allPieces,
          tags: ["resurrection"],
          torrentFileBase64: torrentBase64 ?? undefined,
          pieceCount: torrentMeta.pieceCount || undefined,
          pieceLength: torrentMeta.pieceLength ?? undefined,
          totalSize: torrentMeta.totalSize || undefined,
          files: torrentMeta.files.length > 0 ? torrentMeta.files : undefined,
        },
      });

      const bounty = payload.bounty;
      setBounties((currentBounties) => [bounty, ...currentBounties]);
      setStatusMessage("Bounty created! Funding escrow...");

      if (bounty.funding?.paymentRequest && window.webln) {
        try {
          await window.webln.enable();
          await window.webln.sendPayment(bounty.funding.paymentRequest);
          setStatusMessage("Payment sent! Syncing escrow...");
          const syncPayload = await requestJson(`/bounties/${bounty.id}/sync-escrow`, {
            method: "POST",
            token,
          });
          setBounties((cur) => cur.map((b) => (b.id === bounty.id ? syncPayload.bounty : b)));
          setStatusMessage(`Bounty "${bounty.title}" is live!`);
        } catch (payError) {
          setStatusMessage(`Bounty created but funding skipped: ${payError.message}. You can fund it later.`);
        }
      } else {
        setStatusMessage(`Bounty created with escrow ${bounty.escrowId}. Fund it to go live.`);
      }

      setTorrentMeta(null);
      setTorrentBase64(null);
      setMagnetInput("");
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
    setBounties((current) => {
      const index = current.findIndex((b) => b.id === bounty.id);
      if (index === -1) {
        return [bounty, ...current];
      }

      return current.map((b) => (b.id === bounty.id ? bounty : b));
    });
  }, []);

  async function handleAlbyConnect() {
    setLoading(true);

    try {
      if (!window.nostr) {
        throw new Error(
          "Nostr extension not found. Install Alby (getalby.com) and reload the page.",
        );
      }

      const pubkey = await window.nostr.getPublicKey();

      const challengePayload = await requestJson("/auth/challenges", {
        method: "POST",
        body: { kind: "nostr" },
      });

      const ch = challengePayload.challenge;
      const eventTemplate = {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["challenge", ch.id]],
        content: ch.message,
      };

      const signedEvent = await window.nostr.signEvent(eventTemplate);

      const verifyPayload = await requestJson("/auth/verify", {
        method: "POST",
        body: {
          challengeId: ch.id,
          signedEvent,
          displayName: displayName.trim() || null,
        },
      });

      setToken(verifyPayload.session.token);
      setChallenge(null);
      setSignature("");
      setWalletAddress(pubkey);
      setStatusMessage(
        `Connected via Alby as ${verifyPayload.user.displayName ?? `${pubkey.slice(0, 12)}...`}`,
      );
    } catch (error) {
      setStatusMessage(error.message ?? String(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleFundEscrow(bounty) {
    if (!bounty.funding?.paymentRequest) {
      setStatusMessage("No invoice available for this escrow.");
      return;
    }

    setLoading(true);

    try {
      if (window.webln) {
        await window.webln.enable();
        await window.webln.sendPayment(bounty.funding.paymentRequest);
        setStatusMessage("Payment sent! Syncing escrow state...");
      } else {
        await navigator.clipboard.writeText(bounty.funding.paymentRequest);
        setStatusMessage("Invoice copied to clipboard. Pay it with any Lightning wallet, then sync.");
        setLoading(false);
        return;
      }

      const payload = await requestJson(`/bounties/${bounty.id}/sync-escrow`, {
        method: "POST",
        token,
      });
      setBounties((currentBounties) =>
        currentBounties.map((b) => (b.id === bounty.id ? payload.bounty : b)),
      );
      setStatusMessage(`Escrow funded for bounty "${bounty.title}".`);
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
      setStatusMessage("Disconnected wallet session.");
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
    setLoading,
    torrentMeta,
    torrentBase64,
    rewardSats,
    setRewardSats,
    bountyDescription,
    setBountyDescription,
    dragOver,
    setDragOver,
    magnetInput,
    setMagnetInput,
    hasWebLn,
    hasNostr,
    showManualLogin,
    setShowManualLogin,
    refreshBounties,
    handleChallengeRequest,
    handleVerify,
    handleTorrentFile,
    handleDrop,
    handleFileSelect,
    handleMagnetSubmit,
    clearTorrent,
    handleCreateBounty,
    handleHuntBounty,
    handleSyncBounty,
    handleAlbyConnect,
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
