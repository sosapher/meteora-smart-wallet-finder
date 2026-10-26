import { fetchJson } from "./http.js";
import {
  clamp,
  daysBetween,
  parseTimestampMs,
  recencyScoreDays,
  round,
  shortAddress,
} from "./util.js";

const KNOWN_PROGRAM_IDS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "ComputeBudget111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "So11111111111111111111111111111111111111112",
]);

export function isSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(address || "").trim());
}

function normalizedLper(entry, pool, source) {
  return {
    owner: String(entry.owner || "").trim(),
    ownerShort: entry.ownerShort || shortAddress(entry.owner),
    totalInflowUsd: Number(entry.totalInflowUsd || 0),
    totalFeeUsd: Number(entry.totalFeeUsd || 0),
    totalPnlUsd: Number(entry.totalPnlUsd || 0),
    feePercent: Number(entry.feePercent || 0),
    pnlPerInflowPct: Number(entry.pnlPerInflowPct || 0),
    avgAgeHours: Number(entry.avgAgeHours || 0),
    totalLp: Number(entry.totalLp || 0),
    winRatePct: Number(entry.winRatePct || 0),
    firstActivity: entry.firstActivity || null,
    lastActivity: entry.lastActivity || null,
    pool: pool.address,
    poolName: pool.name,
    source,
  };
}

export function normalizeStudyFallback(data, pool) {
  const byOwner = new Map();
  const buckets = [
    data.topWinnersByPct,
    data.topWinnersByUsd,
    data.topHistoricalOwners,
  ];

  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      const owner = String(entry.owner || "").trim();
      if (!owner) continue;
      const current = byOwner.get(owner) || {
        owner,
        ownerShort: shortAddress(owner),
        totalInflowUsd: 0,
        totalFeeUsd: 0,
        totalPnlUsd: 0,
        feePercent: 0,
        pnlPerInflowPct: 0,
        avgAgeHours: 0,
        winRatePct: 0,
        firstActivity: null,
        lastActivity: null,
        preferredStrategy: null,
        preferredRangeStyle: null,
        avgWidthBins: null,
      };
      if (entry.pnlUsd != null) current.totalPnlUsd = Number(entry.pnlUsd);
      if (entry.pnlPct != null) current.pnlPerInflowPct = Number(entry.pnlPct);
      if (entry.avgPnlPct != null) current.pnlPerInflowPct = Number(entry.avgPnlPct);
      if (entry.feePercent != null) current.feePercent = Number(entry.feePercent);
      if (entry.avgFeePercent != null) current.feePercent = Number(entry.avgFeePercent);
      if (entry.winRatePct != null) current.winRatePct = Number(entry.winRatePct);
      if (entry.avgAgeHours != null) current.avgAgeHours = Number(entry.avgAgeHours);
      if (entry.avgHoldHours != null) current.avgAgeHours = Number(entry.avgHoldHours);
      if (entry.preferredStrategy) current.preferredStrategy = entry.preferredStrategy;
      if (entry.preferredRangeStyle) current.preferredRangeStyle = entry.preferredRangeStyle;
      if (entry.avgWidthBins != null) current.avgWidthBins = Number(entry.avgWidthBins);
      byOwner.set(owner, current);
    }
  }

  return {
    lpers: [...byOwner.values()].map((entry) => ({
      ...entry,
      pool: pool.address,
      poolName: pool.name,
      source: "study-top-lp",
    })),
    historicalOwners: [...byOwner.values()].filter(
      (entry) => entry.preferredStrategy || entry.preferredRangeStyle,
    ),
  };
}

