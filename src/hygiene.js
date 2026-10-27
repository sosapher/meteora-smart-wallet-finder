import { fetchJson } from "./http.js";
import { FLAG_LABELS } from "./score.js";
import { daysBetween, round, shortAddress } from "./util.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export function hygieneEnabled(config) {
  return Boolean(
    config.hygiene?.enabled !== false && String(config.hygiene?.rpcUrl || "").trim(),
  );
}

function rpcEndpoint(config) {
  const url = String(config.hygiene?.rpcUrl || "").trim();
  if (!url) throw new Error("Helius RPC URL is not configured");
  return url;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Minimal JSON-RPC client for Helius. Caches results so repeated scans do not
 * burn credits. The RPC URL contains the API key, so errors only expose the
 * method name, never the URL.
 */
export async function rpcCall(
  config,
  method,
  params,
  { cache = null, logger = null, refresh = false } = {},
) {
  const cacheKey = `helius:${method}:${JSON.stringify(params)}`;
  const ttlMs = positive(config.hygiene?.cacheTtlMinutes, 1440) * 60_000;

  if (cache && !refresh) {
    const cached = cache.get(cacheKey, ttlMs);
    if (cached !== null && cached !== undefined) return cached;
  }

  try {
    const data = await fetchJson(rpcEndpoint(config), {
      method: "POST",
      body: { jsonrpc: "2.0", id: "meteora-smart-wallet-finder", method, params },
      headers: { "content-type": "application/json" },
      timeoutMs: positive(config.hygiene?.timeoutMs, config.api?.timeoutMs ?? 25_000),
      retries: Number.isFinite(Number(config.hygiene?.retries))
        ? Number(config.hygiene.retries)
        : 2,
      minIntervalMs: Number.isFinite(Number(config.hygiene?.minIntervalMs))
        ? Number(config.hygiene.minIntervalMs)
        : 120,
      displayUrl: `helius-rpc:${method}`,
    });

    if (data?.error) {
      const message = data.error.message || `code ${data.error.code}`;
      throw new Error(`Helius RPC ${method} failed: ${message}`);
    }
    if (!data || !Object.hasOwn(data, "result")) {
      throw new Error(`Helius RPC ${method} returned no result`);
    }

    cache?.set(cacheKey, data.result);
    return data.result;
  } catch (error) {
    logger?.debug(`Helius RPC ${method} failed for ${shortAddress(params?.[0] || "")}: ${error.message}`);
    throw error;
  }
}

function accountKey(entry) {
  if (typeof entry === "string") return entry;
  return entry?.pubkey || entry?.accountKey || null;
}

/**
 * Find the wallet that most likely funded this wallet in its earliest
 * transaction. Uses SOL balance deltas, which works for normal system
 * transfers and most exchange withdrawals.
 */
export function extractFundingSource(transaction, wallet) {
  const message = transaction?.transaction?.message;
  if (!message) return { funder: null, feePayer: null, walletDeltaLamports: null };

  const keys = (message.accountKeys || []).map(accountKey).filter(Boolean);
  const pre = transaction?.meta?.preBalances || [];
  const post = transaction?.meta?.postBalances || [];
  const deltas = keys.map((key, index) => ({
    key,
    delta: Number(post[index] ?? 0) - Number(pre[index] ?? 0),
  }));

  const feePayer = keys[0] || null;
  const walletEntry = deltas.find((entry) => entry.key === wallet) || null;

  let funder = null;
  if (feePayer && feePayer !== wallet) {
    const payerEntry = deltas.find((entry) => entry.key === feePayer);
    if (payerEntry && payerEntry.delta < 0) funder = feePayer;
  }

  if (!funder) {
    const candidates = deltas
      .filter(
        (entry) =>
          entry.key !== wallet &&
          entry.key !== feePayer &&
          entry.key !== SYSTEM_PROGRAM &&
          entry.delta < 0,
      )
      .sort((a, b) => a.delta - b.delta);
    funder = candidates[0]?.key || null;
  }

  return {
    funder,
    feePayer,
    walletDeltaLamports: walletEntry ? walletEntry.delta : null,
    accountKeyCount: keys.length,
  };
}

async function classifyFunder(funder, config, cache, logger, { refresh = false } = {}) {
  if (!funder) return "unknown";
  try {
    const info = await rpcCall(
      config,
      "getAccountInfo",
      [funder, { encoding: "jsonParsed" }],
      { cache, logger, refresh },
    );
    const value = info?.value;
    if (!value) return "unknown";
    if (value.executable) return "program";
    if (value.owner === SYSTEM_PROGRAM) return "wallet";
    return "account";
  } catch {
    return "unknown";
  }
}

async function fetchSignatureHistory(wallet, config, cache, logger, { refresh = false } = {}) {
  const pageSize = Math.min(
    1000,
    Math.max(1, Math.floor(positive(config.hygiene?.signaturePageSize, 1000))),
  );
  const maxPages = Math.min(
    20,
    Math.max(1, Math.floor(positive(config.hygiene?.maxSignaturePages, 3))),
  );

  const signatures = [];
  let before = null;
  let pages = 0;
  let capped = false;

  for (let page = 0; page < maxPages; page += 1) {
    const options = { limit: pageSize };
    if (before) options.before = before;

    const batch = await rpcCall(
      config,
      "getSignaturesForAddress",
      [wallet, options],
      { cache, logger, refresh },
    );

    pages += 1;
    if (!Array.isArray(batch) || batch.length === 0) break;

    signatures.push(...batch);
    if (batch.length < pageSize) break;

    before = batch[batch.length - 1].signature;
    if (page === maxPages - 1) capped = true;
  }

  return { signatures, pages, capped };
}

/**
 * Fetch on-chain hygiene for one wallet. Never throws: RPC failures are
 * returned as `{ enabled, error }` so a scan can continue.
 */
export async function fetchWalletHygiene(
  wallet,
  config,
  cache = null,
  logger = null,
  { refresh = false } = {},
) {
  if (!hygieneEnabled(config)) return { enabled: false };

  try {
    const [balanceResult, historyResult] = await Promise.allSettled([
      rpcCall(config, "getBalance", [wallet], { cache, logger, refresh }),
      fetchSignatureHistory(wallet, config, cache, logger, { refresh }),
    ]);

    if (historyResult.status === "rejected") throw historyResult.reason;
    const history = historyResult.value;
    const balanceLamports =
      balanceResult.status === "fulfilled" ? Number(balanceResult.value || 0) : null;
    const balanceError =
      balanceResult.status === "rejected"
        ? String(balanceResult.reason?.message || balanceResult.reason)
        : null;

    const signatures = history.signatures;
    const latest = signatures[0] || null;
    const oldest = signatures[signatures.length - 1] || null;
    const now = Date.now();

    const lastSignatureAt = latest?.blockTime
      ? latest.blockTime * 1000
      : null;
    const firstSignatureAt = oldest?.blockTime
      ? oldest.blockTime * 1000
      : null;
    const ageDays = firstSignatureAt
      ? daysBetween(firstSignatureAt, now)
      : null;
    const daysSinceLastSignature = lastSignatureAt
      ? daysBetween(lastSignatureAt, now)
      : null;

    let funder = null;
    let funderType = "unknown";
    let fundedAt = null;
    let fundingPartial = false;
    let fundingError = null;

    const oldestSuccessful = [...signatures]
      .reverse()
      .find((signature) => !signature.err);

    if (oldestSuccessful) {
      try {
        const transaction = await rpcCall(
          config,
          "getTransaction",
          [
            oldestSuccessful.signature,
            {
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            },
          ],
          { cache, logger, refresh },
        );

        if (transaction) {
          const funding = extractFundingSource(transaction, wallet);
          funder = funding.funder;
          fundedAt = transaction.blockTime ? transaction.blockTime * 1000 : null;
          fundingPartial = history.capped;
          if (funder) {
            funderType = await classifyFunder(funder, config, cache, logger, {
              refresh,
            });
          }
        }
      } catch (error) {
        fundingError = error.message;
        logger?.warn(
          `Could not resolve funding source for ${shortAddress(wallet)}: ${error.message}`,
        );
      }
    }

    const result = {
      enabled: true,
      wallet,
      balanceSol:
        balanceLamports == null ? null : round(balanceLamports / 1e9, 4),
      balanceError,
      ageDays: ageDays == null ? null : round(ageDays, 1),
      ageCapped: history.capped,
      firstSignatureAt: firstSignatureAt
        ? new Date(firstSignatureAt).toISOString()
        : null,
      lastSignatureAt: lastSignatureAt
        ? new Date(lastSignatureAt).toISOString()
        : null,
      daysSinceLastSignature:
        daysSinceLastSignature == null ? null : round(daysSinceLastSignature, 1),
      signatureCount: signatures.length,
      signaturePages: history.pages,
      signatureCountPartial: history.capped,
      funder: funder || null,
      funderType,
      fundedAt: fundedAt ? new Date(fundedAt).toISOString() : null,
      fundingPartial,
      fundingError,
      error: null,
    };

    logger?.debug(
      `On-chain hygiene ${shortAddress(wallet)}: age ${result.ageDays ?? "?"}d, ` +
        `SOL ${result.balanceSol}, funder ${result.funder ? shortAddress(result.funder) : "unknown"}`,
    );

    return result;
  } catch (error) {
    logger?.warn(
      `On-chain hygiene failed for ${shortAddress(wallet)}: ${error.message}`,
    );
    return {
      enabled: true,
      wallet,
      error: error.message,
      balanceSol: null,
      ageDays: null,
      funder: null,
      funderType: "unknown",
    };
  }
}

/**
 * Merge RPC results into closed-position metrics and add warning flags.
 * Does not change the weighted score; it only informs gates and warnings.
 */
export function applyHygieneMetrics(metrics, hygiene, config) {
  if (!hygiene?.enabled) return metrics;

  const minAgeDays = Number(config.hygiene?.minWalletAgeDays ?? 30);
  const maxInactiveDays = Number(
    config.hygiene?.maxDaysSinceSignature ?? 14,
  );
  const minSolBalance = Number(config.hygiene?.minSolBalance ?? 0.02);

  const normalized = {
    enabled: true,
    walletAgeDays: hygiene.ageDays == null ? null : round(hygiene.ageDays, 1),
    ageCapped: Boolean(hygiene.ageCapped),
    firstSeenAt: hygiene.firstSignatureAt || null,
    lastSeenAt: hygiene.lastSignatureAt || null,
    daysSinceLastSignature:
      hygiene.daysSinceLastSignature == null
        ? null
        : round(hygiene.daysSinceLastSignature, 1),
    solBalance: hygiene.balanceSol == null ? null : round(hygiene.balanceSol, 4),
    funder: hygiene.funder || null,
    funderType: hygiene.funderType || "unknown",
    fundedAt: hygiene.fundedAt || null,
    signatureCount: Number(hygiene.signatureCount || 0),
    signaturePages: Number(hygiene.signaturePages || 0),
    signatureCountPartial: Boolean(hygiene.signatureCountPartial),
    fundingPartial: Boolean(hygiene.fundingPartial),
    balanceError: hygiene.balanceError || null,
    error: hygiene.error || null,
  };

  const flags = new Set(metrics.flags || []);

  if (normalized.error) {
    flags.add("hygiene_unknown");
  } else if (normalized.walletAgeDays == null) {
    flags.add(
      normalized.signatureCount === 0 ? "no_onchain_history" : "hygiene_unknown",
    );
  } else if (!normalized.ageCapped && normalized.walletAgeDays < minAgeDays) {
    flags.add("new_wallet");
  } else if (
    normalized.ageCapped &&
    normalized.walletAgeDays < minAgeDays
  ) {
    flags.add("wallet_age_uncertain");
  }

  if (
    normalized.daysSinceLastSignature != null &&
    normalized.daysSinceLastSignature > maxInactiveDays
  ) {
    flags.add("inactive_wallet");
  }

  if (
    normalized.solBalance != null &&
    normalized.solBalance < minSolBalance
  ) {
    flags.add("low_sol");
  }

  return { ...metrics, flags: [...flags], hygiene: normalized };
}

/**
 * Flag candidate groups that share the same funder. This is a heuristic, not
 * proof of common ownership: exchanges and launchpads can fund many wallets.
 */
export function annotateSharedFunders(candidates, config) {
  if (!hygieneEnabled(config) || config.hygiene?.detectSharedFunder === false) {
    return candidates;
  }

  const ignored = new Set(
    (config.hygiene?.ignoreFunders || []).map((address) => String(address)),
  );
  const minWallets = Math.max(
    2,
    Number(config.hygiene?.minSharedFunderWallets ?? 2),
  );

  const groups = new Map();
  for (const candidate of candidates) {
    const hygiene = candidate.metrics?.hygiene;
    const funder = hygiene?.funder;
    if (!funder || ignored.has(funder)) continue;
    if (hygiene.funderType === "program" || hygiene.funderType === "unknown") {
      continue;
    }
    if (!groups.has(funder)) groups.set(funder, []);
    groups.get(funder).push(candidate);
  }

  for (const [funder, group] of groups) {
    if (group.length < minWallets) continue;

    for (const candidate of group) {
      candidate.metrics.hygiene.sharedFunder = funder;
      candidate.metrics.hygiene.sharedFunderCount = group.length;

      candidate.metrics.flags = candidate.metrics.flags || [];
      if (!candidate.metrics.flags.includes("shared_funder")) {
        candidate.metrics.flags.push("shared_funder");
      }

      const label = FLAG_LABELS.shared_funder;
      candidate.score.warnings = candidate.score.warnings || [];
      if (!candidate.score.warnings.includes(label)) {
        candidate.score.warnings.push(label);
      }
    }
  }

  return candidates;
}

export function printHygieneReport(wallet, hygiene) {
  if (!hygiene?.enabled) {
    console.log("Helius RPC is not configured. Set hygiene.rpcUrl in config.json.");
    return;
  }

  console.log("");
  console.log(`Wallet      : ${wallet}`);
  console.log(
    `Wallet age  : ${
      hygiene.ageDays == null
        ? "unknown"
        : `${hygiene.ageDays}d${hygiene.ageCapped ? " (at least)" : ""}`
    }`,
  );
  console.log(`First seen  : ${hygiene.firstSignatureAt || "-"}`);
  console.log(
    `Last seen   : ${hygiene.lastSignatureAt || "-"}` +
      (hygiene.daysSinceLastSignature == null
        ? ""
        : ` (${hygiene.daysSinceLastSignature}d ago)`),
  );
  console.log(
    `SOL balance : ${hygiene.balanceSol == null ? "-" : hygiene.balanceSol}`,
  );
  if (hygiene.balanceError) console.log(`Balance err : ${hygiene.balanceError}`);
  console.log(
    `Signatures  : ${hygiene.signatureCount ?? 0}` +
      ` (${hygiene.signaturePages ?? 0} page(s)${
        hygiene.signatureCountPartial ? ", partial" : ""
      })`,
  );
  console.log(
    `Funder      : ${hygiene.funder || "-"}` +
      (hygiene.funder ? ` (${hygiene.funderType})` : ""),
  );
  if (hygiene.fundedAt) console.log(`Funded at   : ${hygiene.fundedAt}`);
  if (hygiene.error) console.log(`Error       : ${hygiene.error}`);
}
