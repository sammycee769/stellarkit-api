const express = require("express");
const router = express.Router();
const { server } = require("../config/stellar");
const { success } = require("../utils/response");
const { validateAccountId } = require("../utils/validators");

/**
 * GET /account/:id
 * Returns full account details including XLM balance, all asset balances,
 * signers, thresholds, flags, and sequence number.
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const account = await server.loadAccount(id);

    // Separate native XLM from other assets
    const xlmBalance = account.balances.find((b) => b.asset_type === "native");
    const tokenBalances = account.balances
      .filter((b) => b.asset_type !== "native")
      .map((b) => ({
        assetCode: b.asset_code,
        assetIssuer: b.asset_issuer,
        assetType: b.asset_type,
        balance: b.balance,
        limit: b.limit,
        buyingLiabilities: b.buying_liabilities,
        sellingLiabilities: b.selling_liabilities,
        isAuthorized: b.is_authorized,
        isClawbackEnabled: b.is_clawback_enabled,
      }));

    // Minimum balance calculation
    // Min balance = (2 + subentries) * base_reserve
    // We use 0.5 XLM as the current base reserve
    const baseReserve = 0.5;
    const minBalance = (2 + account.subentry_count) * baseReserve;

    return success(res, {
      accountId: account.id,
      sequence: account.sequence,
      subentryCount: account.subentry_count,
      xlm: {
        balance: xlmBalance ? xlmBalance.balance : "0.0000000",
        buyingLiabilities: xlmBalance ? xlmBalance.buying_liabilities : "0",
        sellingLiabilities: xlmBalance ? xlmBalance.selling_liabilities : "0",
        minimumBalance: minBalance.toFixed(7),
        spendableBalance: xlmBalance
          ? Math.max(0, parseFloat(xlmBalance.balance) - minBalance).toFixed(7)
          : "0.0000000",
      },
      assets: tokenBalances,
      assetCount: tokenBalances.length,
      signers: account.signers.map((s) => ({
        key: s.key,
        type: s.type,
        weight: s.weight,
      })),
      thresholds: account.thresholds,
      flags: account.flags,
      homeDomain: account.home_domain || null,
      lastModifiedLedger: account.last_modified_ledger,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/analytics", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const account = await server.loadAccount(id);

    const txResponse = await server
      .transactions()
      .forAccount(id)
      .limit(100)
      .order("desc")
      .call();

    const transactions = txResponse.records;

    let totalSent = 0;
    let totalReceived = 0;

    const assetUsage = {};
    let firstSeen = null;
    let lastSeen = null;

    for (const tx of transactions) {
      const createdAt = new Date(tx.created_at);

      if (!firstSeen || createdAt < firstSeen) firstSeen = createdAt;
      if (!lastSeen || createdAt > lastSeen) lastSeen = createdAt;

      const ops = await server.operations().forTransaction(tx.id).call();

      for (const op of ops.records) {
        const amount = parseFloat(op.amount || 0);

        // SENT
        if (op.from === id) {
          totalSent += amount;

          if (op.asset_code) {
            const key = `${op.asset_code}:${op.asset_issuer}`;
            assetUsage[key] = (assetUsage[key] || 0) + 1;
          }
        }

        // RECEIVED
        if (op.to === id) {
          totalReceived += amount;

          if (op.asset_code) {
            const key = `${op.asset_code}:${op.asset_issuer}`;
            assetUsage[key] = (assetUsage[key] || 0) + 1;
          }
        }
      }
    }

    // Convert asset usage into sorted array
    const topAssets = Object.entries(assetUsage)
      .map(([key, count]) => {
        const [assetCode, assetIssuer] = key.split(":");
        return {
          assetCode,
          assetIssuer,
          usageCount: count,
        };
      })
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 10);

    // Avg transactions per day
    const days =
      firstSeen && lastSeen
        ? Math.max(
            1,
            Math.ceil((lastSeen - firstSeen) / (1000 * 60 * 60 * 24))
          )
        : 1;

    const avgTransactionsPerDay = transactions.length / days;

    return success(res, {
      totalSent: totalSent.toFixed(7),
      totalReceived: totalReceived.toFixed(7),
      topAssets,
      avgTransactionsPerDay: Number(avgTransactionsPerDay.toFixed(2)),
      firstSeen,
      lastSeen,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
