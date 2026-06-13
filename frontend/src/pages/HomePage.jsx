import { Link } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";
import NetworkBackground from "../components/NetworkBackground.jsx";

export default function HomePage() {
  const { displayName, setDisplayName, token, currentUser, loading, handleWalletLogin } = useApp();

  return (
    <main className="page-main">
      <section className="net-hero">
        <NetworkBackground className="net-canvas" />
        <div className="net-hero-inner">
          <h1 className="brand-title">
            Bit<b>Lazarus</b>
          </h1>
          <p className="brand-sub">Bring dead torrents back from the grave — for a bounty.</p>

          {!token ? (
            <form className="brand-cta" onSubmit={handleWalletLogin}>
              <button className="primary-button" disabled={loading} type="submit">
                {loading ? "Connecting…" : "Connect wallet"}
              </button>
              <Link className="secondary-button" to="/marketplace">
                Browse bounties
              </Link>
              <Link className="secondary-button" to="/info">
                Learn more
              </Link>
            </form>
          ) : (
            <div className="brand-cta">
              <Link className="primary-button" to="/marketplace">
                Browse bounties
              </Link>
              <Link className="secondary-button" to="/bounties/new">
                Post a bounty
              </Link>
              <Link className="secondary-button" to="/info">
                Learn more
              </Link>
            </div>
          )}
        </div>
      </section>

      {!token ? (
        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Get started</p>
            <h2>Connect a wallet</h2>
          </div>
          <p className="muted-copy">
            Sign in with your Ethereum wallet and sign the issued message with the same account you
            use for Arc.
          </p>
          <form className="stack" onSubmit={handleWalletLogin}>
            <label className="field hero-name-field">
              <span>Display name (optional)</span>
              <input
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Requester or Hunter"
                value={displayName}
              />
            </label>
            <div className="button-row">
              <button className="primary-button" disabled={loading} type="submit">
                {loading ? "Connecting…" : "Connect wallet"}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Connected</p>
            <h2>{currentUser?.ensName ?? currentUser?.displayName ?? "Wallet linked"}</h2>
          </div>
          <p className="muted-copy">Signed in as {currentUser?.ensName ?? currentUser?.walletAddress}. Jump into the marketplace.</p>
        </section>
      )}
    </main>
  );
}
