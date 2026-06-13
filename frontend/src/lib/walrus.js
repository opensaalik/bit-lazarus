export async function uploadWalrusBlob({ token, blob }) {
  if (!token) {
    throw new Error("Authentication is required to upload to Walrus.");
  }

  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error("A non-empty blob is required for Walrus upload.");
  }

  const response = await fetch("/walrus/blobs", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
    },
    body: blob,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `Walrus upload failed with status ${response.status}`);
  }

  return payload;
}

function getFilenameFromDisposition(contentDisposition) {
  const match = /filename="([^"]+)"/i.exec(contentDisposition ?? "");
  return match?.[1] ?? null;
}

export async function downloadArchiveResource({ token, torrentInfoHash, filename }) {
  if (!token) {
    throw new Error("Authentication is required to download archives.");
  }

  if (!torrentInfoHash) {
    throw new Error("torrentInfoHash is required.");
  }

  const response = await fetch(`/resources/${torrentInfoHash}/download`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `Archive download failed with status ${response.status}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.rel = "noopener";
  anchor.download = filename || getFilenameFromDisposition(response.headers.get("content-disposition")) || "bit-lazarus-archive.bin";

  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}