export async function fetchPoolLpers(
  pool,
  config,
  cache,
  logger,
  { refresh = false } = {},
) {
  const cacheKey = `toplp:${pool.address}`;
  const ttlMs = config.discovery.cacheTtlMinutes * 60 * 1000;
  if (!refresh) {
    const cached = cache.get(cacheKey, ttlMs);
    if (cached) {
      logger.debug(
        `Using cached LPers for ${pool.name} (${cached.lpers.length})`,
      );
      return cached;
    }
  }

  const base = config.api.agentMeridianBase.replace(/\/+$/, "");
  const headers = config.api.agentMeridianApiKey
    ? { "x-api-key": config.api.agentMeridianApiKey }
    : {};
  const requestOptions = {
    headers,
    timeoutMs: config.api.timeoutMs,
    retries: config.api.retries,
    minIntervalMs: config.api.minIntervalMs,
  };

  let data = null;
  let source = "top-lp";
  let error = null;

  try {
    data = await fetchJson(`${base}/top-lp/${pool.address}`, requestOptions);
  } catch (requestError) {
    error = requestError;
    logger.warn(
      `top-lp failed for ${pool.name} (${pool.address.slice(0, 8)}): ${requestError.message}`,
    );
  }

  let rawLpers = Array.isArray(data?.topLpers) ? data.topLpers : [];
  let historicalOwners = Array.isArray(data?.historicalOwners)
    ? data.historicalOwners
    : [];

  if (rawLpers.length === 0) {
    try {
      const fallback = await fetchJson(`${base}/study-top-lp/${pool.address}`, requestOptions);
      const normalized = normalizeStudyFallback(fallback, pool);
      if (normalized.lpers.length > 0) {
        data = fallback;
        rawLpers = normalized.lpers;
        historicalOwners = normalized.historicalOwners;
        source = "study-top-lp";
        logger.debug(
          `Using study-top-lp fallback for ${pool.name} (${rawLpers.length} owners)`,
        );
      }
    } catch (fallbackError) {
      logger.warn(
        `study-top-lp fallback failed for ${pool.name}: ${fallbackError.message}`,
      );
    }
  }

  const poolRef = {
    address: pool.address,
    name: pool.name,
    discoveryScore: pool.discoveryScore || 0,
  };
  const lpers = rawLpers
    .map((entry) =>
      source === "study-top-lp" && entry.source === "study-top-lp"
        ? { ...entry, pool: pool.address, poolName: pool.name }
        : normalizedLper(entry, poolRef, source),
    )
    .filter((entry) => isSolanaAddress(entry.owner))
    .slice(0, config.discovery.topLpersPerPool);

  const overview = data?.overview || {};
  const result = {
    pool: {
      address: pool.address,
      name: pool.name || overview.name || "UNKNOWN",
      tvl: Number(overview.tvl || pool.tvl || 0),
      volume: Number(pool.volume || 0),
      uniqueLps: pool.uniqueLps,
      positionsCreated: pool.positionsCreated,
      feeActiveTvlRatio: pool.feeActiveTvlRatio,
      ageDays: pool.ageDays,
      discoveryScore: pool.discoveryScore || 0,
    },
    overview,
    lpers,
    historicalOwners,
    source,
    meta: data?.meta || null,
    error: error ? error.message : null,
  };

  if (lpers.length > 0) {
    cache.set(cacheKey, result);
  }
  return result;
}

function activityMs(entry) {
  return parseTimestampMs(entry.lastActivity || entry.firstActivity);
}

