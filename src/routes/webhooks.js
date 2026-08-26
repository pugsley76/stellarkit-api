const express = require("express");
const router  = express.Router();
const webhookStore = require("../services/webhookStore");
const { success }  = require("../utils/response");
const StellarKitError = require("../utils/StellarKitError");

/**
 * Validate a webhook registration request body.
 * Returns an error message string when invalid, null when valid.
 *
 * @param {object} body
 * @returns {string|null}
 */
function validateRegistration(body) {
  if (!body || typeof body !== "object") {
    return "Request body is required.";
  }
  if (!body.url || typeof body.url !== "string" || body.url.trim() === "") {
    return "url is required and must be a non-empty string.";
  }
  // Simple URL format check — must start with http:// or https://
  if (!/^https?:\/\/.+/.test(body.url.trim())) {
    return "url must be a valid HTTP or HTTPS URL.";
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return "events must be a non-empty array of event type strings.";
  }
  if (body.events.some((e) => typeof e !== "string" || e.trim() === "")) {
    return "Each event in the events array must be a non-empty string.";
  }
  return null;
}

/**
 * POST /webhooks
 *
 * Register a new webhook. The caller provides a callback URL and the list of
 * event types to subscribe to.  A unique webhookId is assigned and returned.
 *
 * Request body:
 *   {
 *     "url":    "https://example.com/hooks",
 *     "events": ["payment", "account_funded"]
 *   }
 *
 * Response 201:
 *   {
 *     "success": true,
 *     "data": {
 *       "webhookId":    "wh_...",
 *       "url":          "https://example.com/hooks",
 *       "events":       ["payment", "account_funded"],
 *       "registeredAt": "2026-08-26T00:00:00.000Z"
 *     }
 *   }
 *
 * Response 400: { "success": false, "error": { "type": "ValidationError", ... } }
 */
router.post("/", (req, res, next) => {
  try {
    const validationError = validateRegistration(req.body);
    if (validationError) {
      return next(new StellarKitError(validationError, 400, "ValidationError"));
    }

    const entry = webhookStore.register({
      url:    req.body.url.trim(),
      events: req.body.events.map((e) => String(e).trim()),
    });

    return res.status(201).json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /webhooks
 *
 * List all registered webhooks.
 *
 * Response 200:
 *   {
 *     "success": true,
 *     "data": {
 *       "webhooks": [...],
 *       "total": 2
 *     }
 *   }
 */
router.get("/", (req, res) => {
  const webhooks = webhookStore.list();
  return success(res, { webhooks, total: webhooks.length });
});

/**
 * DELETE /webhooks/:webhookId
 *
 * Unregister a webhook by its ID.  Verifies the webhook exists before removal.
 *
 * Response 200 (success):
 *   {
 *     "success": true,
 *     "data": {
 *       "webhookId":    "wh_...",
 *       "unregistered": true
 *     }
 *   }
 *
 * Response 404 (not found):
 *   {
 *     "success": false,
 *     "error": {
 *       "type":    "WebhookNotFound",
 *       "message": "Webhook 'wh_...' was not found."
 *     }
 *   }
 */
router.delete("/:webhookId", (req, res, next) => {
  try {
    const { webhookId } = req.params;

    // Verify the webhook exists before attempting removal
    const existing = webhookStore.find(webhookId);
    if (!existing) {
      return next(
        new StellarKitError(
          `Webhook '${webhookId}' was not found.`,
          404,
          "WebhookNotFound",
          null,
          "Verify the webhookId is correct. Use GET /webhooks to list all registered webhooks.",
        ),
      );
    }

    webhookStore.remove(webhookId);

    return success(res, { webhookId, unregistered: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
