import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import bencode from "bencode";
import { parseTorrentFile, rewriteTorrentAnnounceUrls } from "../frontend/src/lib/torrent-parser.js";

test("frontend torrent parser reads .torrent files without parse-torrent path helpers", async () => {
  const fixturePath = path.resolve("manual-test", "torrents", "fixture-a.torrent");
  const bytes = new Uint8Array(await readFile(fixturePath));
  const parsed = await parseTorrentFile(bytes);

  assert.equal(parsed.source, "file");
  assert.equal(parsed.infoHash, "0dc90a238dda838b2ebfb7018e980276df1da0be");
  assert.equal(parsed.name, "fixture-a.bin");
  assert.equal(parsed.pieceLength, 16384);
  assert.equal(parsed.pieceCount, 2);
  assert.equal(parsed.totalSize, 22528);
  assert.deepEqual(parsed.files, [
    {
      name: "fixture-a.bin",
      path: "fixture-a.bin",
      length: 22528,
    },
  ]);
});

test("frontend torrent parser rewrites announce URLs without changing the infohash", async () => {
  const fixturePath = path.resolve("manual-test", "torrents", "fixture-a.torrent");
  const bytes = new Uint8Array(await readFile(fixturePath));
  const decoded = bencode.decode(bytes);
  decoded.announce = "wss://tracker.webtorrent.dev";
  decoded["announce-list"] = [["wss://tracker.webtorrent.dev"], ["wss://tracker.openwebtorrent.com"]];
  const externalTrackerBytes = bencode.encode(decoded);

  const originalParsed = await parseTorrentFile(externalTrackerBytes);
  const rewrittenBytes = rewriteTorrentAnnounceUrls(externalTrackerBytes, ["wss://bit-lazarus.onrender.com/tracker"]);
  const rewrittenParsed = await parseTorrentFile(rewrittenBytes);

  assert.equal(originalParsed.infoHash, "0dc90a238dda838b2ebfb7018e980276df1da0be");
  assert.equal(rewrittenParsed.infoHash, originalParsed.infoHash);
  assert.deepEqual(rewrittenParsed.trackers, ["wss://bit-lazarus.onrender.com/tracker"]);
});
