import crypto from "node:crypto";
import bencode from "bencode";

import {
  generatePieceProofFromInputs,
  normalizeTorrentName,
  splitPieceHashes,
  getPieceData,
  verifyPieceProofFromRound,
} from "./torrent-piece-proof-core.js";

function computeSha1Hex(bytes) {
  return crypto.createHash("sha1").update(Buffer.from(bytes)).digest("hex");
}

export function parseTorrentMetadata(torrentBuffer) {
  if (!Buffer.isBuffer(torrentBuffer)) {
    throw new Error("torrentBuffer is required");
  }

  const decoded = bencode.decode(torrentBuffer);
  const info = decoded.info;
  const infoHash = crypto.createHash("sha1").update(bencode.encode(info)).digest("hex");

  return {
    infoHash,
    name: normalizeTorrentName(info.name),
    pieceLength: Number(info["piece length"]),
    totalLength: Number(info.length),
    pieceCount: Math.floor(info.pieces.length / 20),
    pieces: splitPieceHashes(info.pieces),
  };
}

export { getPieceData, verifyPieceProofFromRound };

export async function generatePieceProof({
  torrentBuffer,
  contentBuffer,
  pieceIndex,
  revealRound = 70,
} = {}) {
  if (!Buffer.isBuffer(torrentBuffer)) {
    throw new Error("torrentBuffer is required");
  }

  if (!Buffer.isBuffer(contentBuffer)) {
    throw new Error("contentBuffer is required");
  }

  const torrentMetadata = parseTorrentMetadata(torrentBuffer);

  return generatePieceProofFromInputs({
    contentBytes: contentBuffer,
    torrentMetadata,
    pieceIndex,
    revealRound,
    sha1DigestHex: computeSha1Hex,
  });
}
