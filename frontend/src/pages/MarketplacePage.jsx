import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import BountyCard from "../components/BountyCard.jsx";
import { useApp } from "../context/AppContext.jsx";
import { requestJson } from "../lib/api.js";
import { downloadArchiveResource } from "../lib/walrus.js";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "OPEN", label: "Open" },
  { value: "AWAITING_FUNDING", label: "Awaiting funding" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELED", label: "Canceled" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "reward", label: "Highest reward" },
  { value: "oldest", label: "Oldest first" },
];

function isLocatorQuery(value) {
  const query = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(query) || /^btih-[0-9a-f]{40}\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(query);
}

function getBountyEnsName(bounty) {
  return bounty?.resourceLocator?.ensName ?? "";
}

export default function MarketplacePage() {
  const { bounties, token, setStatusMessage } = useApp();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("newest");
  const [locatorLookup, setLocatorLookup] = useState({
    phase: "idle",
    query: "",
    resolution: null,
    bounty: null,
    error: null,
  });

  useEffect(() => {
    const locator = query.trim();

    if (!token || !isLocatorQuery(locator)) {
      setLocatorLookup({
        phase: "idle",
        query: "",
        resolution: null,
        bounty: null,
        error: null,
      });
      return undefined;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      setLocatorLookup({
        phase: "loading",
        query: locator,
        resolution: null,
        bounty: null,
        error: null,
      });

      try {
        const payload = await requestJson(`/resources/resolve?locator=${encodeURIComponent(locator)}`, { token });

        if (!cancelled) {
          setLocatorLookup({
            phase: "ready",
            query: locator,
            resolution: payload.resolution,
            bounty: payload.bounty,
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setLocatorLookup({
            phase: "error",
            query: locator,
            resolution: null,
            bounty: null,
            error: error.message,
          });
        }
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [query, token]);

  const filtered = useMemo(() => {
    let list = [...bounties];
    const q = query.trim().toLowerCase();

    if (q) {
      list = list.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.torrentInfoHash.toLowerCase().includes(q) ||
          b.description.toLowerCase().includes(q) ||
          getBountyEnsName(b).toLowerCase().includes(q),
      );
    }

    if (statusFilter !== "all") {
      list = list.filter((b) => b.status === statusFilter);
    }

    if (sort === "newest") {
      list.sort((a, b) => String(b.id).localeCompare(String(a.id)));
    } else if (sort === "oldest") {
      list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    } else if (sort === "reward") {
      list.sort((a, b) => (b.rewardAmountUnits ?? 0) - (a.rewardAmountUnits ?? 0));
    }

    return list;
  }, [bounties, query, statusFilter, sort]);

  async function handleDownloadLookupArchive() {
    const torrentInfoHash = locatorLookup.resolution?.torrentInfoHash;

    if (!torrentInfoHash) {
      return;
    }

    try {
      setStatusMessage(`Downloading archive for ${locatorLookup.resolution.ensName}.`);
      await downloadArchiveResource({
        token,
        torrentInfoHash,
        filename: locatorLookup.bounty?.torrentName ?? locatorLookup.bounty?.title,
      });
      setStatusMessage("Archive download started.");
    } catch (error) {
      setStatusMessage(error.message);
      setLocatorLookup((current) => ({
        ...current,
        error: error.message,
      }));
    }
  }

  const lookupResolution = locatorLookup.resolution;

  return (
    <main className="page-main marketplace-main">
      <section className="glass-panel stack">
        <div className="panel-head">
          <p className="eyebrow">Marketplace</p>
          <h2>Recovery bounties</h2>
        </div>
        <p className="muted-copy">
          Filter by status, search by title or info hash, then open a bounty to fund, hunt, or verify delivery.
          {!token ? " Connect a wallet to take actions." : null}
        </p>

        <div className="marketplace-toolbar">
          <label className="field marketplace-search">
            <span>Search</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Title, description, info hash, or ENS name"
              type="search"
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {locatorLookup.phase !== "idle" ? (
          <article className="bounty-card">
            <div>
              <span className="role-pill role-pill-open">ENS lookup</span>
              <h3>{lookupResolution?.ensName ?? locatorLookup.query}</h3>
              {locatorLookup.phase === "loading" ? (
                <p className="muted-copy">Resolving ENS resource...</p>
              ) : null}
              {locatorLookup.error ? <p className="muted-copy">{locatorLookup.error}</p> : null}
              {lookupResolution?.mode === "walrus" ? (
                <p className="muted-copy">
                  This ENS name points to an archived Walrus blob for torrent {lookupResolution.torrentInfoHash}.
                </p>
              ) : null}
              {lookupResolution?.mode === "torrent" ? (
                <p className="muted-copy">
                  This ENS name points to an active torrent resource{locatorLookup.bounty ? "." : ", but no local bounty is listed yet."}
                </p>
              ) : null}
            </div>
            <div className="button-row">
              {locatorLookup.bounty ? (
                <Link className="secondary-button" to={`/bounties/${locatorLookup.bounty.id}`}>
                  Open bounty
                </Link>
              ) : null}
              {lookupResolution?.mode === "walrus" ? (
                <button className="primary-button" disabled={!token} onClick={handleDownloadLookupArchive} type="button">
                  Download archived file
                </button>
              ) : null}
            </div>
          </article>
        ) : null}

        <div className="bounty-list">
          {filtered.length === 0 ? (
            <article className="bounty-card empty">
              <h3>No bounties yet</h3>
              <p className="muted-copy">Try clearing your search, or post a new bounty.</p>
            </article>
          ) : (
            filtered.map((bounty) => <BountyCard bounty={bounty} compact key={bounty.id} />)
          )}
        </div>
      </section>
    </main>
  );
}
