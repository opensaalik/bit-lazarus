function shouldSyncBounty(bounty) {
  return !["COMPLETED", "CANCELED"].includes(bounty.status);
}

export async function syncBountyEscrows({ bountyService, escrowService, logger = console } = {}) {
  const bounties = bountyService.listBounties().filter(shouldSyncBounty);
  const results = [];

  for (const bounty of bounties) {
    try {
      const escrow = await escrowService.syncEscrow(bounty.escrowId);
      const updatedBounty = await bountyService.syncBountyEscrow({
        bountyId: bounty.id,
        escrowId: escrow.id,
        escrowStatus: escrow.status,
        funding: escrow.funding,
      });

      results.push({
        bountyId: updatedBounty.id,
        escrowId: escrow.id,
        status: updatedBounty.status,
      });
    } catch (error) {
      logger.warn(`failed to sync bounty escrow for ${bounty.id}: ${error.message}`);
    }
  }

  return results;
}

export function startBountyEscrowSync({
  bountyService,
  escrowService,
  intervalMs = 30_000,
  logger = console,
} = {}) {
  let inFlight = false;

  const runSync = async () => {
    if (inFlight) {
      return;
    }

    inFlight = true;

    try {
      await syncBountyEscrows({ bountyService, escrowService, logger });
    } catch (error) {
      logger.warn(`bounty escrow sync loop failed: ${error.message}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void runSync();
  }, intervalMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  void runSync();

  return {
    stop() {
      clearInterval(timer);
    },
    runOnce: runSync,
  };
}
