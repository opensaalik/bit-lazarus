import crypto from "node:crypto";
import bencode from "bencode";

const textDecoder = new TextDecoder();

const SHA1_INITIAL_STATE = [
  0x67452301,
  0xefcdab89,
  0x98badcfe,
  0x10325476,
  0xc3d2e1f0,
];

const SHA1_ROUND_CONSTANTS = [
  0x5a827999,
  0x6ed9eba1,
  0x8f1bbcdc,
  0xca62c1d6,
];

function leftRotate(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function toUint32Hex(value) {
  return value.toString(16).padStart(8, "0");
}

function encodeState(state) {
  return {
    a: toUint32Hex(state[0]),
    b: toUint32Hex(state[1]),
    c: toUint32Hex(state[2]),
    d: toUint32Hex(state[3]),
    e: toUint32Hex(state[4]),
  };
}

function decodeState(state) {
  return [
    Number.parseInt(state.a, 16) >>> 0,
    Number.parseInt(state.b, 16) >>> 0,
    Number.parseInt(state.c, 16) >>> 0,
    Number.parseInt(state.d, 16) >>> 0,
    Number.parseInt(state.e, 16) >>> 0,
  ];
}

function sha1Function(round, b, c, d) {
  if (round < 20) {
    return ((b & c) | (~b & d)) >>> 0;
  }

  if (round < 40) {
    return (b ^ c ^ d) >>> 0;
  }

  if (round < 60) {
    return ((b & c) | (b & d) | (c & d)) >>> 0;
  }

  return (b ^ c ^ d) >>> 0;
}

function sha1RoundConstant(round) {
  if (round < 20) {
    return SHA1_ROUND_CONSTANTS[0];
  }

  if (round < 40) {
    return SHA1_ROUND_CONSTANTS[1];
  }

  if (round < 60) {
    return SHA1_ROUND_CONSTANTS[2];
  }

  return SHA1_ROUND_CONSTANTS[3];
}

function buildMessageBlocks(messageBuffer) {
  const bitLength = BigInt(messageBuffer.length) * 8n;
  const totalLengthWithoutSize = messageBuffer.length + 1;
  const zeroPaddingLength = (64 - ((totalLengthWithoutSize + 8) % 64)) % 64;
  const padded = Buffer.alloc(messageBuffer.length + 1 + zeroPaddingLength + 8);

  messageBuffer.copy(padded, 0);
  padded[messageBuffer.length] = 0x80;
  padded.writeBigUInt64BE(bitLength, padded.length - 8);

  const blocks = [];

  for (let offset = 0; offset < padded.length; offset += 64) {
    blocks.push(padded.subarray(offset, offset + 64));
  }

  return blocks;
}

function buildMessageSchedule(blockBuffer) {
  const schedule = new Array(80).fill(0);

  for (let index = 0; index < 16; index += 1) {
    schedule[index] = blockBuffer.readUInt32BE(index * 4) >>> 0;
  }

  for (let index = 16; index < 80; index += 1) {
    schedule[index] = leftRotate(
      schedule[index - 3] ^ schedule[index - 8] ^ schedule[index - 14] ^ schedule[index - 16],
      1,
    );
  }

  return schedule;
}

function processBlock(initialState, schedule) {
  let [a, b, c, d, e] = initialState;
  const roundStates = [];

  for (let round = 0; round < 80; round += 1) {
    const temp =
      (leftRotate(a, 5) + sha1Function(round, b, c, d) + e + schedule[round] + sha1RoundConstant(round)) >>> 0;

    e = d;
    d = c;
    c = leftRotate(b, 30);
    b = a;
    a = temp;

    roundStates.push(encodeState([a, b, c, d, e]));
  }

  const nextState = [
    (initialState[0] + a) >>> 0,
    (initialState[1] + b) >>> 0,
    (initialState[2] + c) >>> 0,
    (initialState[3] + d) >>> 0,
    (initialState[4] + e) >>> 0,
  ];

  return {
    roundStates,
    nextState,
  };
}

function computeSha1PieceDigest(pieceBuffer) {
  return crypto.createHash("sha1").update(pieceBuffer).digest("hex");
}

function normalizeTorrentName(rawName) {
  if (typeof rawName === "string") {
    return rawName;
  }

  if (rawName instanceof Uint8Array) {
    return textDecoder.decode(rawName);
  }

  if (Buffer.isBuffer(rawName)) {
    return rawName.toString("utf8");
  }

  return String(rawName);
}

export function parseTorrentMetadata(torrentBuffer) {
  const decoded = bencode.decode(torrentBuffer);
  const info = decoded.info;
  const infoHash = crypto.createHash("sha1").update(bencode.encode(info)).digest("hex");
  const pieceLength = Number(info["piece length"]);
  const totalLength = Number(info.length);
  const pieces = [];
  const rawPieces = info.pieces;

  for (let offset = 0; offset < rawPieces.length; offset += 20) {
    pieces.push(Buffer.from(rawPieces.subarray(offset, offset + 20)).toString("hex"));
  }

  return {
    infoHash,
    name: normalizeTorrentName(info.name),
    pieceLength,
    totalLength,
    pieceCount: pieces.length,
    pieces,
  };
}

export function getPieceData(contentBuffer, torrentMetadata, pieceIndex) {
  if (!Number.isInteger(pieceIndex) || pieceIndex < 0 || pieceIndex >= torrentMetadata.pieceCount) {
    throw new Error("pieceIndex is out of bounds");
  }

  const start = pieceIndex * torrentMetadata.pieceLength;
  const end = Math.min(start + torrentMetadata.pieceLength, contentBuffer.length);
  return contentBuffer.subarray(start, end);
}

export function generatePieceProof({
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

  if (!Number.isInteger(revealRound) || revealRound < 0 || revealRound >= 80) {
    throw new Error("revealRound must be an integer between 0 and 79");
  }

  const torrentMetadata = parseTorrentMetadata(torrentBuffer);
  const pieceBuffer = getPieceData(contentBuffer, torrentMetadata, pieceIndex);
  const pieceHashHex = torrentMetadata.pieces[pieceIndex];
  const computedPieceHashHex = computeSha1PieceDigest(pieceBuffer);

  if (pieceHashHex !== computedPieceHashHex) {
    throw new Error("contentBuffer piece hash does not match torrent metadata");
  }

  const blocks = buildMessageBlocks(pieceBuffer);
  let currentState = [...SHA1_INITIAL_STATE];
  let finalBlockTrace = null;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const schedule = buildMessageSchedule(blocks[blockIndex]);
    const trace = processBlock(currentState, schedule);

    if (blockIndex === blocks.length - 1) {
      finalBlockTrace = {
        blockIndex,
        preBlockState: encodeState(currentState),
        schedule,
        roundStates: trace.roundStates,
        finalDigestHex: trace.nextState.map(toUint32Hex).join(""),
      };
    }

    currentState = trace.nextState;
  }

  return {
    pieceIndex,
    pieceLength: pieceBuffer.length,
    pieceHashHex,
    revealRound,
    finalBlockIndex: finalBlockTrace.blockIndex,
    preBlockState: finalBlockTrace.preBlockState,
    roundStates: finalBlockTrace.roundStates,
    roundRevealState: finalBlockTrace.roundStates[revealRound],
    remainingScheduleWords: finalBlockTrace.schedule.slice(revealRound + 1, 80).map(toUint32Hex),
    finalDigestHex: finalBlockTrace.finalDigestHex,
  };
}

export function verifyPieceProofFromRound({
  pieceHashHex,
  revealRound = 70,
  preBlockState,
  roundRevealState,
  remainingScheduleWords,
} = {}) {
  if (typeof pieceHashHex !== "string" || !/^[0-9a-f]{40}$/.test(pieceHashHex)) {
    throw new Error("pieceHashHex must be a 40-character hex string");
  }

  if (!Number.isInteger(revealRound) || revealRound < 0 || revealRound >= 80) {
    throw new Error("revealRound must be an integer between 0 and 79");
  }

  if (!preBlockState || !roundRevealState) {
    throw new Error("preBlockState and roundRevealState are required");
  }

  if (!Array.isArray(remainingScheduleWords) || remainingScheduleWords.length !== 79 - revealRound) {
    throw new Error("remainingScheduleWords must contain the schedule words from revealRound + 1 to 79");
  }

  let [a, b, c, d, e] = decodeState(roundRevealState);
  const preState = decodeState(preBlockState);

  for (let round = revealRound + 1; round < 80; round += 1) {
    const scheduleWord = Number.parseInt(remainingScheduleWords[round - (revealRound + 1)], 16) >>> 0;
    const temp =
      (leftRotate(a, 5) + sha1Function(round, b, c, d) + e + scheduleWord + sha1RoundConstant(round)) >>> 0;

    e = d;
    d = c;
    c = leftRotate(b, 30);
    b = a;
    a = temp;
  }

  const digestWords = [
    (preState[0] + a) >>> 0,
    (preState[1] + b) >>> 0,
    (preState[2] + c) >>> 0,
    (preState[3] + d) >>> 0,
    (preState[4] + e) >>> 0,
  ];
  const digestHex = digestWords.map(toUint32Hex).join("");

  return {
    valid: digestHex === pieceHashHex,
    digestHex,
  };
}
