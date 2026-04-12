function getNostrProvider() {
  if (typeof window === "undefined" || typeof window.nostr === "undefined") {
    throw new Error("Nostr wallet not found. Install Alby or another NIP-07 provider and reload.");
  }

  return window.nostr;
}

export async function getNostrPublicKey() {
  const provider = getNostrProvider();

  if (typeof provider.getPublicKey !== "function") {
    throw new Error("Your Nostr wallet does not expose getPublicKey.");
  }

  const pubkey = await provider.getPublicKey();

  if (typeof pubkey !== "string" || !pubkey.trim()) {
    throw new Error("Nostr wallet did not return a valid public key.");
  }

  return pubkey.trim().toLowerCase();
}

export async function signNostrEvent(eventTemplate) {
  const provider = getNostrProvider();

  if (typeof provider.signEvent !== "function") {
    throw new Error("Your Nostr wallet does not support event signing.");
  }

  if (!eventTemplate || typeof eventTemplate !== "object") {
    throw new Error("eventTemplate is required");
  }

  const signedEvent = await provider.signEvent(eventTemplate);

  if (!signedEvent || typeof signedEvent !== "object" || !signedEvent.id || !signedEvent.sig) {
    throw new Error("Nostr wallet did not return a signed event.");
  }

  return signedEvent;
}

export async function createSignedNostrEvent({ kind = 27235, tags = [], content }) {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("content is required");
  }

  const pubkey = await getNostrPublicKey();
  const signedEvent = await signNostrEvent({
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  });

  return {
    pubkey,
    signedEvent,
  };
}
