export const DEFAULT_WALRUS_PUBLISHER_URL = "https://publisher.walrus-testnet.walrus.space";
export const DEFAULT_WALRUS_AGGREGATOR_URL = "https://aggregator.walrus-testnet.walrus.space";

function assertBytes(value, fieldName) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`${fieldName} must be non-empty bytes`);
  }
}

function normalizeBaseUrl(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim().replace(/\/$/, "");
}

function getBlobIdFromStoreResponse(responseBody) {
  return responseBody?.newlyCreated?.blobObject?.blobId ?? responseBody?.alreadyCertified?.blobId ?? null;
}

function getObjectIdFromStoreResponse(responseBody) {
  return responseBody?.newlyCreated?.blobObject?.id ?? null;
}

function parseEpochs(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("WALRUS_EPOCHS must be a positive integer");
  }

  return parsed;
}

export function createWalrusServiceFromEnv(environment = process.env, options = {}) {
  return new WalrusService({
    publisherUrl: environment.WALRUS_PUBLISHER_URL ?? options.publisherUrl ?? DEFAULT_WALRUS_PUBLISHER_URL,
    aggregatorUrl: environment.WALRUS_AGGREGATOR_URL ?? options.aggregatorUrl ?? DEFAULT_WALRUS_AGGREGATOR_URL,
    defaultEpochs: parseEpochs(environment.WALRUS_EPOCHS ?? options.defaultEpochs ?? "5"),
    fetchImpl: options.fetchImpl,
  });
}

export class WalrusService {
  constructor({
    publisherUrl = DEFAULT_WALRUS_PUBLISHER_URL,
    aggregatorUrl = DEFAULT_WALRUS_AGGREGATOR_URL,
    defaultEpochs = 5,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.publisherUrl = normalizeBaseUrl(publisherUrl, "WALRUS_PUBLISHER_URL");
    this.aggregatorUrl = normalizeBaseUrl(aggregatorUrl, "WALRUS_AGGREGATOR_URL");
    this.defaultEpochs = parseEpochs(defaultEpochs);
    this.fetchImpl = fetchImpl;
  }

  getPublicConfig() {
    return {
      publisherUrl: this.publisherUrl,
      aggregatorUrl: this.aggregatorUrl,
      defaultEpochs: this.defaultEpochs,
    };
  }

  getRetrievalUrl(blobId) {
    if (!blobId || typeof blobId !== "string") {
      throw new Error("blobId is required");
    }

    return `${this.aggregatorUrl}/v1/blobs/${encodeURIComponent(blobId)}`;
  }

  async storeBlob({ bytes, epochs = this.defaultEpochs, permanent = true }) {
    assertBytes(bytes, "bytes");
    const url = new URL(`${this.publisherUrl}/v1/blobs`);

    if (epochs) {
      url.searchParams.set("epochs", String(epochs));
    }

    if (permanent) {
      url.searchParams.set("permanent", "true");
    }

    const response = await this.fetchImpl(url, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: bytes,
    });
    const responseText = await response.text();
    let responseBody = {};

    try {
      responseBody = responseText ? JSON.parse(responseText) : {};
    } catch (_error) {
      throw new Error(`Walrus upload returned invalid JSON: ${responseText}`);
    }

    if (!response.ok) {
      throw new Error(`Walrus upload failed with status ${response.status}: ${responseText}`);
    }

    const blobId = getBlobIdFromStoreResponse(responseBody);

    if (!blobId) {
      throw new Error("Walrus upload response did not include a blob ID");
    }

    return {
      blobId,
      objectId: getObjectIdFromStoreResponse(responseBody),
      retrievalUrl: this.getRetrievalUrl(blobId),
      response: responseBody,
    };
  }

  async fetchBlob(blobId) {
    const response = await this.fetchImpl(this.getRetrievalUrl(blobId), {
      method: "GET",
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`Walrus download failed with status ${response.status}: ${responseText}`);
    }

    return response;
  }
}
