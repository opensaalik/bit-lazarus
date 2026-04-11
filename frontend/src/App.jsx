import { Suspense, lazy, startTransition, useEffect, useState, useCallback } from "react";
import { parseTorrentFile, parseMagnetUri, isMagnetLink, torrentToBase64, formatBytes } from "./lib/torrent-parser.js";

const HeroScene = lazy(() => import("./HeroScene.jsx"));

async function requestJson(pathname, options = {}) {
  const response = await fetch(pathname, {
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    method: options.method ?? "GET",
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  }

  return payload;
}

export default function App() {
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

    // Extensions inject globals asynchronously; poll briefly to catch them.
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

  async function handleCreateBounty(event) {
    event.preventDefault();
    if (!torrentMeta) {
      setStatusMessage("Upload a .torrent file or paste a magnet link first.");
      return;
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
    } catch (error) {
      setStatusMessage(error.message);
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

      const challenge = challengePayload.challenge;
      const eventTemplate = {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["challenge", challenge.id]],
        content: challenge.message,
      };

      const signedEvent = await window.nostr.signEvent(eventTemplate);

      const verifyPayload = await requestJson("/auth/verify", {
        method: "POST",
        body: {
          challengeId: challenge.id,
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

  const openBounties = bounties.filter((bounty) => bounty.status === "OPEN");
  const awaitingFunding = bounties.filter((bounty) => bounty.status === "AWAITING_FUNDING");
  const completedBounties = bounties.filter((bounty) => bounty.status === "COMPLETED");

  return (
    <div className="page-shell">
      <Suspense fallback={<div className="hero-scene hero-scene-fallback" />}>
        <HeroScene />
      </Suspense>
      <header className="hero-grid">
        <div className="hero-copy glass-panel">
          <p className="eyebrow">Bit Lazarus</p>
          <h1>Raise bounty lightning for dead torrents.</h1>
          <p className="hero-text">
            Wallet-linked identities, escrow-backed rewards, and a client-side verification
            path for hunters who can resurrect missing torrent pieces.
          </p>
          <div className="hero-metrics">
            <article>
              <strong>{health?.ok ? "Online" : "Pending"}</strong>
              <span>Node status</span>
            </article>
            <article>
              <strong>{openBounties.length}</strong>
              <span>Open hunts</span>
            </article>
            <article>
              <strong>{awaitingFunding.length}</strong>
              <span>Awaiting funding</span>
            </article>
            <article>
              <strong>{completedBounties.length}</strong>
              <span>Completed</span>
            </article>
          </div>
        </div>

        <aside className="command-column">
          <section className="glass-panel stack">
            <div className="panel-head">
              <p className="eyebrow">Wallet Login</p>
              <h2>Connect your bounty identity</h2>
            </div>

            {!token ? (
              <div className="stack">
                <div className="stack">
                  <label className="field">
                    <span>Display name (optional)</span>
                    <input
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="Torrent necromancer"
                    />
                  </label>
                  <button
                    className="primary-button"
                    disabled={loading}
                    onClick={handleAlbyConnect}
                    type="button"
                  >
                    Connect with Alby
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setShowManualLogin((v) => !v)}
                  >
                    {showManualLogin ? "Hide manual login" : "Use Bitcoin wallet instead"}
                  </button>
                </div>

                {showManualLogin ? (
                  <div className="stack">
                    <form className="stack" onSubmit={handleChallengeRequest}>
                      <label className="field">
                        <span>Bitcoin wallet address</span>
                        <input
                          value={walletAddress}
                          onChange={(event) => setWalletAddress(event.target.value)}
                          placeholder="tb1q..."
                          required
                        />
                      </label>
                      <button className="primary-button" disabled={loading} type="submit">
                        Issue wallet challenge
                      </button>
                    </form>

                    {challenge ? (
                      <form className="stack challenge-panel" onSubmit={handleVerify}>
                        <label className="field">
                          <span>Challenge message</span>
                          <textarea readOnly rows={6} value={challenge.message} />
                        </label>
                        <label className="field">
                          <span>Signature</span>
                          <textarea
                            value={signature}
                            onChange={(event) => setSignature(event.target.value)}
                            placeholder="Paste wallet signature here"
                            rows={4}
                            required
                          />
                        </label>
                        <div className="button-row">
                          <button className="secondary-button" type="button" onClick={() => {
                            setSignature(`mock-signature:${walletAddress}:${challenge.message}`);
                          }}>
                            Use mock signature
                          </button>
                          <button className="primary-button" disabled={loading} type="submit">
                            Verify wallet
                          </button>
                        </div>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="status-ribbon">
              <span className="status-dot" />
              <p>{statusMessage}</p>
            </div>
          </section>

          <section className="glass-panel stack">
            <div className="panel-head">
              <p className="eyebrow">Session</p>
              <h2>{currentUser ? currentUser.displayName ?? "Wallet pilot" : "No wallet connected"}</h2>
            </div>
            <p className="muted-copy">
              {currentUser
                ? currentUser.walletType === "nostr" || currentUser.walletType === "webln"
                  ? `${currentUser.walletAddress.slice(0, 12)}...${currentUser.walletAddress.slice(-8)}`
                  : currentUser.walletAddress
                : "Authenticate with a Lightning or Bitcoin wallet to create bounties or hunt them."}
            </p>
            <div className="chip-row">
              <span className="chip">Three.js interface</span>
              <span className="chip">Escrow auto-sync</span>
              <span className="chip">{currentUser?.walletType === "nostr" ? "Nostr identity" : currentUser?.walletType === "webln" ? "Lightning identity" : "Wallet-linked identity"}</span>
            </div>
            <button className="secondary-button" disabled={!token || loading} onClick={handleLogout} type="button">
              Disconnect
            </button>
          </section>
        </aside>
      </header>

      <main className="dashboard-grid">
        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Create Bounty</p>
            <h2>Resurrect a dead torrent</h2>
          </div>

          <form className="bounty-form" onSubmit={handleCreateBounty}>
            {torrentMeta ? (
              <div className="torrent-preview field-span-2">
                <div className="torrent-preview-head">
                  <h3>{torrentMeta.name}</h3>
                  <button type="button" className="clear-button" onClick={clearTorrent} title="Remove">x</button>
                </div>
                <span className="chip">{torrentMeta.source === "magnet" ? "Magnet link" : ".torrent file"}</span>
                <div className="detail-grid">
                  <div><span>Info hash</span><code>{torrentMeta.infoHash}</code></div>
                  {torrentMeta.totalSize > 0 ? (
                    <div><span>Size</span><strong>{formatBytes(torrentMeta.totalSize)}</strong></div>
                  ) : null}
                  {torrentMeta.pieceCount > 0 ? (
                    <div><span>Pieces</span><strong>{torrentMeta.pieceCount.toLocaleString()}</strong></div>
                  ) : null}
                  {torrentMeta.files.length > 0 ? (
                    <div><span>Files</span><strong>{torrentMeta.files.length}</strong></div>
                  ) : null}
                </div>
                {torrentMeta.files.length > 0 ? (
                  <details className="file-list">
                    <summary>{torrentMeta.files.length} file{torrentMeta.files.length !== 1 ? "s" : ""}</summary>
                    <ul>
                      {torrentMeta.files.slice(0, 20).map((f, i) => (
                        <li key={i}><code>{f.path}</code> <span className="muted-copy">{formatBytes(f.length)}</span></li>
                      ))}
                      {torrentMeta.files.length > 20 ? <li className="muted-copy">...and {torrentMeta.files.length - 20} more</li> : null}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : (
              <div className="torrent-input-group field-span-2">
                <div
                  className={`drop-zone${dragOver ? " drag-over" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById("torrent-file-input")?.click()}
                >
                  <input
                    id="torrent-file-input"
                    type="file"
                    accept=".torrent"
                    onChange={handleFileSelect}
                    style={{ display: "none" }}
                  />
                  <div className="drop-zone-prompt">
                    <p><strong>Drop a .torrent file here</strong></p>
                    <p className="muted-copy">or click to browse</p>
                  </div>
                </div>
                <div className="input-divider"><span>or</span></div>
                <div className="magnet-input-row">
                  <input
                    type="text"
                    value={magnetInput}
                    onChange={(e) => setMagnetInput(e.target.value)}
                    placeholder="magnet:?xt=urn:btih:..."
                    className="magnet-field"
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={loading || !magnetInput.trim()}
                    onClick={handleMagnetSubmit}
                  >
                    Parse
                  </button>
                </div>
              </div>
            )}

            <label className="field field-span-2">
              <span>Description (optional)</span>
              <textarea
                rows={3}
                value={bountyDescription}
                onChange={(e) => setBountyDescription(e.target.value)}
                placeholder="Any context for hunters — where to find the data, which files matter most, etc."
              />
            </label>
            <label className="field">
              <span>Reward (sats)</span>
              <input
                min="1"
                type="number"
                value={rewardSats}
                onChange={(e) => setRewardSats(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Collateral bond</span>
              <input
                readOnly
                value={`${Math.max(1, Math.ceil(Number.parseInt(rewardSats || "0", 10) * 0.1))} sats (10%)`}
                className="muted-input"
              />
            </label>
            <button
              className="primary-button field-span-2"
              disabled={!token || loading || !torrentMeta}
              type="submit"
            >
              {torrentMeta ? "Create & Fund Bounty" : "Upload .torrent or paste magnet link"}
            </button>
          </form>
        </section>

        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Bounty Radar</p>
            <h2>Track hunts and escrow heat</h2>
          </div>

          <div className="bounty-list">
            {bounties.length === 0 ? (
              <article className="bounty-card empty">
                <h3>No bounties loaded yet</h3>
                <p>Connect a wallet and post the first reseed mission.</p>
              </article>
            ) : null}

            {bounties.map((bounty) => (
              <article className="bounty-card" key={bounty.id}>
                <div className="bounty-card-head">
                  <div>
                    <p className="eyebrow">{bounty.status}</p>
                    <h3>{bounty.title}</h3>
                  </div>
                  <div className="bounty-sats">
                    <strong>{bounty.rewardSats.toLocaleString()} sats</strong>
                    {bounty.bondAmountSats ? (
                      <span className="bond-chip">{bounty.bondAmountSats.toLocaleString()} sats bond</span>
                    ) : null}
                  </div>
                </div>
                <p className="bounty-description">{bounty.description}</p>
                <div className="detail-grid">
                  <div>
                    <span>Info hash</span>
                    <code>{bounty.torrentInfoHash}</code>
                  </div>
                  <div>
                    <span>Escrow</span>
                    <code>{bounty.escrowStatus}</code>
                  </div>
                  <div>
                    <span>Hunters</span>
                    <strong>{bounty.hunters.length}</strong>
                  </div>
                  <div>
                    <span>Pieces</span>
                    <strong>{bounty.missingPieces.length}</strong>
                  </div>
                  {bounty.torrentMeta?.totalSize ? (
                    <div>
                      <span>Total size</span>
                      <strong>{formatBytes(bounty.torrentMeta.totalSize)}</strong>
                    </div>
                  ) : null}
                  {bounty.torrentMeta?.files?.length ? (
                    <div>
                      <span>Files</span>
                      <strong>{bounty.torrentMeta.files.length}</strong>
                    </div>
                  ) : null}
                </div>
                <div className="chip-row">
                  {bounty.tags.map((tag) => (
                    <span className="chip" key={tag}>{tag}</span>
                  ))}
                </div>
                <div className="button-row">
                  {bounty.escrowStatus === "AWAITING_FUNDING" && bounty.creatorUserId === currentUser?.id ? (
                    <button
                      className="primary-button"
                      disabled={!token || loading}
                      onClick={() => handleFundEscrow(bounty)}
                      type="button"
                    >
                      {hasWebLn ? "Fund escrow via Alby" : "Copy invoice"}
                    </button>
                  ) : null}
                  {bounty.hasTorrentFile ? (
                    <a
                      className="secondary-button"
                      href={`/bounties/${bounty.id}/torrent`}
                      download
                      style={{ textDecoration: "none", textAlign: "center" }}
                    >
                      Download .torrent
                    </a>
                  ) : null}
                  <button
                    className="secondary-button"
                    disabled={!token || loading}
                    onClick={() => handleSyncBounty(bounty.id)}
                    type="button"
                  >
                    Sync escrow
                  </button>
                  <button
                    className="primary-button"
                    disabled={!token || loading || bounty.status !== "OPEN"}
                    onClick={() => handleHuntBounty(bounty.id)}
                    type="button"
                  >
                    Hunt bounty
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
