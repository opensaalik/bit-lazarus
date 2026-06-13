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
          <h1>Recover a dead torrent with Arc escrow</h1>
        </div>
        <p className="muted-copy">
          Ethereum wallet auth, torrent-file bounties, ENS resource lookup, WebTorrent delivery,
          and Arc USDC escrow for settlement.
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
          <h2>{token && currentUser ? currentUser.displayName ?? currentUser.walletAddress : "Ethereum wallet challenge"}</h2>
        </div>
        <p className="muted-copy">
          Sign the issued message with the same Ethereum wallet you will use for Arc interactions.
        </p>

        {!token ? (
          <div className="stack">
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
                <span>Ethereum wallet address</span>
                <input
                  onChange={(event) => setWalletAddress(event.target.value)}
                  placeholder="0x..."
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
