import test from "node:test";
import assert from "node:assert/strict";
import { startBountyEscrowSync, syncBountyEscrows } from "../src/bounty-escrow-sync.js";

test("syncBountyEscrows updates active bounties from escrow state", async () => {
  const syncedEscrows = [];
  const syncedBounties = [];
  const bountyService = {
    listBounties() {
      return [
        { id: "bounty-1", escrowId: "escrow-1", status: "AWAITING_FUNDING" },
        { id: "bounty-2", escrowId: "escrow-2", status: "OPEN" },
        { id: "bounty-3", escrowId: "escrow-3", status: "COMPLETED" },
      ];
    },
    async syncBountyEscrow(update) {
      syncedBounties.push(update);
      return { id: update.bountyId, status: update.escrowStatus };
    },
  };
  const escrowService = {
    async syncEscrow(escrowId) {
      syncedEscrows.push(escrowId);
      return {
        id: escrowId,
        status: escrowId === "escrow-1" ? "FUNDED" : "RELEASED",
        funding: { paymentRequest: `invoice-${escrowId}` },
      };
    },
  };

  const result = await syncBountyEscrows({
    bountyService,
    escrowService,
    logger: { warn() {} },
  });

  assert.deepEqual(syncedEscrows, ["escrow-1", "escrow-2"]);
  assert.deepEqual(syncedBounties, [
    {
      bountyId: "bounty-1",
      escrowId: "escrow-1",
      escrowStatus: "FUNDED",
      funding: { paymentRequest: "invoice-escrow-1" },
    },
    {
      bountyId: "bounty-2",
      escrowId: "escrow-2",
      escrowStatus: "RELEASED",
      funding: { paymentRequest: "invoice-escrow-2" },
    },
  ]);
  assert.equal(result.length, 2);
});

test("syncBountyEscrows isolates sync failures", async () => {
  const warnings = [];
  const bountyService = {
    listBounties() {
      return [
        { id: "bounty-1", escrowId: "escrow-1", status: "OPEN" },
        { id: "bounty-2", escrowId: "escrow-2", status: "OPEN" },
      ];
    },
    async syncBountyEscrow(update) {
      return update;
    },
  };
  const escrowService = {
    async syncEscrow(escrowId) {
      if (escrowId === "escrow-1") {
        throw new Error("temporary failure");
      }

      return { id: escrowId, status: "FUNDED", funding: null };
    },
  };

  const result = await syncBountyEscrows({
    bountyService,
    escrowService,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.equal(result.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to sync bounty escrow for bounty-1/);
});

test("startBountyEscrowSync runs an immediate sync and can be stopped", async () => {
  let runCount = 0;
  const bountyService = {
    listBounties() {
      runCount += 1;
      return [];
    },
  };
  const escrowService = {
    async syncEscrow() {
      throw new Error("should not be called");
    },
  };

  const syncHandle = startBountyEscrowSync({
    bountyService,
    escrowService,
    intervalMs: 10_000,
    logger: { warn() {} },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  syncHandle.stop();

  assert.ok(runCount >= 1);
});
