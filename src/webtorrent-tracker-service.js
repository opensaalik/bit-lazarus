import { Server as TrackerServer } from "bittorrent-tracker";

function normalizePublicHost(host) {
  if (!host || host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }

  return host;
}

export class WebTorrentTrackerService {
  constructor({
    listenHost = "127.0.0.1",
    listenPort = 8001,
    publicHost = listenHost,
    publicPort = listenPort,
    publicScheme = "ws",
    announcePath = "",
    intervalMs = 30_000,
  } = {}) {
    this.listenHost = listenHost;
    this.listenPort = listenPort;
    this.publicHost = normalizePublicHost(publicHost);
    this.publicPort = publicPort;
    this.publicScheme = publicScheme;
    this.announcePath = announcePath;
    this.intervalMs = intervalMs;
    this.server = null;
  }

  getAnnounceUrl() {
    const normalizedPath = this.announcePath
      ? this.announcePath.startsWith("/")
        ? this.announcePath
        : `/${this.announcePath}`
      : "";

    return `${this.publicScheme}://${this.publicHost}:${this.publicPort}${normalizedPath}`;
  }

  getPublicConfig() {
    return {
      enabled: true,
      announceUrls: [this.getAnnounceUrl()],
    };
  }

  async start() {
    if (this.server) {
      return this;
    }

    const trackerServer = new TrackerServer({
      http: false,
      udp: false,
      ws: this.announcePath ? { path: this.announcePath } : true,
      stats: false,
      interval: this.intervalMs,
    });

    await new Promise((resolve, reject) => {
      const handleListening = () => {
        trackerServer.off("error", handleError);
        resolve();
      };
      const handleError = (error) => {
        trackerServer.off("listening", handleListening);
        reject(error);
      };

      trackerServer.once("listening", handleListening);
      trackerServer.once("error", handleError);
      trackerServer.listen(this.listenPort, this.listenHost);
    });

    this.server = trackerServer;
    return this;
  }

  async stop() {
    if (!this.server) {
      return;
    }

    const trackerServer = this.server;
    this.server = null;

    await new Promise((resolve, reject) => {
      trackerServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

export function createWebTorrentTrackerServiceFromEnv(environment = process.env) {
  if (environment.WEBTORRENT_TRACKER_ENABLED === "0") {
    return null;
  }

  const listenHost = environment.WEBTORRENT_TRACKER_HOST || environment.HOST || "127.0.0.1";
  const listenPort = Number.parseInt(environment.WEBTORRENT_TRACKER_PORT ?? "8001", 10);
  const publicHost = environment.WEBTORRENT_TRACKER_PUBLIC_HOST || listenHost;
  const publicPort = Number.parseInt(environment.WEBTORRENT_TRACKER_PUBLIC_PORT ?? `${listenPort}`, 10);
  const publicScheme = environment.WEBTORRENT_TRACKER_SCHEME || "ws";
  const announcePath = environment.WEBTORRENT_TRACKER_PATH || "";
  const intervalMs = Number.parseInt(environment.WEBTORRENT_TRACKER_INTERVAL_MS ?? "30000", 10);

  return new WebTorrentTrackerService({
    listenHost,
    listenPort,
    publicHost,
    publicPort,
    publicScheme,
    announcePath,
    intervalMs,
  });
}
