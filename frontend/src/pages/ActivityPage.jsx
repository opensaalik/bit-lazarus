import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import BountyCard from "../components/BountyCard.jsx";
import { requestJson } from "../lib/api.js";
import { useApp } from "../context/AppContext.jsx";

export default function ActivityPage() {
  const { token } = useApp();
  const [created, setCreated] = useState([]);
  const [hunting, setHunting] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) {
      setCreated([]);
      setHunting([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      requestJson("/bounties?created=me", { token }),
      requestJson("/bounties?hunting=me", { token }),
    ])
      .then(([createdPayload, huntingPayload]) => {
        if (cancelled) return;
        setCreated(createdPayload.bounties);
        setHunting(huntingPayload.bounties);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <main className="page-main">
        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Activity</p>
            <h2>Wallet required</h2>
          </div>
          <p className="muted-copy">Connect from Home to see bounties you created or joined as a hunter.</p>
          <Link className="primary-button" to="/">
            Go to Home
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="page-main activity-main">
      <section className="glass-panel stack">
        <div className="panel-head">
          <p className="eyebrow">My activity</p>
          <h2>Your listings and hunts</h2>
        </div>
        {error ? <p className="muted-copy">{error}</p> : null}
        {loading ? <p className="muted-copy">Loading…</p> : null}
      </section>

      <section className="glass-panel stack">
        <div className="panel-head">
          <p className="eyebrow">Created by you</p>
          <h3>Listings</h3>
        </div>
        <div className="bounty-list">
          {created.length === 0 ? (
            <article className="bounty-card empty">
              <p className="muted-copy">You have not posted a bounty yet.</p>
              <Link className="primary-button" to="/bounties/new">
                Create one
              </Link>
            </article>
          ) : (
            created.map((bounty) => <BountyCard bounty={bounty} compact key={bounty.id} />)
          )}
        </div>
      </section>

      <section className="glass-panel stack">
        <div className="panel-head">
          <p className="eyebrow">Hunting</p>
          <h3>Bounties you joined</h3>
        </div>
        <div className="bounty-list">
          {hunting.length === 0 ? (
            <article className="bounty-card empty">
              <p className="muted-copy">Join hunts from the marketplace or a bounty page.</p>
              <Link className="secondary-button" to="/marketplace">
                Browse marketplace
              </Link>
            </article>
          ) : (
            hunting.map((bounty) => <BountyCard bounty={bounty} compact key={bounty.id} />)
          )}
        </div>
      </section>
    </main>
  );
}
