import { Server as TrackerServer } from "bittorrent-tracker";

function normalizePublicHost(host) {
  if (!host || host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }

  return host;
}

function normalizePath(path) {
  if (!path) {
    return "/tracker";
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function normalizePublicPort(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("WEBTORRENT_TRACKER_PUBLIC_PORT must be a positive integer");
  }

  return parsed;
}

export class WebTorrentTrackerService {
  constructor({
    listenHost = "127.0.0.1",
    listenPort = 3000,
    publicHost = listenHost,
    publicPort = listenPort,
    publicScheme = "ws",
    announcePath = "/tracker",
    intervalMs = 30_000,
  } = {}) {
    this.listenHost = listenHost;
    this.listenPort = listenPort;
    this.publicHost = normalizePublicHost(publicHost);
    this.publicPort = normalizePublicPort(publicPort);
    this.publicScheme = publicScheme;
    this.announcePath = normalizePath(announcePath);
    this.intervalMs = intervalMs;
    this.server = null;
    this.httpServer = null;
    this.handleUpgrade = null;
  }

  getAnnounceUrl() {
    const standardPort =
      (this.publicScheme === "wss" && this.publicPort === 443) ||
      (this.publicScheme === "ws" && this.publicPort === 80);
    const port = this.publicPort && !standardPort ? `:${this.publicPort}` : "";

    return `${this.publicScheme}://${this.publicHost}${port}${this.announcePath}`;
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
      ws: true,
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

  attach(httpServer) {
    if (this.server) {
      return this;
    }

    const trackerServer = new TrackerServer({
      http: false,
      udp: false,
      ws: { noServer: true },
      stats: false,
      interval: this.intervalMs,
    });
    const handleUpgrade = (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");

      if (requestUrl.pathname !== this.announcePath) {
        return;
      }

      trackerServer.ws.handleUpgrade(request, socket, head, (websocket) => {
        trackerServer.ws.emit("connection", websocket, request);
      });
    };

    httpServer.on("upgrade", handleUpgrade);
    this.server = trackerServer;
    this.httpServer = httpServer;
    this.handleUpgrade = handleUpgrade;
    return this;
  }

  async stop() {
    if (!this.server) {
      return;
    }

    const trackerServer = this.server;
    this.server = null;
    if (this.httpServer && this.handleUpgrade) {
      this.httpServer.off("upgrade", this.handleUpgrade);
    }
    this.httpServer = null;
    this.handleUpgrade = null;

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

export function createWebTorrentTrackerServiceFromEnv(environment = process.env, options = {}) {
  if (environment.WEBTORRENT_TRACKER_ENABLED === "0") {
    return null;
  }

  const listenHost = environment.WEBTORRENT_TRACKER_HOST || options.host || environment.HOST || "127.0.0.1";
  const listenPort = Number.parseInt(environment.WEBTORRENT_TRACKER_PORT ?? options.port ?? "3000", 10);
  const publicHost = environment.WEBTORRENT_TRACKER_PUBLIC_HOST || environment.RENDER_EXTERNAL_HOSTNAME || listenHost;
  const publicScheme = environment.WEBTORRENT_TRACKER_SCHEME || (environment.RENDER_EXTERNAL_HOSTNAME ? "wss" : "ws");
  const publicPort = normalizePublicPort(
    environment.WEBTORRENT_TRACKER_PUBLIC_PORT ?? (environment.RENDER_EXTERNAL_HOSTNAME ? null : listenPort),
  );
  const announcePath = environment.WEBTORRENT_TRACKER_PATH || "/tracker";
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
