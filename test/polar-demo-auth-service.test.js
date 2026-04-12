import test from "node:test";
import assert from "node:assert/strict";
import { PolarDemoAuthService } from "../src/polar-demo-auth-service.js";

test("polar demo auth service reports whether backend demo auth is configured", () => {
  const configured = new PolarDemoAuthService({
    authService: {},
    rpcUrl: "http://127.0.0.1:18443",
    rpcUser: "polaruser",
    rpcPassword: "polarpass",
  });
  const missing = new PolarDemoAuthService({
    authService: {},
    rpcUrl: null,
    rpcUser: "polaruser",
    rpcPassword: "polarpass",
  });

  assert.deepEqual(configured.getCapabilities(), { backendDemoAuth: true });
  assert.deepEqual(missing.getCapabilities(), { backendDemoAuth: false });
});

test("polar demo auth service creates a session by issuing a challenge and signing it from bitcoin core", async () => {
  const calls = [];
  const authService = {
    async issueChallenge({ walletAddress }) {
      calls.push({ type: "challenge", walletAddress });
      return {
        id: "challenge-1",
        walletAddress,
        message: "Bit Lazarus wallet login\nWallet: some-address",
      };
    },
    async verifyChallenge(payload) {
      calls.push({ type: "verify", payload });
      return {
        user: {
          id: "user-1",
          walletAddress: payload.walletAddress,
          displayName: payload.displayName,
        },
        session: {
          token: "token-1",
        },
      };
    },
  };

  const service = new PolarDemoAuthService({
    authService,
    rpcUrl: "http://127.0.0.1:18443",
    rpcUser: "polaruser",
    rpcPassword: "polarpass",
    requesterWalletName: "requester-auth",
  });

  service.ensureWallet = async (walletName) => {
    calls.push({ type: "ensure-wallet", walletName });
  };
  service.getSignableAddress = async (walletName) => {
    calls.push({ type: "get-address", walletName });
    return "mrequesteraddress";
  };
  service.signMessage = async (walletName, walletAddress, message) => {
    calls.push({ type: "sign-message", walletName, walletAddress, message });
    return "signed-message";
  };

  const result = await service.createDemoSession({
    role: "requester",
    displayName: "Requester",
  });

  assert.equal(result.session.token, "token-1");
  assert.deepEqual(calls, [
    { type: "ensure-wallet", walletName: "requester-auth" },
    { type: "get-address", walletName: "requester-auth" },
    { type: "challenge", walletAddress: "mrequesteraddress" },
    {
      type: "sign-message",
      walletName: "requester-auth",
      walletAddress: "mrequesteraddress",
      message: "Bit Lazarus wallet login\nWallet: some-address",
    },
    {
      type: "verify",
      payload: {
        challengeId: "challenge-1",
        walletAddress: "mrequesteraddress",
        signature: "signed-message",
        displayName: "Requester",
      },
    },
  ]);
});
