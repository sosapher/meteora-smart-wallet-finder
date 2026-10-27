import fs from "node:fs";
import { fetchJson, mapLimit } from "./http.js";
import { applyHygieneMetrics, fetchWalletHygiene, hygieneEnabled } from "./hygiene.js";
import { computeMetrics } from "./metrics.js";
import { isSolanaAddress } from "./lpers.js";
import { parseTimestampMs, shortAddress } from "./util.js";

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function usdTotal(bucket) {
  const total = bucket?.total?.usd;
  const direct = bucket?.usd;
  return numberOrNull(total) ?? numberOrNull(direct) ?? 0;
}

export function loadExistingSmartWallets(filePath, logger = null) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { wallets: [], addresses: new Set(), raw: { wallets: [] }, error: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const wallets = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.wallets)
        ? raw.wallets
        : [];
    return {
      wallets,
      addresses: new Set(
        wallets.map((wallet) => String(wallet.address || "").trim()).filter(Boolean),
      ),
      raw,
      error: null,
    };
  } catch (error) {
    logger?.warn(`Cannot read ${filePath}: ${error.message}`);
    return { wallets: [], addresses: new Set(), raw: { wallets: [] }, error: error.message };
  }
}

export async function fetchPortfolioOpen(
  wallet,
  config,
  cache,
  logger,
  { refresh = false } = {},
) {
  const cacheKey = `open:${wallet}`;
  const ttlMs = config.discovery.openCacheTtlMinutes * 60 * 1000;
  if (!refresh) {
    const cached = cache.get(cacheKey, ttlMs);
    if (cached) return cached;
  }

  const base = config.api.meteoraDataApi.replace(/\/+$/, "");
  const data = await fetchJson(`${base}/portfolio/open?user=${wallet}`, {
    timeoutMs: config.api.timeoutMs,
    retries: config.api.retries,
    minIntervalMs: config.api.minIntervalMs,
  });

  const pools = (Array.isArray(data.pools) ? data.pools : []).map((pool) => ({
    address: String(pool.poolAddress || pool.address || "").trim(),
    name:
      pool.poolName ||
      pool.name ||
      [pool.tokenX, pool.tokenY].filter(Boolean).join("-") ||
      "UNKNOWN",
    positions: Array.isArray(pool.listPositions) ? pool.listPositions : [],
    outOfRange: Boolean(pool.outOfRange),
    raw: pool,
  }));

  const result = {
    pools,
    totalPositions: Number(data.totalPositions || data.totalCount || 0),
    totalCount: Number(data.totalCount || 0),
    raw: data,
  };
  cache.set(cacheKey, result);
  logger?.debug(
    `Open portfolio ${shortAddress(wallet)}: ${result.totalPositions} position(s) in ${pools.length} pool(s)`,
  );
  return result;
}

export async function fetchClosedPositions(
  wallet,
  pool,
  config,
  cache,
  logger,
  { refresh = false } = {},
) {
  const base = config.api.meteoraDataApi.replace(/\/+$/, "");
  const maxPages = Math.max(1, Number(config.metrics.maxPagesPerPool));
  const ttlMs = config.discovery.pnlCacheTtlMinutes * 60 * 1000;
  const positions = [];
  let totalCount = 0;
  let pages = 0;
  let partial = false;
  let lastError = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const cacheKey = `pnl:${wallet}:${pool}:${page}`;
    let data = !refresh ? cache.get(cacheKey, ttlMs) : null;

    if (!data) {
      const params = new URLSearchParams({
        user: wallet,
        status: "closed",
        pageSize: "50",
        page: String(page),
      });
      try {
        data = await fetchJson(
          `${base}/positions/${pool}/pnl?${params.toString()}`,
          {
            timeoutMs: config.api.timeoutMs,
            retries: config.api.retries,
            minIntervalMs: config.api.minIntervalMs,
          },
        );
        cache.set(cacheKey, data);
      } catch (error) {
        lastError = error;
        if (page === 1) throw error;
        partial = true;
        break;
      }
    }

    pages = page;
    totalCount = Number(data.totalCount || totalCount || 0);
    const batch = Array.isArray(data.positions) ? data.positions : [];
    positions.push(...batch);

    if (!data.hasNext || batch.length === 0) break;
    if (page === maxPages) partial = true;
  }

  if (lastError) {
    logger?.warn(
      `Closed PnL partial for ${shortAddress(wallet)} in ${shortAddress(pool)}: ${lastError.message}`,
    );
  }

  return { positions, totalCount, pages, partial };
}

