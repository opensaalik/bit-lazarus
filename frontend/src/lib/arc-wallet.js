function getProvider() {
  if (!window.ethereum) {
    throw new Error("Ethereum wallet provider not found.");
  }

  return window.ethereum;
}

function toQuantity(value) {
  return `0x${Number(value).toString(16)}`;
}

function normalizeQuantity(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string") {
    return value.startsWith("0x") ? value : `0x${BigInt(value).toString(16)}`;
  }

  return `0x${BigInt(value).toString(16)}`;
}

async function estimateGas(provider, transaction) {
  try {
    return await provider.request({
      method: "eth_estimateGas",
      params: [transaction],
    });
  } catch (_error) {
    return null;
  }
}

async function normalizeTransaction(provider, transaction) {
  const normalized = {
    from: transaction.from,
    to: transaction.to,
    value: transaction.value ?? "0x0",
    data: transaction.data,
  };

  if (transaction.chainId) {
    normalized.chainId = toQuantity(transaction.chainId);
  }

  const gas = normalizeQuantity(transaction.gas ?? transaction.gasLimit)
    ?? await estimateGas(provider, normalized);

  if (gas) {
    normalized.gas = gas;
    normalized.gasLimit = gas;
  }

  return normalized;
}

export async function switchToArc(arcConfig) {
  const provider = getProvider();
  const chainId = toQuantity(arcConfig.chainId);

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch (error) {
    if (error.code !== 4902) {
      throw error;
    }

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId,
        chainName: arcConfig.chainName,
        nativeCurrency: {
          name: "USDC",
          symbol: "USDC",
          decimals: 18,
        },
        rpcUrls: [arcConfig.rpcUrl],
        blockExplorerUrls: ["https://testnet.arcscan.app"],
      }],
    });
  }
}

export async function sendWalletTransaction(transaction) {
  const provider = getProvider();
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const normalizedTransaction = await normalizeTransaction(provider, {
    ...transaction,
    from: accounts[0],
  });

  return provider.request({
    method: "eth_sendTransaction",
    params: [normalizedTransaction],
  });
}

export async function waitForWalletTransaction(txHash, { attempts = 90, intervalMs = 2000 } = {}) {
  const provider = getProvider();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    });

    if (receipt) {
      if (receipt.status === "0x0") {
        throw new Error(`Arc transaction failed: ${txHash}`);
      }

      return receipt;
    }

    await new Promise((resolve) => {
      window.setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Timed out waiting for Arc transaction: ${txHash}`);
}
