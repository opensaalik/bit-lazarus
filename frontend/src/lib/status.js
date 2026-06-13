// Maps raw backend status strings to human labels and a visual "tone".
//   live    — open / actionable
//   wait    — waiting on something (funding, a counterpart)
//   good    — successfully completed / verified
//   dead    — canceled / failed / inactive
//   work    — in-flight protocol work (seeding, downloading, verifying)

const STATUS_MAP = {
  // Bounty.status
  OPEN: { label: "Open", tone: "live" },
  AWAITING_FUNDING: { label: "Awaiting funding", tone: "wait" },
  COMPLETED: { label: "Recovered", tone: "good" },
  CANCELED: { label: "Canceled", tone: "dead" },

  // Escrow
  FUNDED: { label: "Funded", tone: "good" },

  // Delivery / completion readiness
  PENDING: { label: "Pending", tone: "wait" },
  IN_PROGRESS: { label: "In progress", tone: "work" },
  READY: { label: "Ready", tone: "good" },
  NOT_READY: { label: "Not ready", tone: "dead" },

  // Contract states
  DELIVERY_IN_PROGRESS: { label: "Delivering", tone: "work" },
  DELIVERY_VERIFIED: { label: "Verified", tone: "good" },
  RESOLVED_SUCCESS: { label: "Resolved · success", tone: "good" },
  RESOLVED_FAILURE: { label: "Resolved · failure", tone: "dead" },

  // Hash status
  MATCHED: { label: "Hash matched", tone: "good" },
  MISMATCHED: { label: "Hash mismatch", tone: "dead" },
};

function titleCase(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function describeStatus(raw) {
  if (raw == null || raw === "") {
    return { label: "—", tone: "dead" };
  }

  const key = String(raw).toUpperCase();
  if (STATUS_MAP[key]) {
    return STATUS_MAP[key];
  }

  if (key.startsWith("RESOLVED_")) {
    return { label: titleCase(raw), tone: "good" };
  }

  return { label: titleCase(raw), tone: "work" };
}
