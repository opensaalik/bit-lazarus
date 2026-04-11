import bencode from "bencode";

import {
  generatePieceProofFromInputs,
  normalizeTorrentName,
  splitPieceHashes,
  verifyPieceProofFromRound,
} from "../../../src/torrent-piece-proof-core.js";

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function computeSha1Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function readTorrentInfo(decoded) {
  const info = decoded.info;

  if (!info) {
    throw new Error("torrent file is missing info metadata");
  }

  if (Array.isArray(info.files) && info.files.length > 0) {
    throw new Error("multi-file torrents are not supported in the browser proof flow yet");
  }

  return info;
}

export async function parseTorrentMetadata(torrentBytes) {
  if (!(torrentBytes instanceof Uint8Array)) {
    throw new Error("torrentBytes is required");
  }

  const decoded = bencode.decode(torrentBytes);
  const info = readTorrentInfo(decoded);
  const encodedInfo = bencode.encode(info);
  const infoHash = await computeSha1Hex(encodedInfo);

  return {
    infoHash,
    name: normalizeTorrentName(info.name),
    pieceLength: Number(info["piece length"]),
    totalLength: Number(info.length),
    pieceCount: Math.floor(info.pieces.length / 20),
    pieces: splitPieceHashes(info.pieces),
  };
}

export async function generatePieceProof({
  torrentBytes,
  contentBytes,
  pieceIndex,
  revealRound = 70,
} = {}) {
  const torrentMetadata = await parseTorrentMetadata(torrentBytes);

  return generatePieceProofFromInputs({
    contentBytes,
    torrentMetadata,
    pieceIndex,
    revealRound,
    sha1DigestHex: computeSha1Hex,
  });
}

export { verifyPieceProofFromRound };
