import test from "node:test";
import assert from "node:assert/strict";
import { createWalrusServiceFromEnv, WalrusService } from "../src/walrus-service.js";

function createPublisherFetch(responseBody, options = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({
      url: String(url),
      method: init.method,
      contentType: init.headers?.["content-type"],
      body: init.body,
    });

    return new Response(JSON.stringify(responseBody), {
      status: options.status ?? 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  return { fetchImpl, requests };
}

test("Walrus service stores bytes through the publisher HTTP API", async () => {
  const publisher = createPublisherFetch({
    newlyCreated: {
      blobObject: {
        id: "0xwalrusObject",
        blobId: "walrus_blob_123",
      },
    },
  });
  const service = new WalrusService({
    publisherUrl: "https://publisher.example",
    aggregatorUrl: "https://aggregator.example",
    defaultEpochs: 7,
    fetchImpl: publisher.fetchImpl,
  });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const result = await service.storeBlob({ bytes });

  assert.equal(publisher.requests.length, 1);
  assert.equal(publisher.requests[0].method, "PUT");
  assert.equal(publisher.requests[0].url, "https://publisher.example/v1/blobs?epochs=7&permanent=true");
  assert.equal(publisher.requests[0].contentType, "application/octet-stream");
  assert.deepEqual(publisher.requests[0].body, bytes);
  assert.equal(result.blobId, "walrus_blob_123");
  assert.equal(result.objectId, "0xwalrusObject");
  assert.equal(result.retrievalUrl, "https://aggregator.example/v1/blobs/walrus_blob_123");
});

test("Walrus service accepts already-certified publisher responses", async () => {
  const publisher = createPublisherFetch({
    alreadyCertified: {
      blobId: "walrus_blob_existing",
    },
  });
  const service = new WalrusService({
    publisherUrl: "https://publisher.example",
    aggregatorUrl: "https://aggregator.example/",
    fetchImpl: publisher.fetchImpl,
  });
  const result = await service.storeBlob({
    bytes: new Uint8Array([9]),
  });

  assert.equal(result.blobId, "walrus_blob_existing");
  assert.equal(result.objectId, null);
  assert.equal(result.retrievalUrl, "https://aggregator.example/v1/blobs/walrus_blob_existing");
});

test("Walrus service fetches archived blobs through the aggregator API", async () => {
  const requests = [];
  const service = new WalrusService({
    publisherUrl: "https://publisher.example",
    aggregatorUrl: "https://aggregator.example",
    fetchImpl: async (url, init = {}) => {
      requests.push({
        url: String(url),
        method: init.method,
      });

      return new Response("archived bytes", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
        },
      });
    },
  });
  const response = await service.fetchBlob("walrus_blob_existing");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url, "https://aggregator.example/v1/blobs/walrus_blob_existing");
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(await response.text(), "archived bytes");
});

test("Walrus service factory uses production defaults and configured overrides", () => {
  const service = createWalrusServiceFromEnv({
    WALRUS_PUBLISHER_URL: "https://publisher.example/",
    WALRUS_AGGREGATOR_URL: "https://aggregator.example/",
    WALRUS_EPOCHS: "11",
  });

  assert.deepEqual(service.getPublicConfig(), {
    publisherUrl: "https://publisher.example",
    aggregatorUrl: "https://aggregator.example",
    defaultEpochs: 11,
  });
});

test("Walrus service rejects empty uploads and invalid epochs", async () => {
  assert.throws(() => new WalrusService({ defaultEpochs: 0 }), /WALRUS_EPOCHS/);

  const service = new WalrusService({
    publisherUrl: "https://publisher.example",
    aggregatorUrl: "https://aggregator.example",
  });

  await assert.rejects(
    () => service.storeBlob({ bytes: new Uint8Array() }),
    /bytes must be non-empty bytes/,
  );
});
