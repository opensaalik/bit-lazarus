function getEthereumProvider() {
  if (!window.ethereum) {
    throw new Error("Brave Wallet or another Ethereum wallet provider was not found.");
  }

  return window.ethereum;
}

export async function requestWalletAddress() {
  const provider = getEthereumProvider();
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const walletAddress = accounts?.[0];

  if (!walletAddress) {
    throw new Error("No wallet account was returned.");
  }

  return walletAddress;
}

export async function signWalletMessage({ walletAddress, message }) {
  if (!walletAddress) {
    throw new Error("walletAddress is required.");
  }

  if (!message) {
    throw new Error("message is required.");
  }

  const provider = getEthereumProvider();
  return provider.request({
    method: "personal_sign",
    params: [message, walletAddress],
  });
}
