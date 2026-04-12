function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computeSha256Hex(input) {
  if (!(input instanceof ArrayBuffer) && !(input instanceof Uint8Array)) {
    throw new Error("computeSha256Hex requires an ArrayBuffer or Uint8Array");
  }

  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}
