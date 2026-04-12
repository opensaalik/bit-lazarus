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
    handleChallengeRequest,
    handleDemoLogin,
    handleVerify,
    openBounties,
    awaitingFunding,
    completedBounties,
  } = useApp();

  return (
    <main className="page-main">
      <section className="glass-panel stack">
        <div className="hero-logo-lockup">
          <img
            alt="Bit Lazarus"
            className="hero-logo-image"
            src="/bit-lazarus-logo.svg"
          />
        </div>
        <div className="panel-head">
          <p className="eyebrow">Bit Lazarus Demo</p>
          <h1>Recover a dead torrent with Polar-backed escrow</h1>
        </div>
        <p className="muted-copy">
          This demo keeps only the working hackathon flow: Bitcoin challenge auth, torrent-file bounties,
          Polar-funded escrow and bonds, and WebTorrent delivery with SHA-256 verification.
        </p>

        <div className="hero-metrics">
          <article>
            <strong>{health?.ok ? "Online" : "Pending"}</strong>
            <span>Server status</span>
          </article>
          <article>
            <strong>{openBounties.length}</strong>
            <span>Open bounties</span>
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

        <div className="button-row">
          <Link className="primary-button" to="/marketplace">
            Browse marketplace
          </Link>
          <Link className="secondary-button" to="/bounties/new">
            Create bounty
          </Link>
        </div>
      </section>

      <section className="glass-panel stack">
        <div className="panel-head">
          <p className="eyebrow">Login</p>
          <h2>{token && currentUser ? currentUser.displayName ?? currentUser.walletAddress : "Bitcoin wallet challenge"}</h2>
        </div>
        <p className="muted-copy">
          For the demo, use the one-click Polar login buttons. Manual challenge signing is still available below.
        </p>

        {!token ? (
          <div className="stack">
            {health?.auth?.backendDemoAuth ? (
              <div className="stack">
                <div className="button-row">
                  <button
                    className="primary-button"
                    disabled={loading}
                    onClick={() => {
                      void handleDemoLogin("requester");
                    }}
                    type="button"
                  >
                    Login as Requester
                  </button>
                  <button
                    className="secondary-button"
                    disabled={loading}
                    onClick={() => {
                      void handleDemoLogin("hunter");
                    }}
                    type="button"
                  >
                    Login as Hunter
                  </button>
                </div>
                <p className="muted-copy">
                  Use separate browser profiles for requester and hunter.
                </p>
              </div>
            ) : null}

            <form className="stack" onSubmit={handleChallengeRequest}>
              <label className="field">
                <span>Display name (optional)</span>
                <input
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Requester or Hunter"
                  value={displayName}
                />
              </label>
              <label className="field">
                <span>Bitcoin wallet address</span>
                <input
                  onChange={(event) => setWalletAddress(event.target.value)}
                  placeholder="tb1q... or legacy regtest address"
                  required
                  value={walletAddress}
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
                    onChange={(event) => setSignature(event.target.value)}
                    placeholder="Paste the wallet signature here"
                    required
                    rows={4}
                    value={signature}
                  />
                </label>
                <button className="primary-button" disabled={loading} type="submit">
                  Verify wallet
                </button>
              </form>
            ) : null}
          </div>
        ) : (
          <p className="muted-copy">Session active for {currentUser?.walletAddress}.</p>
        )}

        <div className="status-ribbon">
          <span className="status-dot" />
          <p>{statusMessage}</p>
        </div>
      </section>
    </main>
  );
}
