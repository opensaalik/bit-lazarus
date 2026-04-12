import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import BountyCard from "../components/BountyCard.jsx";
import { requestJson } from "../lib/api.js";
import { useApp } from "../context/AppContext.jsx";

export default function BountyDetailPage() {
  const { bountyId } = useParams();
  const { token, mergeBounty, bounties } = useApp();
  const [bounty, setBounty] = useState(() => bounties.find((b) => b.id === bountyId) ?? null);
  const [loadError, setLoadError] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(true);

  useEffect(() => {
    const fromList = bounties.find((b) => b.id === bountyId);
    if (fromList) {
      setBounty(fromList);
    }
  }, [bounties, bountyId]);

  useEffect(() => {
    if (!token || !bountyId) {
      setLoadingDetail(false);
      return;
    }

    let cancelled = false;
    setLoadingDetail(true);
    setLoadError(null);

    requestJson(`/bounties/${bountyId}`, { token })
      .then((payload) => {
        if (cancelled) return;
        setBounty(payload.bounty);
        mergeBounty(payload.bounty);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, bountyId, mergeBounty]);

  if (!token) {
    return (
      <main className="page-main">
        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Bounty</p>
            <h2>Authentication required</h2>
          </div>
          <p className="muted-copy">Connect your wallet from Home to view this bounty.</p>
          <Link className="primary-button" to="/">
            Go to Home
          </Link>
        </section>
      </main>
    );
  }

  if (loadingDetail && !bounty) {
    return (
      <main className="page-main">
        <section className="glass-panel stack">
          <p className="muted-copy">Loading bounty…</p>
        </section>
      </main>
    );
  }

  if (loadError && !bounty) {
    return (
      <main className="page-main">
        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Bounty</p>
            <h2>Could not load</h2>
          </div>
          <p className="muted-copy">{loadError}</p>
          <Link className="secondary-button" to="/marketplace">
            Back to marketplace
          </Link>
        </section>
      </main>
    );
  }

  if (!bounty) {
    return (
      <main className="page-main">
        <section className="glass-panel stack">
          <p className="muted-copy">Bounty not found.</p>
          <Link className="secondary-button" to="/marketplace">
            Back to marketplace
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="page-main">
      <div className="detail-back">
        <Link className="secondary-button detail-back-link" to="/marketplace">
          ← Marketplace
        </Link>
      </div>
      <section className="glass-panel detail-panel">
        <BountyCard bounty={bounty} />
      </section>
    </main>
  );
}
