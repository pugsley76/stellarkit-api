const express = require("express");
const router = express.Router();
const accountRouter = require("./account");
const { server, NETWORK } = require("../config/stellar");
const { success } = require("../utils/response");
const {
  validateAccountId,
  validateAssetCode,
} = require("../utils/validators");
const { isNativeAsset, isNonNativeAsset } = require("../utils/assetHelpers");
const { formatAmount } = require("../utils/formatAmount");

const ZERO_NATIVE_BALANCE = {
  balance: "0.0000000",
  buyingLiabilities: "0.0000000",
  sellingLiabilities: "0.0000000",
};

function extractNativeBalance(account) {
  const xlmBalance = (account.balances || []).find((b) => isNativeAsset(b));
  if (!xlmBalance) {
    return { ...ZERO_NATIVE_BALANCE };
  }
  return {
    balance: formatAmount(xlmBalance.balance || "0"),
    buyingLiabilities: formatAmount(xlmBalance.buying_liabilities || "0"),
    sellingLiabilities: formatAmount(xlmBalance.selling_liabilities || "0"),
  };
}

function validateAddressBatch(addresses, fieldName = "addresses", maxAddresses = 30) {
  if (!addresses || !Array.isArray(addresses)) {
    const err = new Error(`Property '${fieldName}' is required and must be an array.`);
    err.isValidation = true;
    err.status = 400;
    err.field = fieldName;
    throw err;
  }

  if (addresses.length === 0) {
    const err = new Error("At least one address is required.");
    err.isValidation = true;
    err.status = 400;
    err.field = fieldName;
    throw err;
  }

  if (addresses.length > maxAddresses) {
    const err = new Error(`Maximum of ${maxAddresses} addresses allowed per request.`);
    err.isValidation = true;
    err.status = 400;
    err.field = fieldName;
    throw err;
  }

  for (const address of addresses) {
    if (typeof address !== "string") {
      const err = new Error(`Address must be a string, received ${typeof address}.`);
      err.isValidation = true;
      err.status = 400;
      err.field = fieldName;
      err.receivedValue = String(address).slice(0, 50);
      throw err;
    }
    try {
      validateAccountId(address);
    } catch (validationErr) {
      const err = new Error(`Invalid address "${address}": ${validationErr.message}`);
      err.isValidation = true;
      err.status = 400;
      err.field = fieldName;
      err.receivedValue = address;
      throw err;
    }
  }
}

/**
 * POST /accounts/trust-status
 *
 * Checks whether multiple accounts hold and are authorized for a specific asset.
 * Useful for developers managing asset distribution across many accounts.
 *
 * Request body:
 *   {
 *     "addresses": ["G...", "G...", ...],  // max 30 addresses
 *     "asset": {
 *       "code": "USDC",
 *       "issuer": "G..."
 *     }
 *   }
 *
 * Response:
 *   {
 *     "success": true,
 *     "data": {
 *       "results": {
 *         "G...": {
 *           "hasTrustline": true,
 *           "isAuthorized": true,
 *           "balance": "100.5000000"
 *         },
 *         "G...": {
 *           "hasTrustline": false,
 *           "isAuthorized": false,
 *           "balance": null
 *         }
 *       }
 *     }
 *   }
 *
 * Acceptance Criteria:
 * - Accepts up to 30 addresses
 * - Returns 400 if > 30 addresses provided
 * - Returns 400 if any address is invalid
 * - Returns 400 if asset code or issuer is invalid
 * - Non-existent accounts return { hasTrustline: false, isAuthorized: false, balance: null }
 * - Existing accounts without trustline return { hasTrustline: false, isAuthorized: false, balance: null }
 * - Existing accounts with trustline return { hasTrustline: true, isAuthorized: boolean, balance: string }
 *
 * @example
 * POST /accounts/trust-status
 * {
 *   "addresses": ["GABC...", "GDEF..."],
 *   "asset": { "code": "USDC", "issuer": "GBUQWP..." }
 * }
 */
