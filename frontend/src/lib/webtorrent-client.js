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