export function aggregateCandidates(poolResults, config, options = {}) {
  const { existingAddresses = new Set(), excludeAddresses = new Set() } = options;
  const byAddress = new Map();
  const now = Date.now();

  for (const result of poolResults) {
    if (!result || !Array.isArray(result.lpers)) continue;
    const historicalByOwner = new Map(
      (result.historicalOwners || []).map((entry) => [entry.owner, entry]),
    );

    for (const lper of result.lpers) {
      const address = String(lper.owner || "").trim();
      if (!isSolanaAddress(address)) continue;
      if (KNOWN_PROGRAM_IDS.has(address)) continue;
      if (existingAddresses.has(address)) continue;
      if (excludeAddresses.has(address)) continue;

      let candidate = byAddress.get(address);
      if (!candidate) {
        candidate = {
          address,
          short: shortAddress(address),
          appearances: 0,
          poolMap: new Map(),
          sumInflowUsd: 0,
          sumFeeUsd: 0,
          sumPnlUsd: 0,
          feePercentSum: 0,
          feePercentCount: 0,
          pnlPctSum: 0,
          pnlPctCount: 0,
          winRateSum: 0,
          winRateCount: 0,
          ageHoursSum: 0,
          ageHoursCount: 0,
          firstActivityMs: null,
          lastActivityMs: null,
          sources: new Set(),
          historical: {},
        };
        byAddress.set(address, candidate);
      }

      if (!candidate.poolMap.has(result.pool.address)) {
        candidate.poolMap.set(result.pool.address, {
          address: result.pool.address,
          name: result.pool.name,
          source: lper.source,
          feePercent: Number(lper.feePercent || 0),
          lastActivity: lper.lastActivity || null,
          discoveryScore: result.pool.discoveryScore || 0,
        });
        candidate.appearances += 1;
      }

      candidate.sumInflowUsd += Number(lper.totalInflowUsd || 0);
      candidate.sumFeeUsd += Number(lper.totalFeeUsd || 0);
      candidate.sumPnlUsd += Number(lper.totalPnlUsd || 0);
      candidate.sources.add(lper.source || result.source);

      // Fallback sources (study-top-lp) do not expose inflow. Keep their
      // per-owner percentages so candidates can still be ranked sensibly.
      const feePercent = Number(lper.feePercent);
      if (Number.isFinite(feePercent) && feePercent > 0) {
        candidate.feePercentSum += feePercent;
        candidate.feePercentCount += 1;
      }
      const pnlPct = Number(lper.pnlPerInflowPct);
      if (Number.isFinite(pnlPct)) {
        candidate.pnlPctSum += pnlPct;
        candidate.pnlPctCount += 1;
      }
      const winRatePct = Number(lper.winRatePct);
      if (Number.isFinite(winRatePct) && winRatePct > 0) {
        candidate.winRateSum += winRatePct;
        candidate.winRateCount += 1;
      }
      const ageHours = Number(lper.avgAgeHours);
      if (Number.isFinite(ageHours) && ageHours > 0) {
        candidate.ageHoursSum += ageHours;
        candidate.ageHoursCount += 1;
      }

      const lastMs = activityMs(lper);
      if (lastMs && (!candidate.lastActivityMs || lastMs > candidate.lastActivityMs)) {
        candidate.lastActivityMs = lastMs;
      }
      const firstMs = parseTimestampMs(lper.firstActivity);
      if (firstMs && (!candidate.firstActivityMs || firstMs < candidate.firstActivityMs)) {
        candidate.firstActivityMs = firstMs;
      }

      const historical = historicalByOwner.get(address);
      if (historical) {
        candidate.historical = {
          ...candidate.historical,
          ...(historical.preferredStrategy
            ? { strategy: historical.preferredStrategy }
            : {}),
          ...(historical.preferredRangeStyle
            ? { rangeStyle: historical.preferredRangeStyle }
            : {}),
          ...(historical.avgHoldHours != null
            ? { avgHoldHours: Number(historical.avgHoldHours) }
            : {}),
          ...(historical.avgPnlPct != null
            ? { avgPnlPct: Number(historical.avgPnlPct) }
            : {}),
          ...(historical.avgFeePercent != null
            ? { avgFeePercent: Number(historical.avgFeePercent) }
            : {}),
          ...(historical.avgWidthBins != null
            ? { avgWidthBins: Number(historical.avgWidthBins) }
            : {}),
        };
      }
    }
  }

  const all = [...byAddress.values()].map((candidate) => {
    const pools = [...candidate.poolMap.values()].sort(
      (a, b) => (b.discoveryScore || 0) - (a.discoveryScore || 0),
    );
    const avgFeePercent = candidate.feePercentCount > 0
      ? candidate.feePercentSum / candidate.feePercentCount
      : 0;
    const avgPnlPct = candidate.pnlPctCount > 0
      ? candidate.pnlPctSum / candidate.pnlPctCount
      : 0;
    const avgWinRatePct = candidate.winRateCount > 0
      ? candidate.winRateSum / candidate.winRateCount
      : 0;
    const avgAgeHours = candidate.ageHoursCount > 0
      ? candidate.ageHoursSum / candidate.ageHoursCount
      : 0;

    const feeProxy = candidate.sumInflowUsd > 0
      ? candidate.sumFeeUsd / candidate.sumInflowUsd
      : avgFeePercent / 100;
    const netProxy = candidate.sumInflowUsd > 0
      ? candidate.sumPnlUsd / candidate.sumInflowUsd
      : avgPnlPct / 100;
    const lastActivityDays = candidate.lastActivityMs
      ? daysBetween(candidate.lastActivityMs, now)
      : Number.POSITIVE_INFINITY;

    const feePart = 40 * clamp(feeProxy / 0.15);
    const netPart = 30 * clamp(netProxy / 0.15);
    const multiPart = 20 * clamp((candidate.appearances - 1) / 2);
    const recencyPart = Number.isFinite(lastActivityDays)
      ? recencyScoreDays(lastActivityDays)
      : clamp(avgWinRatePct / 10, 0, 10);
    const prelimScore = round(feePart + netPart + multiPart + recencyPart, 1);

    const prelimReasons = [];
    if (candidate.appearances >= 2) {
      prelimReasons.push(`top LPer in ${candidate.appearances} pools`);
    }
    if (feeProxy > 0.02) prelimReasons.push(`fee proxy ${round(feeProxy * 100, 1)}%`);
    if (netProxy > 0.02) prelimReasons.push(`net proxy ${round(netProxy * 100, 1)}%`);
    if (avgWinRatePct > 0) prelimReasons.push(`win rate ${round(avgWinRatePct, 1)}%`);
    if (lastActivityDays <= 7) prelimReasons.push("active this week");

    return {
      address: candidate.address,
      short: candidate.short,
      appearances: candidate.appearances,
      pools,
      poolAddresses: pools.map((pool) => pool.address),
      sumInflowUsd: candidate.sumInflowUsd,
      sumFeeUsd: candidate.sumFeeUsd,
      sumPnlUsd: candidate.sumPnlUsd,
      topLperFeePercent: round(feeProxy * 100, 2),
      topLperNetRoiPct: round(netProxy * 100, 2),
      topLperWinRatePct: round(avgWinRatePct, 1),
      topLperAvgAgeHours: round(avgAgeHours, 2),
      lastActivity: candidate.lastActivityMs
        ? new Date(candidate.lastActivityMs).toISOString()
        : null,
      firstActivity: candidate.firstActivityMs
        ? new Date(candidate.firstActivityMs).toISOString()
        : null,
      lastActivityDays: Number.isFinite(lastActivityDays)
        ? round(lastActivityDays, 1)
        : null,
      sources: [...candidate.sources],
      historical: candidate.historical,
      prelimScore,
      prelimReasons,
    };
  });

  all.sort((a, b) => {
    if (b.prelimScore !== a.prelimScore) return b.prelimScore - a.prelimScore;
    if (b.appearances !== a.appearances) return b.appearances - a.appearances;
    return b.sumFeeUsd - a.sumFeeUsd;
  });

  const deepCheckTop = Math.max(1, Number(config.discovery.deepCheckTop));
  const selected = all.slice(0, deepCheckTop);
  const selectedSet = new Set(selected.map((candidate) => candidate.address));
  const extraCap = deepCheckTop + 10;

  for (const candidate of all) {
    if (selected.length >= extraCap) break;
    if (candidate.appearances >= 2 && !selectedSet.has(candidate.address)) {
      selected.push(candidate);
      selectedSet.add(candidate.address);
    }
  }

  return {
    selected,
    all,
    meta: {
      candidatesFound: all.length,
      deepCheckSelected: selected.length,
      deepCheckTop,
      multiPoolCandidates: all.filter((candidate) => candidate.appearances >= 2).length,
    },
  };
}
