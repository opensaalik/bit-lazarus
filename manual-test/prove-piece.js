import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  generatePieceProof,
  parseTorrentMetadata,
  verifyPieceProofFromRound,
} from "../src/torrent-piece-proof.js";

const fixtureName = process.argv[2];
const pieceIndex = Number.parseInt(process.argv[3] ?? "0", 10);

if (!fixtureName) {
  console.error("Usage: node manual-test/prove-piece.js <fixture-a|fixture-b> [pieceIndex]");
  process.exit(1);
}

if (!Number.isInteger(pieceIndex) || pieceIndex < 0) {
  console.error("pieceIndex must be a non-negative integer");
  process.exit(1);
}

const root = path.resolve("manual-test");
const torrentBuffer = await readFile(path.join(root, "torrents", `${fixtureName}.torrent`));
const contentBuffer = await readFile(path.join(root, "content", `${fixtureName}.bin`));

const metadata = parseTorrentMetadata(torrentBuffer);
const proof = generatePieceProof({
  torrentBuffer,
  contentBuffer,
  pieceIndex,
  revealRound: 70,
});
const verification = verifyPieceProofFromRound({
  pieceHashHex: proof.pieceHashHex,
  revealRound: proof.revealRound,
  preBlockState: proof.preBlockState,
  roundRevealState: proof.roundRevealState,
  remainingScheduleWords: proof.remainingScheduleWords,
});

console.log(
  JSON.stringify(
    {
      fixtureName,
      pieceIndex,
      infoHash: metadata.infoHash,
      pieceHashHex: proof.pieceHashHex,
      roundRevealState: proof.roundRevealState,
      remainingScheduleWords: proof.remainingScheduleWords,
      verification,
    },
    null,
    2,
  ),
);
