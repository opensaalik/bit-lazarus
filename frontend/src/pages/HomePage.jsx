import { Link } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";

export default function HomePage() {
  const {
    health,
    statusMessage,
    displayName,
    setDisplayName,
    token,
    currentUser,
    loading,
    handleWalletLogin,
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
          <h2>{token && currentUser ? currentUser.displayName ?? currentUser.walletAddress : "Brave Wallet login"}</h2>
        </div>
        <p className="muted-copy">
          Connect with Brave Wallet and sign the issued message with the same account you will use for Arc interactions.
        </p>

        {!token ? (
          <div className="stack">
            <form className="stack" onSubmit={handleWalletLogin}>
              <label className="field">
                <span>Display name (optional)</span>
                <input
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Requester or Hunter"
                  value={displayName}
                />
              </label>
              <button className="primary-button" disabled={loading} type="submit">
                Connect Brave Wallet
              </button>
            </form>
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
