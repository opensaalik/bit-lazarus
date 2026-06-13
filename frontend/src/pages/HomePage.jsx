import { Link } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";

const HOW_IT_WORKS = [
  {
    title: "Post a bounty",
    body: "Upload a .torrent file and stake a USDC reward. The infohash becomes a stable ENS resource name and Arc seals the escrow.",
  },
  {
    title: "Recover peer to peer",
    body: "A hunter who still holds the data joins, commits the file hash, and seeds it straight to the requester over WebTorrent.",
  },
  {
    title: "Verify & settle",
    body: "The browser checks the SHA-256, archives the file to Walrus, resolves it through ENS, and Arc releases the reward.",
  },
];

export default function HomePage() {
  const logoUrl = `${import.meta.env.BASE_URL}bit-lazarus-logo.svg`;
  const {
    displayName,
    setDisplayName,
    token,
    currentUser,
    loading,
    handleWalletLogin,
  } = useApp();

  return (
    <main className="page-main">
      <section className="glass-panel hero-panel">
        <div className="hero-copy">
          <img alt="Bit Lazarus" className="hero-logo-image" src={logoUrl} />
          <p className="eyebrow">Torrent recovery, settled on-chain</p>
          <h1 className="hero-title">
            Put a bounty on a <em>dead torrent</em> — and bring it back.
          </h1>
          <p className="hero-lede">
            Bit Lazarus turns a forgotten .torrent into a fundable bounty: wallet auth, an ENS
            name derived from the infohash, peer-to-peer WebTorrent delivery, a Walrus archive,
            and Arc USDC escrow that only pays out once the file is hash-verified.
          </p>

          {!token ? (
            <form className="home-cta-row" onSubmit={handleWalletLogin}>
              <button className="primary-button" disabled={loading} type="submit">
                {loading ? "Connecting…" : "Connect wallet"}
              </button>
              <Link className="secondary-button" to="/marketplace">
                Browse bounties
              </Link>
            </form>
          ) : (
            <div className="home-cta-row">
              <Link className="primary-button" to="/marketplace">
                Browse bounties
              </Link>
              <Link className="secondary-button" to="/bounties/new">
                Post a bounty
              </Link>
            </div>
          )}

          {token && currentUser ? (
            <p className="hero-session">
              Connected as {currentUser.displayName ?? currentUser.walletAddress}
            </p>
          ) : (
            <label className="field hero-name-field">
              <span>Display name (optional)</span>
              <input
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Requester or Hunter"
                value={displayName}
              />
            </label>
          )}
        </div>
      </section>

      <section className="glass-panel stack">
        <div className="panel-head">
          <p className="eyebrow">How it works</p>
          <h2>Three steps from dead link to delivered file</h2>
        </div>
        <div className="howto-grid">
          {HOW_IT_WORKS.map((step, index) => (
            <article className="howto-card" key={step.title}>
              <span className="howto-index">{String(index + 1).padStart(2, "0")}</span>
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
    </main>
  );
}
