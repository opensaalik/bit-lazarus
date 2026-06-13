import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";
import { downloadArchiveResource } from "../lib/walrus.js";

export default function CreateBountyPage() {
  const navigate = useNavigate();
  const {
    token,
    loading,
    torrentMeta,
    rewardAmountUsdc,
    setRewardAmountUsdc,
    bountyDescription,
    setBountyDescription,
    dragOver,
    setDragOver,
    handleCreateBounty,
    handleDrop,
    handleFileSelect,
    clearTorrent,
    formatBytes,
  } = useApp();

  async function onSubmit(event) {
    await handleCreateBounty(event, {
      onCreated: (bounty) => {
        navigate(`/bounties/${bounty.id}`, { replace: true });
      },
      onArchiveHit: async () => {
        await downloadArchiveResource({
          token,
          torrentInfoHash: torrentMeta.infoHash,
          filename: torrentMeta.name,
        });
      },
    });
  }

  return (
    <main className="page-main">
      <section className="glass-panel stack">
        <div className="panel-head">
          <p className="eyebrow">Create Bounty</p>
          <h2>Resurrect a dead torrent</h2>
        </div>
        <p className="muted-copy">
          Upload a real .torrent file and set the USDC reward that will settle through Arc.
          You will jump to the bounty page when it is created.
        </p>

        <form className="bounty-form" onSubmit={onSubmit}>
          {torrentMeta ? (
            <div className="torrent-preview field-span-2">
              <div className="torrent-preview-head">
                <h3>{torrentMeta.name}</h3>
                <button type="button" className="clear-button" onClick={clearTorrent} title="Remove">
                  x
                </button>
              </div>
              <span className="chip">.torrent file</span>
              <div className="detail-grid">
                <div>
                  <span>Info hash</span>
                  <code>{torrentMeta.infoHash}</code>
                </div>
                {torrentMeta.totalSize > 0 ? (
                  <div>
                    <span>Size</span>
                    <strong>{formatBytes(torrentMeta.totalSize)}</strong>
                  </div>
                ) : null}
                {torrentMeta.pieceCount > 0 ? (
                  <div>
                    <span>Pieces</span>
                    <strong>{torrentMeta.pieceCount.toLocaleString()}</strong>
                  </div>
                ) : null}
                {torrentMeta.files.length > 0 ? (
                  <div>
                    <span>Files</span>
                    <strong>{torrentMeta.files.length}</strong>
                  </div>
                ) : null}
              </div>
              {torrentMeta.files.length > 0 ? (
                <details className="file-list">
                  <summary>
                    {torrentMeta.files.length} file{torrentMeta.files.length !== 1 ? "s" : ""}
                  </summary>
                  <ul>
                    {torrentMeta.files.slice(0, 20).map((f, i) => (
                      <li key={i}>
                        <code>{f.path}</code> <span className="muted-copy">{formatBytes(f.length)}</span>
                      </li>
                    ))}
                    {torrentMeta.files.length > 20 ? (
                      <li className="muted-copy">...and {torrentMeta.files.length - 20} more</li>
                    ) : null}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : (
            <div className="torrent-input-group field-span-2">
              <div
                className={`drop-zone${dragOver ? " drag-over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => document.getElementById("torrent-file-input-page")?.click()}
              >
                <input
                  id="torrent-file-input-page"
                  type="file"
                  accept=".torrent"
                  onChange={handleFileSelect}
                  style={{ display: "none" }}
                />
                <div className="drop-zone-prompt">
                  <p>
                    <strong>Drop a .torrent file here</strong>
                  </p>
                  <p className="muted-copy">or click to browse</p>
                </div>
              </div>
            </div>
          )}

          <label className="field field-span-2">
            <span>Description (optional)</span>
            <textarea
              rows={3}
              value={bountyDescription}
              onChange={(e) => setBountyDescription(e.target.value)}
              placeholder="Any context for hunters — where to find the data, which files matter most, etc."
            />
          </label>
          <label className="field">
            <span>Reward (USDC)</span>
            <input
              min="0.000001"
              step="0.000001"
              type="number"
              value={rewardAmountUsdc}
              onChange={(e) => setRewardAmountUsdc(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Settlement token</span>
            <input
              readOnly
              value="USDC on Arc"
              className="muted-input"
            />
          </label>
          <button
            className="primary-button field-span-2"
            disabled={!token || loading || !torrentMeta}
            type="submit"
          >
            {torrentMeta ? "Create Bounty" : "Upload .torrent file"}
          </button>
        </form>
      </section>
    </main>
  );
}
