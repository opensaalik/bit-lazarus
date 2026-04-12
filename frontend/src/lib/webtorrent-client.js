import webtorrentBundleUrl from "webtorrent/dist/webtorrent.min.js?url";

let browserClient = null;
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

export async function getWebTorrentClient() {
  if (!browserClient) {
    const WebTorrent = await loadWebTorrentConstructor();
    browserClient = new WebTorrent();
  }

  return browserClient;
}

export async function addTorrent(source, options = {}) {
  const client = await getWebTorrentClient();

  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      client.removeListener("error", handleError);
      reject(error);
    };

    client.once("error", handleError);
    client.add(source, options, (torrent) => {
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
  const client = await getWebTorrentClient();

  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      client.removeListener("error", handleError);
      reject(error);
    };

    client.once("error", handleError);
    client.seed(input, options, (torrent) => {
      client.removeListener("error", handleError);
      resolve(torrent);
    });
  });
}

export async function removeTorrent(torrentId, options = {}) {
  const client = await getWebTorrentClient();

  return new Promise((resolve, reject) => {
    client.remove(torrentId, options, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function destroyWebTorrentClient() {
  if (!browserClient) {
    return;
  }

  await new Promise((resolve, reject) => {
    browserClient.destroy((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  browserClient = null;
}
