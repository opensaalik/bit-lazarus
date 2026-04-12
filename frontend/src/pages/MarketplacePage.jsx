import { useMemo, useState } from "react";
import BountyCard from "../components/BountyCard.jsx";
import { useApp } from "../context/AppContext.jsx";

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

export default function MarketplacePage() {
  const { bounties, token } = useApp();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("newest");

  const filtered = useMemo(() => {
    let list = [...bounties];
    const q = query.trim().toLowerCase();

    if (q) {
      list = list.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.torrentInfoHash.toLowerCase().includes(q) ||
          b.description.toLowerCase().includes(q),
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
      list.sort((a, b) => b.rewardSats - a.rewardSats);
    }

    return list;
  }, [bounties, query, statusFilter, sort]);

  return (
    <main className="page-main marketplace-main">
      <section className="glass-panel stack">
        <div className="panel-head">
          <p className="eyebrow">Marketplace</p>
          <h2>Browse resurrection bounties</h2>
        </div>
        <p className="muted-copy">
          Filter by status, search by title or info hash, then open a bounty to fund, hunt, or sync escrow.
          {!token ? " Connect a wallet to take actions." : null}
        </p>

        <div className="marketplace-toolbar">
          <label className="field marketplace-search">
            <span>Search</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Title, description, or info hash"
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

        <div className="bounty-list">
          {filtered.length === 0 ? (
            <article className="bounty-card empty">
              <h3>No bounties match</h3>
              <p>Try clearing search or listing a new bounty.</p>
            </article>
          ) : (
            filtered.map((bounty) => <BountyCard bounty={bounty} compact key={bounty.id} />)
          )}
        </div>
      </section>
    </main>
  );
}
