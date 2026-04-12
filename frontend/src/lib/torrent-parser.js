import bencode from "bencode";
import parseTorrent from "parse-torrent";

function decodeText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value == null) {
    return "";
  }

  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(value);
  }

  return String(value);
}

function splitPieceHashes(piecesBuffer) {
  if (!ArrayBuffer.isView(piecesBuffer)) {
    return [];
  }

  const bytes = new Uint8Array(
    piecesBuffer.buffer,
    piecesBuffer.byteOffset,
    piecesBuffer.byteLength,
  );
  const hashes = [];

  for (let offset = 0; offset < bytes.length; offset += 20) {
    const chunk = bytes.slice(offset, offset + 20);
    hashes.push(Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  }

  return hashes;
}

async function computeSha1Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeParsed(parsed) {
  const pieceHashes = [];
  if (parsed.pieces) {
    for (let i = 0; i < parsed.pieces.length; i += 1) {
      pieceHashes.push(parsed.pieces[i]);
    }
  }

  const files = (parsed.files ?? []).map((file) => ({
    name: file.name,
    path: file.path,
    length: file.length,
  }));

  const totalSize = parsed.length ?? files.reduce((sum, file) => sum + file.length, 0);

  return {
    infoHash: parsed.infoHash,
    name: parsed.name ?? "Unknown torrent",
    pieceLength: parsed.pieceLength ?? null,
    pieceCount: pieceHashes.length,
    pieceHashes,
    totalSize,
    files,
    trackers: (parsed.announce ?? []).flat(),
    comment: parsed.comment ?? null,
    createdBy: parsed.createdBy ?? null,
    source: null,
  };
}

export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export async function parseTorrentFile(fileOrBuffer) {
  const bytes = fileOrBuffer instanceof ArrayBuffer
    ? new Uint8Array(fileOrBuffer)
    : fileOrBuffer;

  if (!ArrayBuffer.isView(bytes)) {
    throw new Error("Not a valid .torrent file");
  }

  const decoded = bencode.decode(bytes);
  const info = decoded?.info;

  if (!info) {
    throw new Error("Torrent file is missing info metadata");
  }

  const name = decodeText(info["name.utf-8"] ?? info.name);

  if (!name) {
    throw new Error("Torrent file is missing a name");
  }

  const pieceLength = Number(info["piece length"]);
  const pieceHashes = splitPieceHashes(info.pieces);
  const announceList = Array.isArray(decoded["announce-list"])
    ? decoded["announce-list"].flat().map((value) => decodeText(value)).filter(Boolean)
    : [];
  const announce = decoded.announce ? [decodeText(decoded.announce)] : [];
  const trackers = [...new Set([...announceList, ...announce])];

  let files;
  let totalSize;

  if (Array.isArray(info.files) && info.files.length > 0) {
    files = info.files.map((file) => {
      const rawSegments = file["path.utf-8"] ?? file.path;
      const pathSegments = [
        name,
        ...((Array.isArray(rawSegments) ? rawSegments : []).map((segment) => decodeText(segment))),
      ];
      const length = Number(file.length);

      return {
        name: pathSegments[pathSegments.length - 1],
        path: pathSegments.join("/"),
        length,
      };
    });
    totalSize = files.reduce((sum, file) => sum + file.length, 0);
  } else {
    totalSize = Number(info.length ?? 0);
    files = [{
      name,
      path: name,
      length: totalSize,
    }];
  }

  return {
    infoHash: await computeSha1Hex(bencode.encode(info)),
    name,
    pieceLength: Number.isFinite(pieceLength) ? pieceLength : null,
    pieceCount: pieceHashes.length,
    pieceHashes,
    totalSize,
    files,
    trackers,
    comment: decoded.comment ? decodeText(decoded.comment) : null,
    createdBy: decoded["created by"] ? decodeText(decoded["created by"]) : null,
    source: "file",
  };
}

export async function parseMagnetUri(magnetUri) {
  const trimmed = magnetUri.trim();
  if (!trimmed.startsWith("magnet:")) {
    throw new Error("Not a valid magnet link (must start with magnet:)");
  }

  const parsed = await parseTorrent(trimmed);

  if (!parsed.infoHash) {
    throw new Error("Could not extract info hash from magnet link");
  }

  const result = normalizeParsed(parsed);
  result.source = "magnet";
  return result;
}

export function isMagnetLink(text) {
  return typeof text === "string" && text.trim().startsWith("magnet:");
}

export function torrentToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
