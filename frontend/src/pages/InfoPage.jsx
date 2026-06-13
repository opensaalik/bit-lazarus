import { Link } from "react-router-dom";

const USES = [
  { name: "ENS", body: "Every torrent infohash derives a stable ENS name, so a recovery is resolvable forever." },
  { name: "WebTorrent", body: "Recovered files move peer-to-peer, browser to browser - no central server in the middle." },
  { name: "Walrus", body: "Once verified, the file is archived to Walrus for durable, content-addressed storage." },
  { name: "Arc", body: "USDC escrow on Arc locks the reward and only pays out on a verified hash match." },
];

const STEPS = [
  { title: "Post a bounty", body: "Upload a dead .torrent and stake a USDC reward. Arc seals the escrow." },
  { title: "Hunt & seed", body: "A hunter who still has the data joins and seeds it back over WebTorrent." },
  { title: "Verify & settle", body: "The browser checks SHA-256, archives to Walrus, and Arc releases the reward." },
];

export default function InfoPage() {
  return (
    <main className="page-main">
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
