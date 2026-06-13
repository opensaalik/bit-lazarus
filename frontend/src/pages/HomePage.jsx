import { Link } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";

const HOW_IT_WORKS = [
  {
    title: "Create a bounty",
    body: "Upload a .torrent file, set a USDC reward, and Bit Lazarus derives a stable ENS resource name from the infohash.",
  },
  {
    title: "Recover peer to peer",
    body: "A hunter joins, commits the recovered file hash, and seeds the data directly to the requester over WebTorrent.",
  },
  {
    title: "Verify and archive",
    body: "The browser verifies SHA-256, the file is archived to Walrus, and Arc escrow releases the reward.",
  },
];

export default function HomePage() {
  const logoUrl = `${import.meta.env.BASE_URL}bit-lazarus-logo.svg`;
  const {
    health,
    token,
    currentUser,
    loading,
    handleWalletLogin,
    openBounties,
    completedBounties,
  } = useApp();

  return (
    <main className="landing-page">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero-copy">
          <img alt="Bit Lazarus" className="landing-logo" src={logoUrl} />
          <p className="landing-kicker">ENS resource lookup for recovered torrents</p>
          <h1 id="landing-title">bit-lazarus</h1>
          <p className="landing-lede">
            Turn a dead torrent into a recoverable bounty. Bit Lazarus links the infohash to ENS,
            settles rewards through Arc, verifies delivery in the browser, and archives recovered
            files to Walrus.
          </p>

          {!token ? (
            <form className="landing-auth" onSubmit={handleWalletLogin}>
              <button className="primary-button landing-login-button" disabled={loading} type="submit">
                {loading ? "Waiting for Brave..." : "Login with Brave Wallet"}
              </button>
            </form>
          ) : (
            <div className="landing-action-row">
              <Link className="primary-button landing-login-button" to="/marketplace">
                Browse bounties
              </Link>
              <Link className="secondary-button" to="/bounties/new">
                Create bounty
              </Link>
            </div>
          )}

          {token && currentUser ? (
            <p className="landing-session">
              Connected as {currentUser.displayName ?? currentUser.walletAddress}
            </p>
          ) : null}
        </div>

        <div className="landing-signal" aria-hidden="true">
          <div className="landing-signal-card">
            <span>Network</span>
            <strong>{health?.ok ? "Live" : "Pending"}</strong>
          </div>
          <div className="landing-signal-card">
            <span>Open bounties</span>
            <strong>{openBounties.length}</strong>
          </div>
          <div className="landing-signal-card">
            <span>Recovered</span>
            <strong>{completedBounties.length}</strong>
          </div>
        </div>
      </section>

      <section className="landing-how" aria-labelledby="landing-how-title">
        <div className="landing-section-head">
          <p className="landing-kicker">How it works</p>
          <h2 id="landing-how-title">A simple recovery loop for files that still exist somewhere.</h2>
        </div>
        <div className="landing-steps">
          {HOW_IT_WORKS.map((step, index) => (
            <article className="landing-step" key={step.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <footer className="landing-footer">
        <span>bit-lazarus</span>
        <nav aria-label="Footer">
          <Link to="/marketplace">Marketplace</Link>
          <Link to="/bounties/new">Create bounty</Link>
        </nav>
      </footer>
    </main>
  );
}
