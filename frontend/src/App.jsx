import { Suspense, lazy, startTransition, useEffect, useState } from "react";

import { addTorrent } from "./lib/webtorrent-client.js";
import {
  generatePieceProof,
  parseTorrentMetadata,
  verifyPieceProofFromRound,
} from "./lib/torrent-piece-proof.js";

const HeroScene = lazy(() => import("./HeroScene.jsx"));

const initialBountyForm = {
  title: "",
  description: "",
  torrentInfoHash: "",
  torrentName: "",
  rewardSats: "25000",
  missingPieces: "12,15,18",
  tags: "linux,archive",
};

const initialSessionForm = {
  pieceIndexes: "",
};

const initialBondForm = {
  payerBondEscrowId: "",
  hunterBondEscrowId: "",
};

function parseCsvIntegers(value) {
  if (!value.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((piece) => Number.parseInt(piece.trim(), 10))
    .filter((piece) => Number.isInteger(piece));
}

function parseCsvStrings(value) {
  if (!value.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(pathname, {
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    method: options.method ?? "GET",
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  }

  return payload;
}

async function readFileBytes(file) {
  if (!file) {
    throw new Error("a local file is required");
  }

  return new Uint8Array(await file.arrayBuffer());
}

function formatPieceIndexes(values) {
  return values.join(", ");
}

function buildReceiptMessage(contractId, pieceIndex, pieceHashHex) {
  return `deliveryContractId=${contractId}|pieceIndex=${pieceIndex}|pieceHash=${pieceHashHex}`;
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [statusMessage, setStatusMessage] = useState("Warming up the Lazarus relay...");
  const [walletAddress, setWalletAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [challenge, setChallenge] = useState(null);
  const [signature, setSignature] = useState("");
  const [token, setToken] = useState(() => window.localStorage.getItem("bit-lazarus-token") ?? "");
  const [currentUser, setCurrentUser] = useState(null);
  const [bounties, setBounties] = useState([]);
  const [bountyForm, setBountyForm] = useState(initialBountyForm);
  const [loading, setLoading] = useState(false);
  const [protocolLoading, setProtocolLoading] = useState(false);

  const [protocolBountyId, setProtocolBountyId] = useState("");
  const [verificationSessions, setVerificationSessions] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [selectedContractId, setSelectedContractId] = useState("");
  const [sessionForm, setSessionForm] = useState(initialSessionForm);
  const [bondForm, setBondForm] = useState(initialBondForm);

  const [hunterTorrentFile, setHunterTorrentFile] = useState(null);
  const [hunterContentFile, setHunterContentFile] = useState(null);
  const [hunterPieceIndex, setHunterPieceIndex] = useState("0");
  const [hunterTorrentMetadata, setHunterTorrentMetadata] = useState(null);
  const [hunterWebTorrentSummary, setHunterWebTorrentSummary] = useState(null);
  const [generatedProofBundle, setGeneratedProofBundle] = useState(null);

  const [payerTorrentFile, setPayerTorrentFile] = useState(null);
  const [payerTorrentMetadata, setPayerTorrentMetadata] = useState(null);
  const [localVerificationResult, setLocalVerificationResult] = useState(null);
  const [receiptPieceIndex, setReceiptPieceIndex] = useState("0");
  const [receiptSignature, setReceiptSignature] = useState("");

  useEffect(() => {
    requestJson("/health")
      .then((payload) => {
        setHealth(payload);
      })
      .catch((error) => {
        setStatusMessage(error.message);
      });
  }, []);

  useEffect(() => {
    if (!token) {
      setCurrentUser(null);
      setBounties([]);
      setVerificationSessions([]);
      setContracts([]);
      setProtocolBountyId("");
      setSelectedSessionId("");
      setSelectedContractId("");
      window.localStorage.removeItem("bit-lazarus-token");
      return;
    }

    window.localStorage.setItem("bit-lazarus-token", token);

    requestJson("/users/me", { token })
      .then((payload) => {
        startTransition(() => {
          setCurrentUser(payload.user);
          setStatusMessage(`Wallet session active for ${payload.user.walletAddress}`);
        });
      })
      .catch((error) => {
        setToken("");
        setStatusMessage(error.message);
      });

    requestJson("/bounties", { token })
      .then((payload) => {
        startTransition(() => {
          setBounties(payload.bounties);
        });
      })
      .catch((error) => {
        setStatusMessage(error.message);
      });
  }, [token]);

  useEffect(() => {
    if (!protocolBountyId && bounties.length > 0) {
      setProtocolBountyId(bounties[0].id);
    }

    if (protocolBountyId && !bounties.some((bounty) => bounty.id === protocolBountyId)) {
      setProtocolBountyId(bounties[0]?.id ?? "");
    }
  }, [bounties, protocolBountyId]);

  useEffect(() => {
    if (!token || !protocolBountyId) {
      return;
    }

    void refreshProtocolState(protocolBountyId);
  }, [token, protocolBountyId]);

  useEffect(() => {
    if (verificationSessions.length === 0) {
      setSelectedSessionId("");
      return;
    }

    if (!verificationSessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(verificationSessions[0].id);
    }
  }, [verificationSessions, selectedSessionId]);

  useEffect(() => {
    if (contracts.length === 0) {
      setSelectedContractId("");
      return;
    }

    if (!contracts.some((contract) => contract.id === selectedContractId)) {
      setSelectedContractId(contracts[0].id);
    }
  }, [contracts, selectedContractId]);

  const protocolBounty = bounties.find((bounty) => bounty.id === protocolBountyId) ?? null;
  const selectedSession = verificationSessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedContract = contracts.find((contract) => contract.id === selectedContractId) ?? null;

  async function refreshBounties() {
    if (!token) {
      return;
    }

    const payload = await requestJson("/bounties", { token });
    setBounties(payload.bounties);
  }

  async function refreshProtocolState(bountyId) {
    if (!token || !bountyId) {
      return;
    }

    const [sessionsPayload, contractsPayload] = await Promise.all([
      requestJson(`/bounties/${bountyId}/verification-sessions`, { token }),
      requestJson(`/bounties/${bountyId}/contracts`, { token }),
    ]);

    startTransition(() => {
      setVerificationSessions(sessionsPayload.verificationSessions);
      setContracts(contractsPayload.contracts);
    });
  }

  async function inspectTorrentFile(file, setter, summarySetter) {
    const torrentBytes = await readFileBytes(file);
    const metadata = await parseTorrentMetadata(torrentBytes);
    setter(metadata);

    if (!summarySetter) {
      return metadata;
    }

    try {
      const torrent = await addTorrent(file);
      summarySetter({
        infoHash: torrent.infoHash,
        name: torrent.name,
        pieceLength: torrent.pieceLength,
        pieceCount: torrent.pieces.length,
        length: torrent.length,
      });
    } catch (_error) {
      summarySetter(null);
    }

    return metadata;
  }

  async function handleChallengeRequest(event) {
    event.preventDefault();
    setLoading(true);

    try {
      const payload = await requestJson("/auth/challenges", {
        method: "POST",
        body: {
          walletAddress,
        },
      });
      setChallenge(payload.challenge);
      setSignature("");
      setStatusMessage("Challenge issued. Sign it with your wallet or use mock mode for local development.");
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(event) {
    event.preventDefault();
    setLoading(true);

    try {
      const payload = await requestJson("/auth/verify", {
        method: "POST",
        body: {
          challengeId: challenge?.id,
          walletAddress,
          signature,
          displayName,
        },
      });
      setToken(payload.session.token);
      setChallenge(null);
      setSignature("");
      setStatusMessage(`Wallet connected as ${payload.user.displayName ?? payload.user.walletAddress}`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateBounty(event) {
    event.preventDefault();
    setLoading(true);

    try {
      const payload = await requestJson("/bounties", {
        method: "POST",
        token,
        body: {
          title: bountyForm.title,
          description: bountyForm.description,
          torrentInfoHash: bountyForm.torrentInfoHash,
          torrentName: bountyForm.torrentName,
          rewardSats: Number.parseInt(bountyForm.rewardSats, 10),
          missingPieces: parseCsvIntegers(bountyForm.missingPieces),
          tags: parseCsvStrings(bountyForm.tags),
        },
      });
      setBounties((currentBounties) => [payload.bounty, ...currentBounties]);
      setBountyForm(initialBountyForm);
      setStatusMessage(`Bounty created with escrow ${payload.bounty.escrowId}`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAutofillTorrent(event) {
    const file = event.target.files?.[0] ?? null;

    if (!file) {
      return;
    }

    setLoading(true);

    try {
      const metadata = await inspectTorrentFile(file, () => {}, null);
      setBountyForm((current) => ({
        ...current,
        torrentInfoHash: metadata.infoHash,
        torrentName: file.name,
      }));
      setStatusMessage(`Loaded torrent metadata for ${metadata.name}.`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  }

  async function handleHuntBounty(bountyId) {
    setLoading(true);

    try {
      const payload = await requestJson(`/bounties/${bountyId}/hunt`, {
        method: "POST",
        token,
      });
      setBounties((currentBounties) =>
        currentBounties.map((bounty) => (bounty.id === bountyId ? payload.bounty : bounty)),
      );
      setProtocolBountyId(bountyId);
      setStatusMessage("Joined bounty as a hunter.");
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSyncBounty(bountyId) {
    setLoading(true);

    try {
      const payload = await requestJson(`/bounties/${bountyId}/sync-escrow`, {
        method: "POST",
        token,
      });
      setBounties((currentBounties) =>
        currentBounties.map((bounty) => (bounty.id === bountyId ? payload.bounty : bounty)),
      );
      if (protocolBountyId === bountyId) {
        await refreshProtocolState(bountyId);
      }
      setStatusMessage(`Escrow sync complete for ${bountyId}.`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateVerificationSession(event) {
    event.preventDefault();

    if (!protocolBounty) {
      setStatusMessage("Select a bounty first.");
      return;
    }

    setProtocolLoading(true);

    try {
      const payload = await requestJson(`/bounties/${protocolBounty.id}/verification-sessions`, {
        method: "POST",
        token,
        body: {
          pieceIndexes: parseCsvIntegers(sessionForm.pieceIndexes),
        },
      });
      await refreshProtocolState(protocolBounty.id);
      setSelectedSessionId(payload.verificationSession.id);
      setSessionForm(initialSessionForm);
      setStatusMessage(`Verification session ${payload.verificationSession.id} opened.`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setProtocolLoading(false);
    }
  }

  async function handleInspectHunterTorrent(event) {
    const file = event.target.files?.[0] ?? null;
    setHunterTorrentFile(file);
    setGeneratedProofBundle(null);

    if (!file) {
      setHunterTorrentMetadata(null);
      setHunterWebTorrentSummary(null);
      return;
    }

    setProtocolLoading(true);

    try {
      await inspectTorrentFile(file, setHunterTorrentMetadata, setHunterWebTorrentSummary);
      setStatusMessage(`Hunter torrent ready: ${file.name}`);
    } catch (error) {
      setStatusMessage(error.message);
      setHunterTorrentMetadata(null);
      setHunterWebTorrentSummary(null);
    } finally {
      setProtocolLoading(false);
    }
  }

  async function handleInspectPayerTorrent(event) {
    const file = event.target.files?.[0] ?? null;
    setPayerTorrentFile(file);
    setLocalVerificationResult(null);

    if (!file) {
      setPayerTorrentMetadata(null);
      return;
    }

    setProtocolLoading(true);

    try {
      const metadata = await inspectTorrentFile(file, setPayerTorrentMetadata, null);
      setStatusMessage(`Payer verifier loaded ${metadata.name}.`);
    } catch (error) {
      setStatusMessage(error.message);
      setPayerTorrentMetadata(null);
    } finally {
      setProtocolLoading(false);
    }
  }

  async function handleGenerateHunterProof() {
    if (!selectedSession) {
      setStatusMessage("Select a verification session first.");
      return;
    }

    setProtocolLoading(true);

    try {
      const torrentBytes = await readFileBytes(hunterTorrentFile);
      const contentBytes = await readFileBytes(hunterContentFile);
      const pieceIndex = Number.parseInt(hunterPieceIndex, 10);
      const proof = await generatePieceProof({
        torrentBytes,
        contentBytes,
        pieceIndex,
        revealRound: 70,
      });

      const torrentMetadata = hunterTorrentMetadata ?? (await parseTorrentMetadata(torrentBytes));

      if (torrentMetadata.infoHash !== selectedSession.torrentInfoHash) {
        throw new Error("uploaded torrent file does not match the selected verification session");
      }

      if (!selectedSession.pieceIndexes.includes(pieceIndex)) {
        throw new Error(`piece ${pieceIndex} is not part of the selected verification session`);
      }

      const proofArtifacts = {
        torrentInfoHash: torrentMetadata.infoHash,
        torrentName: torrentMetadata.name,
        proofs: [proof],
      };

      setGeneratedProofBundle({
        torrentMetadata,
        proofArtifacts,
      });
      setStatusMessage(`Generated proof for piece ${pieceIndex}. Submit it when ready.`);
    } catch (error) {
      setStatusMessage(error.message);
      setGeneratedProofBundle(null);
    } finally {
      setProtocolLoading(false);
    }
  }

  async function handleSubmitProofArtifacts() {
    if (!selectedSession || !generatedProofBundle) {
      setStatusMessage("Generate a proof bundle first.");
      return;
    }

    setProtocolLoading(true);

    try {
      await requestJson(`/verification-sessions/${selectedSession.id}/proof`, {
        method: "POST",
        token,
        body: {
          proofArtifacts: generatedProofBundle.proofArtifacts,
        },
      });
      await refreshProtocolState(selectedSession.bountyId);
      setStatusMessage(`Proof uploaded for session ${selectedSession.id}.`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setProtocolLoading(false);
    }
  }

  async function handleVerifyProofLocally() {
    if (!selectedSession?.proofArtifacts?.proofs?.length) {
      setStatusMessage("The selected session does not have proof artifacts yet.");
      return;
    }

    if (!payerTorrentFile) {
      setStatusMessage("Load the payer torrent file first.");
      return;
    }

    setProtocolLoading(true);

    try {
      const torrentBytes = await readFileBytes(payerTorrentFile);
      const metadata = payerTorrentMetadata ?? (await parseTorrentMetadata(torrentBytes));

      if (metadata.infoHash !== selectedSession.torrentInfoHash) {
        throw new Error("payer torrent file does not match the selected verification session");
      }

      const proofResults = selectedSession.proofArtifacts.proofs.map((proof) => {
        const expectedPieceHashHex = metadata.pieces[proof.pieceIndex];
        const verification = verifyPieceProofFromRound({
          pieceHashHex: expectedPieceHashHex,
          revealRound: proof.revealRound,
          preBlockState: proof.preBlockState,
          roundRevealState: proof.roundRevealState,
          remainingScheduleWords: proof.remainingScheduleWords,
        });

        return {
          pieceIndex: proof.pieceIndex,
          expectedPieceHashHex,
          ...verification,
        };
      });

      const verifiedPieceIndexes = proofResults.filter((result) => result.valid).map((result) => result.pieceIndex);

      setLocalVerificationResult({
        metadata,
        proofResults,
        verifiedPieceIndexes,
      });
      setStatusMessage(`Locally verified ${verifiedPieceIndexes.length} piece proof(s).`);
    } catch (error) {
      setStatusMessage(error.message);
      setLocalVerificationResult(null);
    } finally {
      setProtocolLoading(false);
    }
  }

  async function handleSubmitVerification() {
    if (!selectedSession || !localVerificationResult) {
      setStatusMessage("Run local verification first.");
      return;
    }

    setProtocolLoading(true);

    try {
      await requestJson(`/verification-sessions/${selectedSession.id}/verify`, {
        method: "POST",
        token,
        body: {
          verifiedPieceIndexes: localVerificationResult.verifiedPieceIndexes,
          verificationSummary: `Verified ${localVerificationResult.verifiedPieceIndexes.length} piece proof(s) against ${localVerificationResult.metadata.name}`,
        },
      });
      await refreshProtocolState(selectedSession.bountyId);
      setStatusMessage(`Payer verification recorded for session ${selectedSession.id}.`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setProtocolLoading(false);
    }
  }

  async function handleCreateContract() {
    if (!selectedSession) {
      setStatusMessage("Select a verification session first.");
      return;
    }

    setProtocolLoading(true);

    try {
      const pieceIndexes = localVerificationResult?.verifiedPieceIndexes?.length
        ? localVerificationResult.verifiedPieceIndexes
        : selectedSession.verifiedPieceIndexes;
      const payload = await requestJson(`/verification-sessions/${selectedSession.id}/contracts`, {
        method: "POST",
        token,
        body: {
          pieceIndexes,
        },
      });
      await refreshProtocolState(selectedSession.bountyId);
      setSelectedContractId(payload.contract.id);
      setReceiptPieceIndex(String(payload.contract.pieceIndexes[0] ?? 0));
      setStatusMessage(`Delivery contract ${payload.contract.id} created.`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setProtocolLoading(false);
    }
  }

  async function handleFundBonds() {
    if (!selectedContract) {
      setStatusMessage("Select a delivery contract first.");
      return;
    }

    setProtocolLoading(true);

    try {
      await requestJson(`/contracts/${selectedContract.id}/bonds`, {
        method: "POST",
        token,
        body: {
          payerBondEscrowId: bondForm.payerBondEscrowId,
          hunterBondEscrowId: bondForm.hunterBondEscrowId,
          payerBondStatus: "FUNDED",
          hunterBondStatus: "FUNDED",
        },
      });
      await refreshProtocolState(selectedContract.bountyId);
      setStatusMessage(`Bond statuses marked FUNDED for contract ${selectedContract.id}.`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setProtocolLoading(false);
    }
  }

  async function handleSubmitReceipt() {
    if (!selectedContract || !currentUser) {
      setStatusMessage("Select a contract and connect the payer wallet first.");
      return;
    }

    const pieceIndex = Number.parseInt(receiptPieceIndex, 10);
    const pieceHashHex =
      payerTorrentMetadata?.pieces?.[pieceIndex] ??
      localVerificationResult?.metadata?.pieces?.[pieceIndex];

    if (!pieceHashHex) {
      setStatusMessage("Load the payer torrent file so the receipt can include the piece hash.");
      return;
    }

    if (!receiptSignature.trim()) {
      setStatusMessage("Paste the payer wallet signature for the receipt message.");
      return;
    }

    const receiptMessage = buildReceiptMessage(selectedContract.id, pieceIndex, pieceHashHex);

    setProtocolLoading(true);

    try {
      await requestJson(`/contracts/${selectedContract.id}/receipts`, {
        method: "POST",
        token,
        body: {
          pieceIndex,
          receiptMessage,
          receiptSignature,
          receiptSignerWalletAddress: currentUser.walletAddress,
        },
      });
      await refreshProtocolState(selectedContract.bountyId);
      setStatusMessage(`Receipt recorded for piece ${pieceIndex}.`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setProtocolLoading(false);
    }
  }

  async function handleLogout() {
    if (!token) {
      return;
    }

    setLoading(true);

    try {
      await requestJson("/auth/logout", {
        method: "POST",
        token,
      });
    } catch (_error) {
      // Clear the local session even if the server-side token is already gone.
    } finally {
      setToken("");
      setStatusMessage("Disconnected wallet session.");
      setLoading(false);
    }
  }

  const openBounties = bounties.filter((bounty) => bounty.status === "OPEN");
  const awaitingFunding = bounties.filter((bounty) => bounty.status === "AWAITING_FUNDING");
  const completedBounties = bounties.filter((bounty) => bounty.status === "COMPLETED");

  return (
    <div className="page-shell">
      <Suspense fallback={<div className="hero-scene hero-scene-fallback" />}>
        <HeroScene />
      </Suspense>
      <header className="hero-grid">
        <div className="hero-copy glass-panel">
          <p className="eyebrow">Bit Lazarus</p>
          <h1>Raise bounty lightning for dead torrents.</h1>
          <p className="hero-text">
            Wallet-linked identities, escrow-backed rewards, and a client-side verification path
            for hunters who can resurrect missing torrent pieces.
          </p>
          <div className="hero-metrics">
            <article>
              <strong>{health?.ok ? "Online" : "Pending"}</strong>
              <span>Node status</span>
            </article>
            <article>
              <strong>{openBounties.length}</strong>
              <span>Open hunts</span>
            </article>
            <article>
              <strong>{awaitingFunding.length}</strong>
              <span>Awaiting funding</span>
            </article>
            <article>
              <strong>{completedBounties.length}</strong>
              <span>Completed</span>
            </article>
          </div>
        </div>

        <aside className="command-column">
          <section className="glass-panel stack">
            <div className="panel-head">
              <p className="eyebrow">Wallet Login</p>
              <h2>Connect your bounty identity</h2>
            </div>

            <form className="stack" onSubmit={handleChallengeRequest}>
              <label className="field">
                <span>Bitcoin wallet address</span>
                <input
                  value={walletAddress}
                  onChange={(event) => setWalletAddress(event.target.value)}
                  placeholder="tb1q..."
                  required
                />
              </label>
              <label className="field">
                <span>Display name</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Torrent necromancer"
                />
              </label>
              <button className="primary-button" disabled={loading} type="submit">
                Issue wallet challenge
              </button>
            </form>

            {challenge ? (
              <form className="stack challenge-panel" onSubmit={handleVerify}>
                <label className="field">
                  <span>Challenge message</span>
                  <textarea readOnly rows={6} value={challenge.message} />
                </label>
                <label className="field">
                  <span>Signature</span>
                  <textarea
                    value={signature}
                    onChange={(event) => setSignature(event.target.value)}
                    placeholder="Paste wallet signature here"
                    rows={4}
                    required
                  />
                </label>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      setSignature(`mock-signature:${walletAddress}:${challenge.message}`);
                    }}
                  >
                    Use mock signature
                  </button>
                  <button className="primary-button" disabled={loading} type="submit">
                    Verify wallet
                  </button>
                </div>
              </form>
            ) : null}

            <div className="status-ribbon">
              <span className="status-dot" />
              <p>{statusMessage}</p>
            </div>
          </section>

          <section className="glass-panel stack">
            <div className="panel-head">
              <p className="eyebrow">Session</p>
              <h2>{currentUser ? currentUser.displayName ?? "Wallet pilot" : "No wallet connected"}</h2>
            </div>
            <p className="muted-copy">
              {currentUser
                ? currentUser.walletAddress
                : "Authenticate with a Bitcoin wallet to create bounties or hunt them."}
            </p>
            <div className="chip-row">
              <span className="chip">Three.js interface</span>
              <span className="chip">Escrow auto-sync</span>
              <span className="chip">Wallet-linked identity</span>
            </div>
            <button className="secondary-button" disabled={!token || loading} onClick={handleLogout} type="button">
              Disconnect
            </button>
          </section>
        </aside>
      </header>

      <main className="dashboard-grid">
        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Create Bounty</p>
            <h2>Post a reseed mission</h2>
          </div>

          <form className="bounty-form" onSubmit={handleCreateBounty}>
            <label className="field field-span-2">
              <span>Title</span>
              <input
                value={bountyForm.title}
                onChange={(event) => setBountyForm({ ...bountyForm, title: event.target.value })}
                placeholder="Need the last blocks of a lost ISO torrent"
                required
              />
            </label>
            <label className="field field-span-2">
              <span>Description</span>
              <textarea
                rows={4}
                value={bountyForm.description}
                onChange={(event) => setBountyForm({ ...bountyForm, description: event.target.value })}
                placeholder="Describe what is missing and what a hunter should reseed."
                required
              />
            </label>
            <label className="field field-span-2">
              <span>Autofill from .torrent</span>
              <input accept=".torrent" onChange={handleAutofillTorrent} type="file" />
            </label>
            <label className="field">
              <span>Torrent info hash</span>
              <input
                value={bountyForm.torrentInfoHash}
                onChange={(event) =>
                  setBountyForm({ ...bountyForm, torrentInfoHash: event.target.value.toLowerCase() })
                }
                placeholder="40-char hex info hash"
                required
              />
            </label>
            <label className="field">
              <span>Torrent name</span>
              <input
                value={bountyForm.torrentName}
                onChange={(event) => setBountyForm({ ...bountyForm, torrentName: event.target.value })}
                placeholder="archive.iso.torrent"
              />
            </label>
            <label className="field">
              <span>Reward sats</span>
              <input
                min="1"
                type="number"
                value={bountyForm.rewardSats}
                onChange={(event) => setBountyForm({ ...bountyForm, rewardSats: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>Missing pieces</span>
              <input
                value={bountyForm.missingPieces}
                onChange={(event) => setBountyForm({ ...bountyForm, missingPieces: event.target.value })}
                placeholder="12,15,18"
              />
            </label>
            <label className="field field-span-2">
              <span>Tags</span>
              <input
                value={bountyForm.tags}
                onChange={(event) => setBountyForm({ ...bountyForm, tags: event.target.value })}
                placeholder="linux,archive,recovery"
              />
            </label>
            <button className="primary-button field-span-2" disabled={!token || loading} type="submit">
              Create bounty with attached escrow
            </button>
          </form>
        </section>

        <section className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Bounty Radar</p>
            <h2>Track hunts and escrow heat</h2>
          </div>

          <div className="bounty-list">
            {bounties.length === 0 ? (
              <article className="bounty-card empty">
                <h3>No bounties loaded yet</h3>
                <p>Connect a wallet and post the first reseed mission.</p>
              </article>
            ) : null}

            {bounties.map((bounty) => (
              <article className="bounty-card" key={bounty.id}>
                <div className="bounty-card-head">
                  <div>
                    <p className="eyebrow">{bounty.status}</p>
                    <h3>{bounty.title}</h3>
                  </div>
                  <strong>{bounty.rewardSats.toLocaleString()} sats</strong>
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
                </div>
                <div className="chip-row">
                  {bounty.tags.map((tag) => (
                    <span className="chip" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    disabled={!token || loading}
                    onClick={() => setProtocolBountyId(bounty.id)}
                    type="button"
                  >
                    Open protocol
                  </button>
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
                    disabled={!token || loading || bounty.status !== "OPEN"}
                    onClick={() => handleHuntBounty(bounty.id)}
                    type="button"
                  >
                    Hunt bounty
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>

      <section className="protocol-grid">
        <article className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Protocol Workbench</p>
            <h2>Generate and verify real piece proofs</h2>
          </div>

          <label className="field">
            <span>Active bounty</span>
            <select
              className="select-field"
              disabled={!token || bounties.length === 0}
              value={protocolBountyId}
              onChange={(event) => setProtocolBountyId(event.target.value)}
            >
              {bounties.map((bounty) => (
                <option key={bounty.id} value={bounty.id}>
                  {bounty.title} [{bounty.status}]
                </option>
              ))}
            </select>
          </label>

          {protocolBounty ? (
            <div className="detail-grid">
              <div>
                <span>Protocol status</span>
                <strong>{protocolBounty.deliveryStatus}</strong>
              </div>
              <div>
                <span>Resolution</span>
                <strong>{protocolBounty.completionReadiness}</strong>
              </div>
              <div>
                <span>Missing pieces</span>
                <strong>{formatPieceIndexes(protocolBounty.missingPieces)}</strong>
              </div>
              <div>
                <span>Escrow</span>
                <code>{protocolBounty.escrowId}</code>
              </div>
            </div>
          ) : (
            <p className="muted-copy">Select a funded bounty to open proof sessions and contracts.</p>
          )}

          <form className="stack" onSubmit={handleCreateVerificationSession}>
            <label className="field">
              <span>Session piece indexes</span>
              <input
                placeholder="0,1,2"
                value={sessionForm.pieceIndexes}
                onChange={(event) => setSessionForm({ pieceIndexes: event.target.value })}
              />
            </label>
            <button className="primary-button" disabled={!token || !protocolBounty || protocolLoading} type="submit">
              Open verification session
            </button>
          </form>

          <div className="protocol-list">
            {verificationSessions.map((session) => (
              <button
                className={`protocol-card ${session.id === selectedSessionId ? "is-active" : ""}`}
                key={session.id}
                onClick={() => setSelectedSessionId(session.id)}
                type="button"
              >
                <span>{session.status}</span>
                <strong>{formatPieceIndexes(session.pieceIndexes)}</strong>
                <small>{session.id}</small>
              </button>
            ))}
          </div>
        </article>

        <article className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Hunter Console</p>
            <h2>Produce a proof from local torrent data</h2>
          </div>

          <label className="field">
            <span>.torrent file</span>
            <input accept=".torrent" onChange={handleInspectHunterTorrent} type="file" />
          </label>
          <label className="field">
            <span>Matching content file</span>
            <input onChange={(event) => setHunterContentFile(event.target.files?.[0] ?? null)} type="file" />
          </label>
          <label className="field">
            <span>Piece index</span>
            <input
              min="0"
              type="number"
              value={hunterPieceIndex}
              onChange={(event) => setHunterPieceIndex(event.target.value)}
            />
          </label>

          {hunterTorrentMetadata ? (
            <div className="detail-grid">
              <div>
                <span>Info hash</span>
                <code>{hunterTorrentMetadata.infoHash}</code>
              </div>
              <div>
                <span>Piece count</span>
                <strong>{hunterTorrentMetadata.pieceCount}</strong>
              </div>
              <div>
                <span>Piece length</span>
                <strong>{hunterTorrentMetadata.pieceLength}</strong>
              </div>
              <div>
                <span>Name</span>
                <strong>{hunterTorrentMetadata.name}</strong>
              </div>
            </div>
          ) : null}

          {hunterWebTorrentSummary ? (
            <div className="detail-grid">
              <div>
                <span>WebTorrent name</span>
                <strong>{hunterWebTorrentSummary.name}</strong>
              </div>
              <div>
                <span>WebTorrent length</span>
                <strong>{hunterWebTorrentSummary.length}</strong>
              </div>
            </div>
          ) : null}

          <div className="button-row">
            <button
              className="secondary-button"
              disabled={!selectedSession || protocolLoading}
              onClick={handleGenerateHunterProof}
              type="button"
            >
              Generate proof
            </button>
            <button
              className="primary-button"
              disabled={!generatedProofBundle || protocolLoading}
              onClick={handleSubmitProofArtifacts}
              type="button"
            >
              Submit proof
            </button>
          </div>

          <label className="field">
            <span>Generated proof artifact</span>
            <textarea
              readOnly
              rows={12}
              value={generatedProofBundle ? prettyJson(generatedProofBundle.proofArtifacts) : ""}
            />
          </label>
        </article>

        <article className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Payer Console</p>
            <h2>Verify proof and advance the contract</h2>
          </div>

          <label className="field">
            <span>Selected session</span>
            <textarea
              readOnly
              rows={8}
              value={selectedSession ? prettyJson(selectedSession) : ""}
            />
          </label>

          <label className="field">
            <span>Payer .torrent file</span>
            <input accept=".torrent" onChange={handleInspectPayerTorrent} type="file" />
          </label>

          <div className="button-row">
            <button
              className="secondary-button"
              disabled={!selectedSession || protocolLoading}
              onClick={handleVerifyProofLocally}
              type="button"
            >
              Verify locally
            </button>
            <button
              className="primary-button"
              disabled={!localVerificationResult || protocolLoading}
              onClick={handleSubmitVerification}
              type="button"
            >
              Record verification
            </button>
            <button
              className="primary-button"
              disabled={!selectedSession || protocolLoading}
              onClick={handleCreateContract}
              type="button"
            >
              Create contract
            </button>
          </div>

          <label className="field">
            <span>Local verification result</span>
            <textarea
              readOnly
              rows={12}
              value={localVerificationResult ? prettyJson(localVerificationResult) : ""}
            />
          </label>
        </article>

        <article className="glass-panel stack">
          <div className="panel-head">
            <p className="eyebrow">Contract Console</p>
            <h2>Fund bonds and submit receipts</h2>
          </div>

          <div className="protocol-list">
            {contracts.map((contract) => (
              <button
                className={`protocol-card ${contract.id === selectedContractId ? "is-active" : ""}`}
                key={contract.id}
                onClick={() => {
                  setSelectedContractId(contract.id);
                  setReceiptPieceIndex(String(contract.pieceIndexes[0] ?? 0));
                }}
                type="button"
              >
                <span>{contract.state}</span>
                <strong>{formatPieceIndexes(contract.pieceIndexes)}</strong>
                <small>{contract.id}</small>
              </button>
            ))}
          </div>

          <label className="field">
            <span>Selected contract</span>
            <textarea
              readOnly
              rows={10}
              value={selectedContract ? prettyJson(selectedContract) : ""}
            />
          </label>

          <label className="field">
            <span>Payer bond escrow id</span>
            <input
              placeholder="payer-bond-testnet"
              value={bondForm.payerBondEscrowId}
              onChange={(event) => setBondForm((current) => ({ ...current, payerBondEscrowId: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Hunter bond escrow id</span>
            <input
              placeholder="hunter-bond-testnet"
              value={bondForm.hunterBondEscrowId}
              onChange={(event) =>
                setBondForm((current) => ({ ...current, hunterBondEscrowId: event.target.value }))
              }
            />
          </label>
          <button className="secondary-button" disabled={!selectedContract || protocolLoading} onClick={handleFundBonds} type="button">
            Mark both bonds funded
          </button>

          <label className="field">
            <span>Receipt piece index</span>
            <input
              min="0"
              type="number"
              value={receiptPieceIndex}
              onChange={(event) => setReceiptPieceIndex(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Receipt signature</span>
            <textarea
              rows={5}
              value={receiptSignature}
              onChange={(event) => setReceiptSignature(event.target.value)}
              placeholder="Paste the payer wallet signature for the receipt message"
            />
          </label>
          <label className="field">
            <span>Receipt message</span>
            <textarea
              readOnly
              rows={4}
              value={
                selectedContract
                  ? buildReceiptMessage(
                      selectedContract.id,
                      Number.parseInt(receiptPieceIndex || "0", 10),
                      payerTorrentMetadata?.pieces?.[Number.parseInt(receiptPieceIndex || "0", 10)] ?? "load-torrent-first",
                    )
                  : ""
              }
            />
          </label>
          <button className="primary-button" disabled={!selectedContract || protocolLoading} onClick={handleSubmitReceipt} type="button">
            Submit signed receipt
          </button>
        </article>
      </section>
    </div>
  );
}
