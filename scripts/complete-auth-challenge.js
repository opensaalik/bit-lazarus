#!/usr/bin/env node

const defaults = {
  baseUrl: process.env.APP_BASE_URL ?? "http://127.0.0.1:3000",
  rpcUrl: process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:18443",
  rpcUser: process.env.BITCOIN_RPC_USER ?? "polaruser",
  rpcPassword: process.env.BITCOIN_RPC_PASSWORD ?? "polarpass",
  walletName: process.env.BITCOIN_WALLET_NAME ?? "bit-lazarus-auth",
  displayName: process.env.BITCOIN_WALLET_DISPLAY_NAME ?? "",
};

function parseArgs(argv) {
  const args = { ...defaults };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`unknown argument: ${arg}`);
    }

    if (next === undefined || next.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }

    if (arg === "--base-url") {
      args.baseUrl = next;
    } else if (arg === "--rpc-url") {
      args.rpcUrl = next;
    } else if (arg === "--rpc-user") {
      args.rpcUser = next;
    } else if (arg === "--rpc-password") {
      args.rpcPassword = next;
    } else if (arg === "--wallet") {
      args.walletName = next;
    } else if (arg === "--display-name") {
      args.displayName = next;
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }

    index += 1;
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/complete-auth-challenge.js [options]

Options:
  --base-url <url>         Bit Lazarus base URL (default: ${defaults.baseUrl})
  --rpc-url <url>          Bitcoin Core / Polar RPC URL (default: ${defaults.rpcUrl})
  --rpc-user <user>        RPC username (default: ${defaults.rpcUser})
  --rpc-password <pass>    RPC password (default: ${defaults.rpcPassword})
  --wallet <name>          Bitcoin wallet name to load or create (default: ${defaults.walletName})
  --display-name <name>    Optional Bit Lazarus display name
  --help                   Show this help

Examples:
  node scripts/complete-auth-challenge.js --wallet requester-auth --display-name Requester
  node scripts/complete-auth-challenge.js --wallet hunter-auth --display-name Hunter
`);
}

async function bitcoinRpc({ rpcUrl, rpcUser, rpcPassword, walletName, method, params = [] }) {
  const url = walletName
    ? `${rpcUrl.replace(/\/$/, "")}/wallet/${encodeURIComponent(walletName)}`
    : rpcUrl;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      authorization: `Basic ${Buffer.from(`${rpcUser}:${rpcPassword}`).toString("base64")}`,
    },
    body: JSON.stringify({
      jsonrpc: "1.0",
      id: "bit-lazarus-auth",
      method,
      params,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`bitcoin rpc ${method} failed with status ${response.status}`);
  }

  if (payload.error) {
    throw new Error(`bitcoin rpc ${method} failed: ${payload.error.message}`);
  }

  return payload.result;
}

async function ensureWallet(args) {
  const wallets = await bitcoinRpc({
    ...args,
    walletName: null,
    method: "listwalletdir",
  });
  const knownWallets = Array.isArray(wallets?.wallets) ? wallets.wallets.map((entry) => entry.name) : [];

  if (!knownWallets.includes(args.walletName)) {
    await bitcoinRpc({
      ...args,
      walletName: null,
      method: "createwallet",
      params: [args.walletName],
    });
    return;
  }

  const loadedWallets = await bitcoinRpc({
    ...args,
    walletName: null,
    method: "listwallets",
  });

  if (!loadedWallets.includes(args.walletName)) {
    await bitcoinRpc({
      ...args,
      walletName: null,
      method: "loadwallet",
      params: [args.walletName],
    });
  }
}

async function getSignableAddress(args) {
  return bitcoinRpc({
    ...args,
    walletName: args.walletName,
    method: "getnewaddress",
    params: ["", "legacy"],
  });
}

async function signMessage(args, walletAddress, message) {
  return bitcoinRpc({
    ...args,
    walletName: args.walletName,
    method: "signmessage",
    params: [walletAddress, message],
  });
}

async function requestJson(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `request failed with status ${response.status}`);
  }

  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  await ensureWallet(args);
  const walletAddress = await getSignableAddress(args);

  const challengePayload = await requestJson(`${args.baseUrl.replace(/\/$/, "")}/auth/challenges`, {
    method: "POST",
    body: { walletAddress },
  });

  const signature = await signMessage(args, walletAddress, challengePayload.challenge.message);
  const verifyPayload = await requestJson(`${args.baseUrl.replace(/\/$/, "")}/auth/verify`, {
    method: "POST",
    body: {
      challengeId: challengePayload.challenge.id,
      walletAddress,
      signature,
      displayName: args.displayName || null,
    },
  });

  console.log(JSON.stringify({
    ok: true,
    walletName: args.walletName,
    walletAddress,
    challengeId: challengePayload.challenge.id,
    token: verifyPayload.session.token,
    user: verifyPayload.user,
    session: verifyPayload.session,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
