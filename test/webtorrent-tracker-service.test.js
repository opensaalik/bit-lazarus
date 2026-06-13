import test from "node:test";
import assert from "node:assert/strict";
import { createWebTorrentTrackerServiceFromEnv, WebTorrentTrackerService } from "../src/webtorrent-tracker-service.js";

test("WebTorrent tracker advertises a same-origin local app port by default", () => {
  const service = createWebTorrentTrackerServiceFromEnv({
    HOST: "127.0.0.1",
    PORT: "3000",
  }, {
    host: "127.0.0.1",
    port: 3000,
  });

  assert.deepEqual(service.getPublicConfig(), {
    enabled: true,
    announceUrls: ["ws://127.0.0.1:3000/tracker"],
  });
});

test("WebTorrent tracker advertises Render HTTPS websocket endpoint", () => {
  const service = createWebTorrentTrackerServiceFromEnv({
    HOST: "0.0.0.0",
    PORT: "10000",
    RENDER_EXTERNAL_HOSTNAME: "bit-lazarus.onrender.com",
  });

  assert.deepEqual(service.getPublicConfig(), {
    enabled: true,
    announceUrls: ["wss://bit-lazarus.onrender.com/tracker"],
  });
});

test("WebTorrent tracker supports custom public route and port", () => {
  const service = new WebTorrentTrackerService({
    publicHost: "tracker.example",
    publicScheme: "wss",
    publicPort: 8443,
    announcePath: "announce",
  });

  assert.equal(service.getAnnounceUrl(), "wss://tracker.example:8443/announce");
});

test("WebTorrent tracker can be disabled by environment", () => {
  assert.equal(createWebTorrentTrackerServiceFromEnv({ WEBTORRENT_TRACKER_ENABLED: "0" }), null);
});
