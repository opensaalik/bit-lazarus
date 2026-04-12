import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseTorrentFile } from "../frontend/src/lib/torrent-parser.js";

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
