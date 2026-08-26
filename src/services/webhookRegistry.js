/**
 * In-memory webhook registry.
 *
 * Stores webhook subscriptions and provides helpers for registering new
 * entries and looking up subscriptions that match a given event type /
 * contract ID combination.
 *
 * The registry is intentionally kept in-memory for simplicity. In a
 * production deployment it would be backed by a persistent store (Redis,
 * Postgres, etc.) — swap out the `_webhooks` map for that layer without
 * changing the public interface.
 */

const { randomUUID } = require("crypto");

/** @type {Map<string, WebhookEntry>} */
const _webhooks = new Map();

/**
 * @typedef {Object} WebhookEntry
 * @property {string} id          - Unique webhook ID (UUID v4).
 * @property {string} url         - Delivery target URL.
 * @property {string} event       - Event type, e.g. "contract.event".
 * @property {string|null} contractId - Soroban contract address to filter on
 *                                     (null means "all contracts").
 * @property {string} createdAt   - ISO 8601 creation timestamp.
 */

/**
 * Register a new webhook subscription.
 *
 * @param {object} opts
 * @param {string} opts.url        - Outbound delivery URL (must be https or http).
 * @param {string} opts.event      - Event type to subscribe to.
 * @param {string|null} [opts.contractId] - Optional contract ID filter.
 * @returns {WebhookEntry} The created entry.
 */
function register({ url, event, contractId = null }) {
  const entry = {
    id: randomUUID(),
    url,
    event,
    contractId: contractId || null,
    createdAt: new Date().toISOString(),
  };
  _webhooks.set(entry.id, entry);
  return entry;
}

/**
 * Return all registered webhooks as an array.
 *
 * @returns {WebhookEntry[]}
 */
function list() {
  return Array.from(_webhooks.values());
}

/**
 * Find all webhooks that should be triggered for a given event and contractId.
 *
 * A webhook matches when:
 *   - Its `event` equals the provided `event`, AND
 *   - Its `contractId` is null (wildcard) OR equals the provided `contractId`.
 *
 * @param {string} event
 * @param {string} contractId
 * @returns {WebhookEntry[]}
 */
function findMatching(event, contractId) {
  return Array.from(_webhooks.values()).filter(
    (wh) =>
      wh.event === event &&
      (wh.contractId === null || wh.contractId === contractId),
  );
}

/**
 * Remove a webhook by ID. Returns true if it existed and was removed.
 *
 * @param {string} id
 * @returns {boolean}
 */
function remove(id) {
  return _webhooks.delete(id);
}

/**
 * Clear all webhooks (used in tests).
 */
function clear() {
  _webhooks.clear();
}

module.exports = { register, list, findMatching, remove, clear };
