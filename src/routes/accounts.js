const express = require("express");
const router = express.Router();
const { server } = require("../config/stellar");
const { success, toISOTimestamp } = require("../utils/response");
const { validateAccountId } = require("../utils/validators");
const cacheService = require("../services/cache");
const cacheTTL = require("../config/cacheConfig");

const BATCH_TRANSACTION_COUNTS_MAX = 20;

/**
 * Fetches the transaction count and first/last transaction timestamps for a
 * single Stellar account by paging through its full transaction history.
 *
 * Non-existent accounts (Horizon 404) resolve to the zero-state shape
 * { count: 0, firstTransactionAt: null, lastTransactionAt: null } rather
 * than throwing, so a single missing address does not abort the whole batch.
 *
 * @param {string} address - Stellar public key (G...).
 * @returns {Promise<{ count: number, firstTransactionAt: string|null, lastTransactionAt: string|null }>}
 */
async function fetchTransactionCountForAddress(address) {
  // Check cache first
  const cacheKey = `transaction-count:${address}`;
  const cached = cacheService.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let count = 0;
  let firstTransactionAt = null;
  let lastTransactionAt = null;
  let cursor;

  try {
    // Verify the account exists before paging — loadAccount gives a clean 404.
    await server.loadAccount(address);

    do {
      let query = server
        .transactions()
        .forAccount(address)
        .limit(200)
        .order("asc");

      if (cursor) query = query.cursor(cursor);

      const page = await query.call();
      const records = page.records || [];

      if (records.length === 0) break;

      // Capture the very first transaction timestamp on the first page.
      if (count === 0) {
        firstTransactionAt = toISOTimestamp(records[0].created_at);
      }

      // Always update lastTransactionAt as we page forward.
      lastTransactionAt = toISOTimestamp(records[records.length - 1].created_at);

      count += records.length;
      cursor = records[records.length - 1].paging_token;

      if (records.length < 200) break;
    } while (true); // eslint-disable-line no-constant-condition
  } catch (err) {
    // Horizon 404 means the account does not exist — return the zero-state.
    if (err && err.response && err.response.status === 404) {
      return { count: 0, firstTransactionAt: null, lastTransactionAt: null };
    }
    // Any other error is unexpected — propagate it so the batch handler can
    // surface it as a 500 rather than silently swallowing it.
    throw err;
  }

  const result = { count, firstTransactionAt, lastTransactionAt };

  // Cache the result so repeated requests for the same address within the TTL
  // window don't hammer Horizon.
  cacheService.set(cacheKey, result, cacheTTL.transactionCount);

  return result;
}

/**
 * POST /accounts/transaction-counts
 *
 * Accepts a JSON body with an array of up to 20 Stellar account addresses and
 * returns the transaction count plus first/last transaction timestamps for each
 * address in a single response. Designed for leaderboard and analytics use
 * cases where fetching counts one-by-one would be prohibitively slow.
 *
 * Request body:
 *   { "addresses": ["G...", "G...", ...] }
 *
 * Constraints:
 *   - `addresses` must be a non-empty array.
 *   - Maximum of 20 addresses per request; exceeding this returns HTTP 400.
 *   - Each address must be a valid Stellar Ed25519 public key (G..., 56 chars).
 *   - Duplicate addresses are deduplicated before processing.
 *
 * Response shape:
 *   {
 *     "success": true,
 *     "data": {
 *       "results": {
 *         "G...": { "count": 42, "firstTransactionAt": "2021-03-01T00:00:00.000Z", "lastTransactionAt": "2024-07-15T10:30:00.000Z" },
 *         "G...": { "count": 0,  "firstTransactionAt": null, "lastTransactionAt": null }
 *       }
 *     }
 *   }
 *
 * Error responses:
 *   - 400: `addresses` missing, not an array, empty, or contains more than 20 items.
 *   - 400: Any address fails Ed25519 validation (reports the first invalid address).
 *
 * @example
 *   POST /accounts/transaction-counts
 *   Content-Type: application/json
 *
 *   { "addresses": ["GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"] }
 */
router.post("/transaction-counts", async (req, res, next) => {
  try {
    const { addresses } = req.body || {};

    // ── Validate `addresses` field ─────────────────────────────────────────

    if (!Array.isArray(addresses)) {
      const err = new Error(
        "Request body must include an 'addresses' array of Stellar public keys."
      );
      err.isValidation = true;
      err.field = "addresses";
      err.receivedValue = addresses === undefined ? "undefined" : String(addresses).slice(0, 50);
      err.expectedFormat = '{ "addresses": ["G...", "G..."] }';
      return next(err);
    }

    if (addresses.length === 0) {
      const err = new Error("'addresses' array must contain at least one address.");
      err.isValidation = true;
      err.field = "addresses";
      err.receivedValue = "[]";
      err.expectedFormat = '{ "addresses": ["G...", "G..."] }';
      return next(err);
    }

    if (addresses.length > BATCH_TRANSACTION_COUNTS_MAX) {
      const err = new Error(
        `Too many addresses. Maximum allowed is ${BATCH_TRANSACTION_COUNTS_MAX}, but ${addresses.length} were provided.`
      );
      err.isValidation = true;
      err.field = "addresses";
      err.receivedValue = String(addresses.length);
      err.expectedFormat = `Array of 1–${BATCH_TRANSACTION_COUNTS_MAX} Stellar public keys`;
      return next(err);
    }

    // Validate every address before touching Horizon so we fail fast with a
    // clear error message that names the offending address.
    for (const address of addresses) {
      validateAccountId(address);
    }

    // Deduplicate to avoid redundant Horizon calls for the same address.
    const uniqueAddresses = [...new Set(addresses)];

    // Fetch all counts in parallel — Horizon is the bottleneck, so firing
    // all requests concurrently significantly reduces total latency.
    const settlements = await Promise.allSettled(
      uniqueAddresses.map((address) => fetchTransactionCountForAddress(address))
    );

    // Build the results map. A rejected settlement (unexpected Horizon error)
    // is surfaced as a zero-state entry so the batch always returns a complete
    // map rather than a partial 500.
    const results = {};
    for (let i = 0; i < uniqueAddresses.length; i++) {
      const address = uniqueAddresses[i];
      const settlement = settlements[i];

      if (settlement.status === "fulfilled") {
        results[address] = settlement.value;
      } else {
        // Unexpected error for this address — zero-state with an error hint.
        results[address] = {
          count: 0,
          firstTransactionAt: null,
          lastTransactionAt: null,
          error: "Failed to retrieve transaction count for this address.",
        };
      }
    }

    return success(res, { results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
