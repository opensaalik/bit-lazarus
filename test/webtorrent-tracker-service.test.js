import test from "node:test";
import assert from "node:assert/strict";
import { createWebTorrentTrackerServiceFromEnv, WebTorrentTrackerService } from "../src/webtorrent-tracker-service.js";

const defaultRtcConfig = {
  iceServers: [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:global.stun.twilio.com:3478",
      ],
    },
  ],
};

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
    rtcConfig: defaultRtcConfig,
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
    rtcConfig: defaultRtcConfig,
  });
});

test("WebTorrent tracker advertises configured ICE servers", () => {
  const service = createWebTorrentTrackerServiceFromEnv({
    HOST: "0.0.0.0",
    PORT: "10000",
    RENDER_EXTERNAL_HOSTNAME: "bit-lazarus.onrender.com",
    WEBTORRENT_ICE_SERVERS: "stun:stun.example:3478,turn:turn.example:3478",
  });

  assert.deepEqual(service.getPublicConfig().rtcConfig, {
    iceServers: [
      { urls: "stun:stun.example:3478" },
      { urls: "turn:turn.example:3478" },
    ],
  });
});

test("WebTorrent tracker reports empty swarm stats", () => {
  const service = createWebTorrentTrackerServiceFromEnv({
    HOST: "127.0.0.1",
    PORT: "3000",
  });

  assert.deepEqual(service.getSwarmStats("0123456789abcdef0123456789abcdef01234567"), {
    infoHash: "0123456789abcdef0123456789abcdef01234567",
    complete: 0,
    incomplete: 0,
    peers: [],
    peerCount: 0,
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