/**
 * POST /accounts/native-balances
 *
 * Returns native XLM balance (with liabilities) for up to 30 accounts in one request.
 *
 * Request body: { "addresses": ["G...", "G..."] }
 * Response: { success: true, data: { results: { "G...": { balance, buyingLiabilities, sellingLiabilities } } } }
 */
router.post("/native-balances", async (req, res, next) => {
  try {
    const { addresses } = req.body;
    validateAddressBatch(addresses);

    const results = {};

    await Promise.all(
      addresses.map(async (address) => {
        try {
          const account = await server.loadAccount(address);
          results[address] = extractNativeBalance(account);
        } catch (err) {
          if (err && err.response && err.response.status === 404) {
            results[address] = { ...ZERO_NATIVE_BALANCE };
          } else {
            throw err;
          }
        }
      }),
    );

    return success(res, { results });
  } catch (err) {
    next(err);
  }
});

function validateEffectsLimit(limit) {
  if (limit === undefined || limit === null || limit === "") {
    return 10;
  }

  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit) || !Number.isInteger(numericLimit) || numericLimit < 1) {
    const err = new Error("Property 'limit' must be a positive integer.");
    err.isValidation = true;
    err.status = 400;
    err.field = "limit";
    err.receivedValue = limit;
    throw err;
  }

  return Math.min(numericLimit, 10);
}

router.post("/effects", async (req, res, next) => {
  try {
    const { addresses, limit } = req.body || {};
    validateAddressBatch(addresses, "addresses", 10);
    const normalizedLimit = validateEffectsLimit(limit);

    const results = {};

    await Promise.all(
      addresses.map(async (address) => {
        try {
          const response = await server
            .effects()
            .forAccount(address)
            .order("desc")
            .limit(normalizedLimit)
            .call();

          const effects = (response.records || []).map((effect) => accountRouter.normalizeEffect(effect));
          results[address] = { effects };
        } catch (err) {
          if (err && err.response && err.response.status === 404) {
            results[address] = { effects: [] };
            return;
          }
          throw err;
        }
      }),
    );

    return success(res, { results });
  } catch (err) {
    next(err);
  }
});

router.post("/trust-status", async (req, res, next) => {
  try {
    const { addresses, asset } = req.body;
    validateAddressBatch(addresses);

    // Validate asset
    if (!asset || typeof asset !== "object") {
      const err = new Error("Property 'asset' is required and must be an object with 'code' and 'issuer'.");
      err.isValidation = true;
      err.status = 400;
      err.field = "asset";
      throw err;
    }

    const { code, issuer } = asset;

    if (!code || typeof code !== "string") {
      const err = new Error("Asset 'code' is required and must be a string.");
      err.isValidation = true;
      err.status = 400;
      err.field = "asset.code";
      err.receivedValue = code;
      throw err;
    }

    if (!issuer || typeof issuer !== "string") {
      const err = new Error("Asset 'issuer' is required and must be a string.");
      err.isValidation = true;
      err.status = 400;
      err.field = "asset.issuer";
      err.receivedValue = issuer;
      throw err;
    }

    // Validate asset code and issuer
    try {
      validateAssetCode(code);
    } catch (codeErr) {
      const err = new Error(`Invalid asset code "${code}": ${codeErr.message}`);
      err.isValidation = true;
      err.status = 400;
      err.field = "asset.code";
      err.receivedValue = code;
      throw err;
    }

    try {
      validateAccountId(issuer);
    } catch (issuerErr) {
      const err = new Error(`Invalid issuer "${issuer}": ${issuerErr.message}`);
      err.isValidation = true;
      err.status = 400;
      err.field = "asset.issuer";
      err.receivedValue = issuer;
      throw err;
    }

    const normalizedCode = code.toUpperCase();

    // Fetch account data in parallel
    const results = {};

    const accountDataPromises = addresses.map(async (address) => {
      try {
        const account = await server.loadAccount(address);
        const trustlines = account.balances || [];

        // Find trustline for the specified asset
        const trustline = trustlines.find(
          (b) =>
            isNonNativeAsset(b) &&
            b.asset_code === normalizedCode &&
            b.asset_issuer === issuer
        );

        if (trustline) {
          results[address] = {
            hasTrustline: true,
            isAuthorized: trustline.is_authorized || false,
            balance: trustline.balance,
          };
        } else {
          // Account exists but no trustline for this asset
          results[address] = {
            hasTrustline: false,
            isAuthorized: false,
            balance: null,
          };
        }
      } catch (err) {
        // Account not found or other error - treat as no trustline
        if (err && err.response && err.response.status === 404) {
          results[address] = {
            hasTrustline: false,
            isAuthorized: false,
            balance: null,
          };
        } else {
          // For other errors, re-throw to let error handler deal with it
          throw err;
        }
      }
    });

    await Promise.all(accountDataPromises);

    return success(res, { results });
  } catch (err) {
    next(err);
  }
});

