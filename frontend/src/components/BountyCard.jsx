import { Link } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";
import StatusRune from "./StatusRune.jsx";

export default function BountyCard({ bounty, compact = false, hideActions = false }) {
  const { currentUser, token, loading, handleHuntBounty, formatBytes } = useApp();

  const hunters = Array.isArray(bounty.hunters) ? bounty.hunters : [];
  const tags = Array.isArray(bounty.tags) ? bounty.tags : [];
  const isCreator = bounty.creatorUserId === currentUser?.id;
  const pieceCount = Number.isFinite(bounty.torrentMeta?.pieceCount) ? bounty.torrentMeta.pieceCount : null;
  const rewardValue = Number.isFinite(bounty.rewardAmountUnits)
    ? (bounty.rewardAmountUnits / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })
    : null;
  const rewardToken = bounty.rewardToken ?? "USDC";

  return (
    <article className={`bounty-card${compact ? " bounty-card-compact" : ""}`}>
      <div className="bounty-card-head">
        <div>
          <div className="bounty-card-eyebrow">
            <StatusRune value={bounty.status} />
            {isCreator ? <span className="role-pill">Your listing</span> : null}
            {!isCreator && bounty.status === "OPEN" ? (
              <span className="role-pill role-pill-open">Open to hunt</span>
            ) : null}
          </div>
          <h3>{bounty.title}</h3>
        </div>
        <div className="bounty-reward">
          <strong>{rewardValue ?? "—"}</strong>
          <span>{rewardToken} reward</span>
        </div>
      </div>

      {bounty.description ? <p className="bounty-description">{bounty.description}</p> : null}

      <div className="detail-grid">
        <div>
          <span>Info hash</span>
          <code>{bounty.torrentInfoHash}</code>
        </div>
        <div>
          <span>Escrow</span>
          <code>{bounty.escrowStatus}</code>
        </div>
        <div>
          <span>Hunters</span>
          <strong>{hunters.length}</strong>
        </div>
        <div>
          <span>Pieces</span>
          <strong>{pieceCount == null ? "—" : pieceCount.toLocaleString()}</strong>
        </div>
        {bounty.torrentMeta?.totalSize ? (
          <div>
            <span>Total size</span>
            <strong>{formatBytes(bounty.torrentMeta.totalSize)}</strong>
          </div>
        ) : null}
        {bounty.torrentMeta?.files?.length ? (
          <div>
            <span>Files</span>
            <strong>{bounty.torrentMeta.files.length}</strong>
          </div>
        ) : null}
      </div>

      {tags.length ? (
        <div className="chip-row">
          {tags.map((tag) => (
            <span className="chip" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {compact ? (
        <div className="bounty-card-footer">
          <Link className="primary-button bounty-open-link" to={`/bounties/${bounty.id}`}>
            View bounty
          </Link>
        </div>
      ) : hideActions ? null : (
        <div className="button-row">
          {bounty.hasTorrentFile ? (
            <a className="secondary-button" href={`/bounties/${bounty.id}/torrent`} download>
              Download .torrent
            </a>
          ) : null}
          <button
            className="primary-button"
            disabled={!token || loading || bounty.status !== "OPEN" || isCreator}
            onClick={() => handleHuntBounty(bounty.id)}
            type="button"
            title={isCreator ? "You created this bounty" : undefined}
          >
            Hunt bounty
          </button>
        </div>
      )}
    </article>
  );
}
