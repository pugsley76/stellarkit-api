/**
 * In-process metrics counter for the StellarKit API.
 *
 * Tracks:
 *   - totalRequests   — incremented on every incoming request
 *   - totalErrors     — incremented on every error response (4xx / 5xx)
 *   - errorsByStatus  — map of HTTP status code → count, keyed as strings
 *                       e.g. { "400": 3, "404": 1, "500": 0, ... }
 *
 * Only the five status codes that operators care about most are pre-seeded
 * so the GET /metrics response is always a stable shape regardless of which
 * error types have fired so far:
 *   400, 404, 429, 500, 503
 *
 * Additional status codes are recorded as they occur.
 *
 * Usage:
 *   const metrics = require('./services/metrics');
 *   metrics.incrementRequests();
 *   metrics.incrementError(404);
 *   const snap = metrics.getSnapshot();
 */

/** Status codes that are always present in the errorsByStatus map. */
const TRACKED_STATUSES = [400, 404, 429, 500, 503];

class MetricsService {
  constructor() {
    this.reset();
  }

  /**
   * Reset all counters to zero.
   * Primarily used in tests (`beforeEach(() => metrics.reset())`).
   */
  reset() {
    this.totalRequests = 0;
    this.totalErrors = 0;
    /** @type {Record<string, number>} */
    this.errorsByStatus = {};
    // Pre-seed the five well-known status codes so the response shape is stable
    for (const code of TRACKED_STATUSES) {
      this.errorsByStatus[String(code)] = 0;
    }
  }

  /**
   * Increment the total request counter.
   * Should be called once per incoming HTTP request (e.g. in a middleware).
   */
  incrementRequests() {
    this.totalRequests++;
  }

  /**
   * Increment the total error counter and the per-status-code counter.
   *
   * @param {number} statusCode - HTTP status code of the error response (e.g. 404).
   */
  incrementError(statusCode) {
    this.totalErrors++;
    const key = String(statusCode);
    this.errorsByStatus[key] = (this.errorsByStatus[key] ?? 0) + 1;
  }

  /**
   * Return a snapshot of current metrics.
   *
   * @returns {{
   *   totalRequests: number,
   *   totalErrors: number,
   *   errorsByStatus: Record<string, number>
   * }}
   */
  getSnapshot() {
    return {
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      errorsByStatus: { ...this.errorsByStatus },
    };
  }
}

// Export a singleton so all modules share one set of counters.
module.exports = new MetricsService();
