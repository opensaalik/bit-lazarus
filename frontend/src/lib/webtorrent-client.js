import WebTorrent from "webtorrent";

let browserClient = null;

export function getWebTorrentClient() {
  if (!browserClient) {
    browserClient = new WebTorrent();
  }

  return browserClient;
}

export function addTorrent(source, options = {}) {
  const client = getWebTorrentClient();

  return new Promise((resolve, reject) => {
    client.add(source, options, (torrent) => {
      resolve(torrent);
    });

    client.once("error", reject);
  });
}

export function destroyWebTorrentClient() {
  if (!browserClient) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    browserClient.destroy((error) => {
      if (error) {
        reject(error);
        return;
      }

      browserClient = null;
      resolve();
    });
  });
}
