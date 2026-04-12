import { Link } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";

export default function HomePage() {
  const {
    health,
    statusMessage,
    walletAddress,
    setWalletAddress,
    displayName,
    setDisplayName,
    challenge,
    signature,
    setSignature,
    token,
    currentUser,
    loading,
    hasWebLn,
    hasNostr,
    showManualLogin,
    setShowManualLogin,
    handleChallengeRequest,
    handleVerify,
    handleAlbyConnect,
    openBounties,
    awaitingFunding,
    completedBounties,
  } = useApp();

  return (
    <>
      <header className="hero-grid">
        <div className="hero-copy glass-panel">
          <p className="eyebrow">Bit Lazarus</p>
          <h1>Raise dead torrent files with lightning fast bounty.</h1>
          <p className="hero-text">
            Post a Lightning-backed bounty for any dead torrent. Hunters prove they hold the
            missing pieces, escrow releases the reward — no trust required.
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
          <div className="home-cta-row">
            <Link className="primary-button home-cta" to="/marketplace">
              Browse marketplace
            </Link>
            <Link className="secondary-button home-cta" to="/bounties/new">
              List a new bounty
            </Link>
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
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => {
                              setSignature(`mock-signature:${walletAddress}:${challenge.message}`);
                            }}
                          >
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
              <span className="chip">
                {currentUser?.walletType === "nostr"
                  ? "Nostr identity"
                  : currentUser?.walletType === "webln"
                    ? "Lightning identity"
                    : "Wallet-linked identity"}
              </span>
            </div>
            <div className="home-extension-hint muted-copy">
              {hasWebLn ? <span>WebLN detected</span> : null}
              {hasWebLn && hasNostr ? " · " : null}
              {hasNostr ? <span>Nostr detected</span> : null}
            </div>
            {token ? (
              <p className="muted-copy home-disconnect-hint">Use Disconnect in the top bar to sign out.</p>
            ) : null}
          </section>
        </aside>
      </header>
    </>
  );
}
