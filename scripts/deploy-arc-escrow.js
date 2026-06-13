import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const execFileAsync = promisify(execFile);
const DEFAULT_ARC_RPC_URL = "https://rpc.testnet.arc.network";
const DEFAULT_ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const DEFAULT_DEADLINE_SECONDS = 7 * 24 * 60 * 60;

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [DEFAULT_ARC_RPC_URL],
      webSocket: ["wss://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "Arcscan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }

  return value.trim();
}

async function buildContract() {
  await execFileAsync("forge", ["build", "--contracts", "contracts"], {
    stdio: "pipe",
  });
}

async function readArtifact() {
  const artifact = JSON.parse(
    await readFile("out/BitLazarusArcEscrow.sol/BitLazarusArcEscrow.json", "utf8"),
  );

  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  };
}

async function main() {
  const rpcUrl = process.env.ARC_RPC_URL?.trim() || DEFAULT_ARC_RPC_URL;
  const privateKey = readRequiredEnv("ARC_PRIVATE_KEY");
  const usdcAddress = getAddress(process.env.ARC_USDC_ADDRESS?.trim() || DEFAULT_ARC_USDC_ADDRESS);
  const defaultDeadlineSeconds = BigInt(
    Number.parseInt(process.env.ARC_DEFAULT_DEADLINE_SECONDS ?? String(DEFAULT_DEADLINE_SECONDS), 10),
  );

  await buildContract();
  const { abi, bytecode } = await readArtifact();
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport });

  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [usdcAddress, defaultDeadlineSeconds],
    account,
    chain: arcTestnet,
  });

  console.log(`Arc escrow deploy tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== "success") {
    throw new Error(`Arc escrow deployment failed: ${hash}`);
  }

  console.log(`Arc escrow deployed: ${receipt.contractAddress}`);
  console.log(`Arcscan: https://testnet.arcscan.app/address/${receipt.contractAddress}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
