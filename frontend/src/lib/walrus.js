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
