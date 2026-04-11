import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  generatePieceProof,
  getPieceData,
  parseTorrentMetadata,
  verifyPieceProofFromRound,
} from "../src/torrent-piece-proof.js";

const fixtureRoot = path.resolve("manual-test");

async function loadFixture(name) {
  const torrentBuffer = await readFile(path.join(fixtureRoot, "torrents", `${name}.torrent`));
  const contentBuffer = await readFile(path.join(fixtureRoot, "content", `${name}.bin`));

  return {
    torrentBuffer,
    contentBuffer,
  };
}

test("parseTorrentMetadata reads real fixture info hashes", async () => {
  const { torrentBuffer } = await loadFixture("fixture-a");
  const metadata = parseTorrentMetadata(torrentBuffer);

  assert.equal(metadata.infoHash, "0dc90a238dda838b2ebfb7018e980276df1da0be");
  assert.equal(metadata.name, "fixture-a.bin");
  assert.equal(metadata.pieceLength, 16384);
  assert.equal(metadata.pieceCount, 2);
});

test("generatePieceProof produces verifiable proof for a real torrent piece", async () => {
  const { torrentBuffer, contentBuffer } = await loadFixture("fixture-a");
  const metadata = parseTorrentMetadata(torrentBuffer);
  const pieceBuffer = getPieceData(contentBuffer, metadata, 0);
  const proof = await generatePieceProof({
    torrentBuffer,
    contentBuffer,
    pieceIndex: 0,
    revealRound: 70,
  });
  const verification = verifyPieceProofFromRound({
    pieceHashHex: proof.pieceHashHex,
    revealRound: proof.revealRound,
    preBlockState: proof.preBlockState,
    roundRevealState: proof.roundRevealState,
    remainingScheduleWords: proof.remainingScheduleWords,
  });

  assert.equal(pieceBuffer.length, metadata.pieceLength);
  assert.equal(proof.pieceIndex, 0);
  assert.equal(proof.revealRound, 70);
  assert.equal(proof.remainingScheduleWords.length, 9);
  assert.equal(verification.valid, true);
  assert.equal(verification.computedPieceHashHex, proof.pieceHashHex);
});

test("generatePieceProof works for the last shorter piece", async () => {
  const { torrentBuffer, contentBuffer } = await loadFixture("fixture-b");
  const proof = await generatePieceProof({
    torrentBuffer,
    contentBuffer,
    pieceIndex: 2,
    revealRound: 70,
  });
  const verification = verifyPieceProofFromRound({
    pieceHashHex: proof.pieceHashHex,
    revealRound: proof.revealRound,
    preBlockState: proof.preBlockState,
    roundRevealState: proof.roundRevealState,
    remainingScheduleWords: proof.remainingScheduleWords,
  });

  assert.equal(proof.pieceLength, 1024);
  assert.equal(verification.valid, true);
});

test("verifyPieceProofFromRound rejects tampered schedule words", async () => {
  const { torrentBuffer, contentBuffer } = await loadFixture("fixture-a");
  const proof = await generatePieceProof({
    torrentBuffer,
    contentBuffer,
    pieceIndex: 1,
    revealRound: 70,
  });
  const tamperedScheduleWords = [...proof.remainingScheduleWords];
  tamperedScheduleWords[0] = "00000000";

  const verification = verifyPieceProofFromRound({
    pieceHashHex: proof.pieceHashHex,
    revealRound: proof.revealRound,
    preBlockState: proof.preBlockState,
    roundRevealState: proof.roundRevealState,
    remainingScheduleWords: tamperedScheduleWords,
  });

  assert.equal(verification.valid, false);
  assert.notEqual(verification.computedPieceHashHex, proof.pieceHashHex);
});
