import webtorrentScriptUrl from "webtorrent/dist/webtorrent.min.js?url";

let browserClient = null;
let webTorrentCtorPromise = null;

async function loadWebTorrentConstructor() {
  if (globalThis.WebTorrent) {
    return globalThis.WebTorrent;
  }

  if (!webTorrentCtorPromise) {
    webTorrentCtorPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector(`script[data-webtorrent-bundle="${webtorrentScriptUrl}"]`);

      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(globalThis.WebTorrent), { once: true });
        existingScript.addEventListener("error", () => reject(new Error("failed to load WebTorrent browser bundle")), {
          once: true,
        });
        return;
      }

      const script = document.createElement("script");
      script.src = webtorrentScriptUrl;
      script.async = true;
      script.dataset.webtorrentBundle = webtorrentScriptUrl;
      script.onload = () => {
        if (!globalThis.WebTorrent) {
          reject(new Error("WebTorrent browser bundle loaded without exposing WebTorrent"));
          return;
        }

        resolve(globalThis.WebTorrent);
      };
      script.onerror = () => reject(new Error("failed to load WebTorrent browser bundle"));
      document.head.appendChild(script);
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
