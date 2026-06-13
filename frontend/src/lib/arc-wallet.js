function getProvider() {
  if (!window.ethereum) {
    throw new Error("Ethereum wallet provider not found.");
  }

  return window.ethereum;
}

function toQuantity(value) {
  return `0x${Number(value).toString(16)}`;
}

function normalizeTransaction(transaction) {
  const normalized = {
    from: transaction.from,
    to: transaction.to,
    value: transaction.value ?? "0x0",
    data: transaction.data,
  };

  if (transaction.gas) {
    normalized.gas = transaction.gas;
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
  return provider.request({
    method: "eth_sendTransaction",
    params: [normalizeTransaction({
      ...transaction,
      from: accounts[0],
    })],
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
