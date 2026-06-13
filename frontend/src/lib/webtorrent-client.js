import webtorrentBundleUrl from "webtorrent/dist/webtorrent.min.js?url";

const browserClients = new Map();
let webTorrentCtorPromise = null;

async function loadWebTorrentConstructor() {
  if (!webTorrentCtorPromise) {
    webTorrentCtorPromise = import(/* @vite-ignore */ webtorrentBundleUrl).then((module) => {
      const WebTorrent = module?.default ?? module?.WebTorrent ?? module;

      if (typeof WebTorrent !== "function") {
        throw new Error("failed to load the WebTorrent constructor");
      }

      return WebTorrent;
    });
  }

  return webTorrentCtorPromise;
}

export async function getWebTorrentClient(clientKey = "default") {
  if (!browserClients.has(clientKey)) {
    const WebTorrent = await loadWebTorrentConstructor();
    browserClients.set(clientKey, new WebTorrent({
      seedOutgoingConnections: true,
    }));
  }

  return browserClients.get(clientKey);
}

export async function addTorrent(source, options = {}) {
  const { clientKey = "default", ...torrentOptions } = options;
  const client = await getWebTorrentClient(clientKey);

  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      client.removeListener("error", handleError);
      reject(error);
    };

    client.once("error", handleError);
    client.add(source, torrentOptions, (torrent) => {
      client.removeListener("error", handleError);
      resolve(torrent);
    });
  });
}

function normalizeLoadSource(source) {
  if (
    typeof Blob !== "undefined" &&
    source instanceof Blob &&
    typeof source.stream === "function"
  ) {
    return source.stream();
  }

  if (source instanceof ArrayBuffer) {
    const bytes = new Uint8Array(source);

    return (async function* chunks() {
      yield bytes;
    }());
  }

  if (ArrayBuffer.isView(source)) {
    const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

    return (async function* chunks() {
      yield bytes;
    }());
  }

  return source;
}

export async function loadTorrentData(torrent, input) {
  if (!torrent) {
    throw new Error("torrent is required");
  }

  const streams = (Array.isArray(input) ? input : [input]).map((source) => normalizeLoadSource(source));

  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      torrent.removeListener("error", handleError);
      reject(error);
    };

    torrent.once("error", handleError);
    torrent.load(streams, (error) => {
      torrent.removeListener("error", handleError);

      if (error) {
        reject(error);
        return;
      }

      resolve(torrent);
    });
  });
}

export async function seedTorrent(input, options = {}) {
  const { clientKey = "default", ...torrentOptions } = options;
  const client = await getWebTorrentClient(clientKey);

  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      client.removeListener("error", handleError);
      reject(error);
    };

    client.once("error", handleError);
    client.seed(input, torrentOptions, (torrent) => {
      client.removeListener("error", handleError);
      resolve(torrent);
    });
  });
}

export async function removeTorrent(torrentId, options = {}) {
  const { clientKey, ...removeOptions } = options;
  const client = options.clientKey
    ? await getWebTorrentClient(clientKey)
    : torrentId?.client ?? await getWebTorrentClient();

  return new Promise((resolve, reject) => {
    client.remove(torrentId, removeOptions, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function destroyWebTorrentClient(clientKey = null) {
  if (clientKey !== null) {
    const client = browserClients.get(clientKey);

    if (!client) {
      return;
    }

    await new Promise((resolve, reject) => {
      client.destroy((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    browserClients.delete(clientKey);
    return;
  }

  await Promise.all([...browserClients.values()].map((client) => (
    new Promise((resolve, reject) => {
      client.destroy((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    })
  )));

  browserClients.clear();
}

export async function listWebTorrentClientState() {
  return [...browserClients.entries()].map(([key, client]) => ({
    key,
    peerId: client.peerId,
    torrents: client.torrents.map((torrent) => ({
      infoHash: torrent.infoHash,
      done: torrent.done,
      ready: torrent.ready,
      numPeers: torrent.numPeers,
      progress: torrent.progress,
      announce: torrent.announce,
    })),
  }));
}
