import express from "express";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createResourceLocatorServiceFromEnv } from "./resource-locator-service.js";

export function getCcipGatewayHealth({ resourceLocatorService }) {
  return {
    ok: true,
    service: "bit-lazarus-ccip-gateway",
    parentName: resourceLocatorService.parentName,
    ensNetwork: resourceLocatorService.ensNetwork,
  };
}

export function answerCcipGatewayRequest({ resourceLocatorService, sender, data }) {
  return resourceLocatorService.answerCcipRead({ sender, data });
}

export function createCcipGatewayApp({ resourceLocatorService }) {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json(getCcipGatewayHealth({ resourceLocatorService }));
  });

  app.get("/ens/ccip/:sender/:data", (request, response) => {
    response.json(answerCcipGatewayRequest({
      resourceLocatorService,
      sender: request.params.sender,
      data: request.params.data,
    }));
  });

  app.post("/ens/ccip", (request, response) => {
    response.json(answerCcipGatewayRequest({
      resourceLocatorService,
      sender: request.body?.sender,
      data: request.body?.data,
    }));
  });

  app.use((request, response) => {
    response.status(404).json({ error: "not found" });
  });

  app.use((error, _request, response, _next) => {
    response.status(400).json({ error: error.message });
  });

  return app;
}

export async function startCcipGatewayServer({
  port = Number.parseInt(process.env.PORT ?? "3000", 10),
  host = process.env.HOST ?? "0.0.0.0",
  dataDir = process.env.DATA_DIR ?? path.resolve("data"),
} = {}) {
  const resourceLocatorService = createResourceLocatorServiceFromEnv(process.env, {
    dataDir: path.join(dataDir, "resources"),
  });
  await resourceLocatorService.init();

  const app = createCcipGatewayApp({ resourceLocatorService });
  const server = await new Promise((resolve) => {
    const instance = app.listen(port, host, () => resolve(instance));
  });

  return {
    app,
    server,
    resourceLocatorService,
    port,
    host,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { port, host } = await startCcipGatewayServer();
  console.log(`Bit Lazarus CCIP gateway listening on http://${host}:${port}`);
}
