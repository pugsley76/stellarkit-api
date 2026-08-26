/**
 * Webhook delivery service.
 *
 * Sends normalised event payloads to all registered subscriber URLs that
 * match the event type and contract ID. Delivery is fire-and-forget with a
 * single retry on network failure; errors are logged but never surfaced to
 * the caller so that a failing subscriber cannot block event processing.
 */

const axios = require("axios");
const logger = require("../utils/logger");
const { findMatching } = require("./webhookRegistry");

const DELIVERY_TIMEOUT_MS = 5000;

/**
 * Attempt to POST `payload` to `url`. Returns true on 2xx, false otherwise.
 *
 * @param {string} url
 * @param {object} payload
 * @returns {Promise<boolean>}
 */
async function attemptDelivery(url, payload) {
  try {
    const response = await axios.post(url, payload, {
      timeout: DELIVERY_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      validateStatus: (status) => status >= 200 && status < 300,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deliver a `contract.event` payload to all matching webhook subscribers.
 *
 * The normalised payload shape is:
 * ```json
 * {
 *   "event":      "contract.event",
 *   "contractId": "<C… address>",
 *   "eventType":  "<string from the event's first topic>",
 *   "topic":      ["<xdr value>", ...],
 *   "value":      "<decoded or raw XDR value>",
 *   "ledger":     <number>
 * }
 * ```
 *
 * @param {object} contractEvent  Normalised contract event (see shape above).
 * @returns {Promise<void>}
 */
async function deliverContractEvent(contractEvent) {
  const { contractId } = contractEvent;
  const subscribers = findMatching("contract.event", contractId);

  if (subscribers.length === 0) return;

  await Promise.allSettled(
    subscribers.map(async (webhook) => {
      const success = await attemptDelivery(webhook.url, contractEvent);

      if (!success) {
        // Single retry after a short back-off
        await new Promise((r) => setTimeout(r, 500));
        const retrySuccess = await attemptDelivery(webhook.url, contractEvent);
        if (!retrySuccess) {
          logger.warn(
            { webhookId: webhook.id, url: webhook.url, contractId },
            `[WEBHOOK] Delivery failed after retry for webhook ${webhook.id}`,
          );
        }
      }
    }),
  );
}

module.exports = { deliverContractEvent };
