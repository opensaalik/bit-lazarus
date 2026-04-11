import { Suspense, lazy, startTransition, useEffect, useState } from "react";

const HeroScene = lazy(() => import("./HeroScene.jsx"));

const initialBountyForm = {
  title: "",
  description: "",
  torrentInfoHash: "",
  torrentName: "",
  rewardSats: "25000",
  missingPieces: "12,15,18",
  tags: "linux,archive",
};

function parseCsvIntegers(value) {
  if (!value.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((piece) => Number.parseInt(piece.trim(), 10))
    .filter((piece) => Number.isInteger(piece));
}

function parseCsvStrings(value) {
  if (!value.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

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
  const [bountyForm, setBountyForm] = useState(initialBountyForm);
  const [loading, setLoading] = useState(false);

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

  async function handleCreateBounty(event) {
    event.preventDefault();
    setLoading(true);

    try {
      const payload = await requestJson("/bounties", {
        method: "POST",
        token,
        body: {
          title: bountyForm.title,
          description: bountyForm.description,
          torrentInfoHash: bountyForm.torrentInfoHash,
          torrentName: bountyForm.torrentName,
          rewardSats: Number.parseInt(bountyForm.rewardSats, 10),
          missingPieces: parseCsvIntegers(bountyForm.missingPieces),
          tags: parseCsvStrings(bountyForm.tags),
        },
      });
      setBounties((currentBounties) => [payload.bounty, ...currentBounties]);
      setBountyForm(initialBountyForm);
      setStatusMessage(`Bounty created with escrow ${payload.bounty.escrowId}`);
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
              <label className="field">
                <span>Display name</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Torrent necromancer"
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
                ? currentUser.walletAddress
                : "Authenticate with a Bitcoin wallet to create bounties or hunt them."}
            </p>
            <div className="chip-row">
              <span className="chip">Three.js interface</span>
              <span className="chip">Escrow auto-sync</span>
              <span className="chip">Wallet-linked identity</span>
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
            <h2>Post a reseed mission</h2>
          </div>

          <form className="bounty-form" onSubmit={handleCreateBounty}>
            <label className="field field-span-2">
              <span>Title</span>
              <input
                value={bountyForm.title}
                onChange={(event) => setBountyForm({ ...bountyForm, title: event.target.value })}
                placeholder="Need the last blocks of a lost ISO torrent"
                required
              />
            </label>
            <label className="field field-span-2">
              <span>Description</span>
              <textarea
                rows={4}
                value={bountyForm.description}
                onChange={(event) => setBountyForm({ ...bountyForm, description: event.target.value })}
                placeholder="Describe what is missing and what a hunter should reseed."
                required
              />
            </label>
            <label className="field">
              <span>Torrent info hash</span>
              <input
                value={bountyForm.torrentInfoHash}
                onChange={(event) =>
                  setBountyForm({ ...bountyForm, torrentInfoHash: event.target.value.toLowerCase() })
                }
                placeholder="40-char hex info hash"
                required
              />
            </label>
            <label className="field">
              <span>Torrent name</span>
              <input
                value={bountyForm.torrentName}
                onChange={(event) => setBountyForm({ ...bountyForm, torrentName: event.target.value })}
                placeholder="archive.iso.torrent"
              />
            </label>
            <label className="field">
              <span>Reward sats</span>
              <input
                min="1"
                type="number"
                value={bountyForm.rewardSats}
                onChange={(event) => setBountyForm({ ...bountyForm, rewardSats: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>Missing pieces</span>
              <input
                value={bountyForm.missingPieces}
                onChange={(event) => setBountyForm({ ...bountyForm, missingPieces: event.target.value })}
                placeholder="12,15,18"
              />
            </label>
            <label className="field field-span-2">
              <span>Tags</span>
              <input
                value={bountyForm.tags}
                onChange={(event) => setBountyForm({ ...bountyForm, tags: event.target.value })}
                placeholder="linux,archive,recovery"
              />
            </label>
            <button className="primary-button field-span-2" disabled={!token || loading} type="submit">
              Create bounty with attached escrow
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
                  <strong>{bounty.rewardSats.toLocaleString()} sats</strong>
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
                </div>
                <div className="chip-row">
                  {bounty.tags.map((tag) => (
                    <span className="chip" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="button-row">
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