const MAX_SIGNER_ADDRESSES = 20;

/**
 * Normalise Horizon account signer data into the batch-lookup payload.
 *
 * @param {object} account - Horizon account record from `loadAccount`.
 * @returns {{ signers: object[], masterWeight: number, thresholds: { low: number, medium: number, high: number } }}
 */
function normalizeSignerPayload(account) {
  const signers = (account.signers || []).map((s) => ({
    key: s.key,
    weight: Number(s.weight),
    type: s.type || "ed25519_public_key",
    ...(s.sponsor ? { sponsoredBy: s.sponsor } : {}),
  }));

  const masterSigner = signers.find((s) => s.key === account.id);
  const masterWeight =
    masterSigner !== undefined
      ? masterSigner.weight
      : Number(account.master_weight ?? 0);

  return {
    signers,
    masterWeight,
    thresholds: {
      low: Number(account.thresholds?.low_threshold ?? 0),
      medium: Number(account.thresholds?.med_threshold ?? 0),
      high: Number(account.thresholds?.high_threshold ?? 0),
    },
  };
}

/**
 * POST /accounts/signers
 *
 * Batch lookup of signers, master weight, and thresholds for up to 20 accounts.
 *
 * Request body:
 *   { "addresses": ["G...", "G..."] }
 *
 * Response:
 *   {
 *     "success": true,
 *     "data": {
 *       "results": {
 *         "G...": { "signers": [...], "masterWeight": 1, "thresholds": { ... } },
 *         "G...": { "error": { "type": "AccountNotFound", "message": "..." } }
 *       }
 *     }
 *   }
 */
router.post("/signers", async (req, res, next) => {
  try {
    const { addresses } = req.body || {};

    if (!addresses || !Array.isArray(addresses)) {
      const err = new Error("Property 'addresses' is required and must be an array.");
      err.isValidation = true;
      err.status = 400;
      err.field = "addresses";
      throw err;
    }

    if (addresses.length === 0) {
      const err = new Error("At least one address is required.");
      err.isValidation = true;
      err.status = 400;
      err.field = "addresses";
      throw err;
    }

    if (addresses.length > MAX_SIGNER_ADDRESSES) {
      const err = new Error("Maximum of 20 addresses allowed per request.");
      err.isValidation = true;
      err.status = 400;
      err.field = "addresses";
      throw err;
    }

    for (const address of addresses) {
      if (typeof address !== "string") {
        const err = new Error(`Address must be a string, received ${typeof address}.`);
        err.isValidation = true;
        err.status = 400;
        err.field = "addresses";
        err.receivedValue = String(address).slice(0, 50);
        throw err;
      }
      try {
        validateAccountId(address);
      } catch (validationErr) {
        const err = new Error(`Invalid address "${address}": ${validationErr.message}`);
        err.isValidation = true;
        err.status = 400;
        err.field = "addresses";
        err.receivedValue = address;
        throw err;
      }
    }

    const results = {};

    await Promise.all(
      addresses.map(async (address) => {
        try {
          const account = await server.loadAccount(address);
          results[address] = normalizeSignerPayload(account);
        } catch (err) {
          if (err && err.response && err.response.status === 404) {
            results[address] = {
              error: {
                type: "AccountNotFound",
                message: `Account ${address} was not found on the Stellar ${NETWORK} network.`,
              },
            };
            return;
          }
          throw err;
        }
      }),
    );

    return success(res, { results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
