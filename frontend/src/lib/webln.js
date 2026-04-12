function getWebLnProvider() {
  if (typeof window === "undefined" || typeof window.webln === "undefined") {
    throw new Error("WebLN wallet not found. Use a browser wallet that exposes window.webln.");
  }

  return window.webln;
}

function normalizeSignature(result) {
  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }

  if (!result || typeof result !== "object") {
    return null;
  }

  const candidates = [
    result.signature,
    result.signedMessage,
    result?.data?.signature,
    result?.response?.signature,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function normalizePaymentRequest(result) {
  if (!result || typeof result !== "object") {
    return null;
  }

  const paymentRequest = result.paymentRequest ?? result.payment_request ?? null;
  return typeof paymentRequest === "string" && paymentRequest.trim() ? paymentRequest.trim() : null;
}

export async function enableWebLn() {
  const provider = getWebLnProvider();
  await provider.enable();
  return provider;
}

export async function signMessageWithWebLn(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("message is required");
  }

  const provider = await enableWebLn();

  if (typeof provider.signMessage !== "function") {
    throw new Error("Your WebLN wallet does not support message signing.");
  }

  const result = await provider.signMessage(message);
  const signature = normalizeSignature(result);

  if (!signature) {
    throw new Error("WebLN signMessage did not return a signature.");
  }

  return signature;
}

export async function createInvoiceWithWebLn({ amountSats, memo = "" } = {}) {
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error("amountSats must be a positive integer");
  }

  const provider = await enableWebLn();

  if (typeof provider.makeInvoice !== "function") {
    throw new Error("Your WebLN wallet does not support invoice creation.");
  }

  const result = await provider.makeInvoice({
    amount: amountSats,
    defaultMemo: memo,
  });
  const paymentRequest = normalizePaymentRequest(result);

  if (!paymentRequest) {
    throw new Error("WebLN makeInvoice did not return a payment request.");
  }

  return {
    paymentRequest,
    raw: result,
  };
}

export async function sendPaymentWithWebLn(paymentRequest, { timeoutMs = 0 } = {}) {
  if (typeof paymentRequest !== "string" || !paymentRequest.trim()) {
    throw new Error("paymentRequest is required");
  }

  const provider = await enableWebLn();

  if (typeof provider.sendPayment !== "function") {
    throw new Error("Your WebLN wallet does not support Lightning payments.");
  }

  const paymentPromise = Promise.resolve(provider.sendPayment(paymentRequest));

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return {
      timedOut: false,
      result: await paymentPromise,
    };
  }

  let didTimeout = false;
  const guardedPromise = paymentPromise.catch((error) => {
    if (didTimeout) {
      return null;
    }

    throw error;
  });
  const timeoutResult = await Promise.race([
    guardedPromise.then((result) => ({ timedOut: false, result })),
    new Promise((resolve) => {
      window.setTimeout(() => {
        didTimeout = true;
        resolve({ timedOut: true, result: null });
      }, timeoutMs);
    }),
  ]);

  return timeoutResult;
}