export function normalizePosition(raw, poolAddress) {
  const depositUsd = usdTotal(raw.allTimeDeposits);
  const feeUsd = usdTotal(raw.allTimeFees);
  const withdrawUsd = usdTotal(raw.allTimeWithdrawals);
  const pnlUsd = numberOrNull(raw.pnlUsd);
  const pnlPct = numberOrNull(raw.pnlPctChange);
  const createdAt = parseTimestampMs(raw.createdAt);
  const closedAt = parseTimestampMs(raw.closedAt);
  const lowerBinId = numberOrNull(raw.lowerBinId);
  const upperBinId = numberOrNull(raw.upperBinId);
  const widthBins =
    lowerBinId != null && upperBinId != null
      ? Math.abs(upperBinId - lowerBinId)
      : null;
  const holdHours =
    createdAt && closedAt && closedAt >= createdAt
      ? (closedAt - createdAt) / 3_600_000
      : null;

  return {
    position: String(raw.positionAddress || raw.position || "").trim(),
    pool: String(poolAddress || "").trim(),
    depositUsd,
    feeUsd,
    withdrawUsd,
    pnlUsd,
    pnlPct:
      pnlPct != null
        ? pnlPct
        : depositUsd > 0 && pnlUsd != null
          ? (pnlUsd / depositUsd) * 100
          : null,
    createdAt,
    closedAt,
    holdHours,
    widthBins,
    feePerTvl24h: numberOrNull(raw.feePerTvl24h),
    inRange: raw.isOutOfRange == null ? null : !raw.isOutOfRange,
  };
}

function dedupePositions(positions) {
  const byKey = new Map();
  for (const position of positions) {
    const key = position.position || `${position.pool}:${position.createdAt}`;
    if (!byKey.has(key)) byKey.set(key, position);
  }
  return [...byKey.values()];
}

function buildPoolList(candidate, open, allPools, config, maxPools) {
  const map = new Map();
  const add = (address, name, source) => {
    const key = String(address || "").trim();
    if (!key) return;
    if (!map.has(key)) map.set(key, { address: key, name: name || "UNKNOWN", source });
  };

  for (const pool of candidate.pools || []) {
    add(pool.address, pool.name, "seen");
  }
  for (const pool of open.pools || []) {
    add(pool.address, pool.name, "open");
  }
  for (const pool of allPools || []) {
    if (map.size >= maxPools) break;
    add(pool.address, pool.name, "scan");
  }

  return [...map.values()].slice(0, maxPools);
}

export async function deepCheckCandidate(
  candidate,
  { config, cache, logger, allPools = [], refresh = false, maxPools = null },
) {
  const limit = Math.max(
    1,
    Number(maxPools || config.discovery.maxPoolsPerWallet),
  );

  const hygienePromise = hygieneEnabled(config)
    ? fetchWalletHygiene(candidate.address, config, cache, logger, { refresh }).catch(
        (error) => ({
          enabled: true,
          wallet: candidate.address,
          error: error.message,
        }),
      )
    : Promise.resolve(null);

  let open = { pools: [], totalPositions: 0, totalCount: 0 };
  try {
    open = await fetchPortfolioOpen(candidate.address, config, cache, logger, {
      refresh,
    });
  } catch (error) {
    logger?.warn(`Portfolio open failed for ${shortAddress(candidate.address)}: ${error.message}`);
  }

  const poolList = buildPoolList(candidate, open, allPools, config, limit);
  const errors = [];

  let closedRequests = 0;
  let partial = false;
  const results = await mapLimit(
    poolList,
    config.discovery.concurrency,
    async (pool) => {
      try {
        const result = await fetchClosedPositions(
          candidate.address,
          pool.address,
          config,
          cache,
          logger,
          { refresh },
        );
        closedRequests += 1;
        if (result.partial) partial = true;
        return { pool, positions: result.positions, error: null };
      } catch (error) {
        errors.push({ pool: pool.address, error: error.message });
        return { pool, positions: [], error: error.message };
      }
    },
  );

  const rawPositions = results.flatMap((result) =>
    result.positions.map((raw) => ({ ...raw, __pool: result.pool.address })),
  );
  const normalized = dedupePositions(
    rawPositions
      .map((raw) => normalizePosition(raw, raw.__pool || raw.pool || ""))
      .filter((position) => position.position),
  );

  const minDeposit = Number(config.metrics.minPositionDepositUsd || 0);
  const eligible = normalized.filter(
    (position) =>
      position.depositUsd >= minDeposit &&
      Number.isFinite(position.pnlUsd) &&
      position.depositUsd > 0,
  );

  const metrics = applyHygieneMetrics(
    computeMetrics(eligible, {
      openPositions: open.totalPositions,
      openPools: open.pools.length,
      seenPoolCount: (candidate.pools || []).length,
      now: Date.now(),
      maxDaysSinceActive: config.metrics.maxDaysSinceActive,
      partial,
      totalRawPositions: normalized.length,
    }),
    await hygienePromise,
    config,
  );

  return {
    address: candidate.address,
    short: candidate.short || shortAddress(candidate.address),
    candidate,
    open: {
      totalPositions: open.totalPositions,
      pools: open.pools.map((pool) => ({
        address: pool.address,
        name: pool.name,
        positionCount: pool.positions.length,
        outOfRange: pool.outOfRange,
      })),
    },
    poolsChecked: poolList,
    closedRequests,
    positions: eligible,
    metrics,
    hygiene: metrics.hygiene || null,
    errors,
    partial,
  };
}
