import parseTorrent from "parse-torrent";

export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function normalizeParsed(parsed) {
  const pieceHashes = [];
  if (parsed.pieces) {
    for (let i = 0; i < parsed.pieces.length; i++) {
      pieceHashes.push(parsed.pieces[i]);
    }
  }

  const files = (parsed.files ?? []).map((f) => ({
    name: f.name,
    path: f.path,
    length: f.length,
  }));

  const totalSize = parsed.length ?? files.reduce((sum, f) => sum + f.length, 0);

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

export async function parseTorrentFile(fileOrBuffer) {
  const buffer =
    fileOrBuffer instanceof ArrayBuffer
      ? new Uint8Array(fileOrBuffer)
      : fileOrBuffer;

  const parsed = await parseTorrent(buffer);
  const result = normalizeParsed(parsed);
  result.source = "file";
  return result;
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
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
