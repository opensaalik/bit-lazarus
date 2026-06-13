import { Link } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";
import NetworkBackground from "../components/NetworkBackground.jsx";

const USES = [
  { name: "ENS", body: "Every torrent infohash derives a stable ENS name, so a recovery is resolvable forever." },
  { name: "WebTorrent", body: "Recovered files move peer-to-peer, browser to browser — no central server in the middle." },
  { name: "Walrus", body: "Once verified, the file is archived to Walrus for durable, content-addressed storage." },
  { name: "Arc", body: "USDC escrow on Arc locks the reward and only pays out on a verified hash match." },
];

const STEPS = [
  { title: "Post a bounty", body: "Upload a dead .torrent and stake a USDC reward. Arc seals the escrow." },
  { title: "Hunt & seed", body: "A hunter who still has the data joins and seeds it back over WebTorrent." },
  { title: "Verify & settle", body: "The browser checks SHA-256, archives to Walrus, and Arc releases the reward." },
];

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
            </form>
          ) : (
            <div className="brand-cta">
              <Link className="primary-button" to="/marketplace">
                Browse bounties
              </Link>
              <Link className="secondary-button" to="/bounties/new">
                Post a bounty
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
            <h2>{currentUser?.displayName ?? "Wallet linked"}</h2>
          </div>
          <p className="muted-copy">Signed in as {currentUser?.walletAddress}. Jump into the marketplace.</p>
        </section>
      )}

      <section className="glass-panel landing-section">
        <div className="panel-head">
          <p className="eyebrow">The stack</p>
          <h2 className="section-title">What we use</h2>
        </div>
        <div className="uses-grid">
          {USES.map((use) => (
            <article className="use-card" key={use.name}>
              <h4>{use.name}</h4>
              <p>{use.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="glass-panel landing-section">
        <div className="panel-head">
          <p className="eyebrow">The loop</p>
          <h2 className="section-title">How it works</h2>
        </div>
        <div className="steps-row">
          {STEPS.map((step, index) => (
            <article className="step-card" key={step.title}>
              <span className="step-num">{String(index + 1).padStart(2, "0")}</span>
              <h4>{step.title}</h4>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
        <div className="button-row">
          <Link className="primary-button" to="/marketplace">
            Enter the marketplace
          </Link>
          <Link className="secondary-button" to="/bounties/new">
            Post a bounty
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <span className="landing-footer-brand">
            Bit<b>Lazarus</b>
          </span>
          <nav aria-label="Footer">
            <Link to="/marketplace">Marketplace</Link>
            <Link to="/bounties/new">Post a bounty</Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
