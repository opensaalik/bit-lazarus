import { Link } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";

export default function BountyCard({ bounty, compact = false, hideActions = false }) {
  const {
    currentUser,
    token,
    loading,
    handleFundEscrow,
    handleSyncBounty,
    handleHuntBounty,
    hasWebLn,
    health,
    formatBytes,
  } = useApp();

  const isCreator = bounty.creatorUserId === currentUser?.id;

  return (
    <article className={`bounty-card${compact ? " bounty-card-compact" : ""}`}>
      <div className="bounty-card-head">
        <div>
          <p className="eyebrow bounty-card-eyebrow">
            {bounty.status}
            {isCreator ? <span className="role-pill">Your listing</span> : null}
            {!isCreator && bounty.status === "OPEN" ? <span className="role-pill role-pill-open">Open to hunt</span> : null}
          </p>
          <h3>{bounty.title}</h3>
        </div>
        <div className="bounty-sats">
          <strong>{bounty.rewardSats.toLocaleString()} sats</strong>
          {bounty.bondAmountSats ? (
            <span className="bond-chip">{bounty.bondAmountSats.toLocaleString()} sats bond</span>
          ) : null}
        </div>
      </div>
      <p className="bounty-description">{bounty.description}</p>
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
          <strong>{bounty.hunters.length}</strong>
        </div>
        <div>
          <span>Pieces</span>
          <strong>{bounty.missingPieces.length}</strong>
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
      <div className="chip-row">
        {bounty.tags.map((tag) => (
          <span className="chip" key={tag}>{tag}</span>
        ))}
      </div>
      {compact ? (
        <div className="bounty-card-footer">
          <Link className="primary-button bounty-open-link" to={`/bounties/${bounty.id}`}>
            View bounty
          </Link>
        </div>
      ) : hideActions ? null : (
        <div className="button-row">
          {bounty.escrowStatus === "AWAITING_FUNDING" && isCreator ? (
            <button
              className="primary-button"
              disabled={!token || loading}
              onClick={() => handleFundEscrow(bounty)}
              type="button"
            >
              {hasWebLn
                ? "Fund escrow via Alby"
                : health?.demoCapabilities?.backendPayments
                  ? "Fund escrow from Polar"
                  : "Copy invoice"}
            </button>
          ) : null}
          {bounty.hasTorrentFile ? (
            <a
              className="secondary-button"
              href={`/bounties/${bounty.id}/torrent`}
              download
            >
              Download .torrent
            </a>
          ) : null}
          <button
            className="secondary-button"
            disabled={!token || loading}
            onClick={() => handleSyncBounty(bounty.id)}
            type="button"
          >
            Sync escrow
          </button>
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
