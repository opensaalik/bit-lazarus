import { requestJson } from "./api.js";
import { sendWalletTransaction, switchToArc, waitForWalletTransaction } from "./arc-wallet.js";

export async function getArcConfig() {
  const payload = await requestJson("/arc/config");
  return payload.arc;
}

export async function getArcBountyByInfoHash({ token, torrentInfoHash }) {
  const payload = await requestJson(`/arc/bounties/by-infohash/${torrentInfoHash}`, { token });
  return payload.bounty;
}

export async function findArcBountyByInfoHash({ token, torrentInfoHash }) {
  try {
    return await getArcBountyByInfoHash({ token, torrentInfoHash });
  } catch (error) {
    if (error.message === "Arc bounty not found") {
      return null;
    }

    throw error;
  }
}

export async function sendPreparedArcTransaction({ arcConfig, transaction }) {
  await switchToArc(arcConfig);
  const txHash = await sendWalletTransaction(transaction);
  await waitForWalletTransaction(txHash);
  return txHash;
}
