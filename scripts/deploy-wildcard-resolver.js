import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  labelhash,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalize } from "viem/ens";
import { sepolia } from "viem/chains";

const execFileAsync = promisify(execFile);
const DEFAULT_PARENT_REGISTRY = "0xdedb92913a25abe1f7bcdd85d8a344a43b398b67";
const ARTIFACT_PATH = path.resolve(
  "out",
  "BitLazarusWildcardResolver.sol",
  "BitLazarusWildcardResolver.json",
);

const parentRegistryAbi = parseAbi([
  "function setResolver(uint256 anyId, address resolver)",
  "function getResolver(string label) view returns (address)",
]);

function parseEnv(raw) {
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [
          line.slice(0, index).trim(),
          line.slice(index + 1).trim().replace(/^['"]|['"]$/g, ""),
        ];
      }),
  );
}

async function readEnv() {
  try {
    return parseEnv(await readFile(".env", "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function required(environment, key) {
  const value = environment[key]?.trim?.();

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function normalizePrivateKey(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function getEthLabel(parentName) {
  const normalizedName = normalize(parentName);
  const labels = normalizedName.split(".");

  if (labels.length !== 2 || labels[1] !== "eth") {
    throw new Error("ENS_PARENT_NAME must be a second-level .eth name");
  }

  return labels[0];
}

function assertGatewayUrl(gatewayUrl) {
  const url = new URL(gatewayUrl);

  if (url.protocol !== "https:") {
    throw new Error("ENS_CCIP_GATEWAY_URL must be HTTPS for production ENS clients");
  }

  if (!gatewayUrl.includes("{sender}") || !gatewayUrl.includes("{data}")) {
    throw new Error("ENS_CCIP_GATEWAY_URL must include {sender} and {data} placeholders");
  }

  return url.toString();
}

async function buildContract() {
  await execFileAsync("forge", ["build", "--contracts", "contracts"], {
    stdio: "inherit",
  });
}

async function readArtifact() {
  const artifact = JSON.parse(await readFile(ARTIFACT_PATH, "utf8"));
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode?.object ?? artifact.bytecode,
  };
}

async function main() {
  const environment = {
    ...process.env,
    ...(await readEnv()),
  };
  const parentName = required(environment, "ENS_PARENT_NAME");
  const parentLabel = getEthLabel(parentName);
  const rpcUrl = environment.ENS_RPC_URL ?? environment.ETH_RPC_URL;
  const privateKey = environment.ENS_PRIVATE_KEY ?? environment.PRIVATE_KEY;
  const gatewayUrl = assertGatewayUrl(required(environment, "ENS_CCIP_GATEWAY_URL"));
  const parentRegistry = getAddress(environment.ENS_V2_PARENT_REGISTRY_ADDRESS ?? DEFAULT_PARENT_REGISTRY);

  if (!rpcUrl) {
    throw new Error("ENS_RPC_URL or ETH_RPC_URL is required");
  }

  if (!privateKey) {
    throw new Error("ENS_PRIVATE_KEY or PRIVATE_KEY is required");
  }

  await buildContract();
  const { abi, bytecode } = await readArtifact();
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ account, chain: sepolia, transport });

  const deployHash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [[gatewayUrl]],
    account,
    chain: sepolia,
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const resolverAddress = getAddress(deployReceipt.contractAddress);

  const setResolverHash = await walletClient.writeContract({
    address: parentRegistry,
    abi: parentRegistryAbi,
    functionName: "setResolver",
    args: [BigInt(labelhash(parentLabel)), resolverAddress],
    account,
    chain: sepolia,
  });
  const setResolverReceipt = await publicClient.waitForTransactionReceipt({ hash: setResolverHash });
  const configuredResolver = await publicClient.readContract({
    address: parentRegistry,
    abi: parentRegistryAbi,
    functionName: "getResolver",
    args: [parentLabel],
  });

  if (!isAddress(configuredResolver) || getAddress(configuredResolver) !== resolverAddress) {
    throw new Error(`resolver verification failed: ${configuredResolver}`);
  }

  console.log(JSON.stringify(
    {
      parentName: normalize(parentName),
      parentRegistry,
      resolverAddress,
      gatewayUrl,
      deployTransactionHash: deployHash,
      deployBlockNumber: deployReceipt.blockNumber.toString(),
      setResolverTransactionHash: setResolverHash,
      setResolverBlockNumber: setResolverReceipt.blockNumber.toString(),
    },
    null,
    2,
  ));
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
