import { fetchJson } from "./http.js";

const STABLE_SYMBOLS = new Set([
  "USDC",
  "USDT",
  "USDG",
  "PYUSD",
  "FDUSD",
  "DAI",
  "USDS",
  "USDE",
  "UST",
  "USDH",
  "EURC",
]);

export function asNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function ageDaysFromTimestamp(timestamp, now = Date.now()) {
  const value = asNumber(timestamp, 0);
  if (value <= 0) return Number.POSITIVE_INFINITY;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return Math.max(0, (now - milliseconds) / 86_400_000);
}

export function splitPair(name) {
  const parts = String(name || "").split("-");
  if (parts.length < 2) return { base: parts[0] || "", quote: "" };
  return { base: parts[0], quote: parts.slice(1).join("-") };
}

export function isStablePair(name) {
  const { base, quote } = splitPair(name);
  return STABLE_SYMBOLS.has(base.toUpperCase()) && STABLE_SYMBOLS.has(quote.toUpperCase());
}

export function scorePool(pool, weights) {
  const w = {
    tvl: 1,
    volume: 1.5,
    lps: 3,
    positions: 1.5,
    fee: 1,
    age: 3,
    ...weights,
  };
  const fee = Math.min(asNumber(pool.feeActiveTvlRatio), 5);
  const ageFactor = Math.min(asNumber(pool.ageDays), 30) / 30;
  return (
    w.tvl * Math.log10(Math.max(asNumber(pool.tvl), 1)) +
    w.volume * Math.log10(Math.max(asNumber(pool.volume), 1)) +
    w.lps * Math.log10(Math.max(asNumber(pool.uniqueLps), 1)) +
    w.positions * Math.log10(Math.max(asNumber(pool.positionsCreated), 1)) +
    w.fee * fee +
    w.age * ageFactor
  );
}

function normalizePool(raw, now) {
  const name = String(raw.name || raw.pool_name || "").trim();
  const { base, quote } = splitPair(name);
  return {
    address: String(raw.pool_address || raw.address || ""),
    name: name || "UNKNOWN",
    baseSymbol: base,
    quoteSymbol: quote,
    tvl: asNumber(raw.tvl ?? raw.active_tvl),
    activeTvl: asNumber(raw.active_tvl ?? raw.tvl),
    volume: asNumber(raw.volume),
    uniqueLps: raw.unique_lps == null ? null : asNumber(raw.unique_lps),
    positionsCreated:
      raw.positions_created == null ? null : asNumber(raw.positions_created),
    openPositions: raw.open_positions == null ? null : asNumber(raw.open_positions),
    feeActiveTvlRatio: asNumber(
      raw.fee_active_tvl_ratio ?? raw.fee_tvl_ratio,
    ),
    feePct: asNumber(raw.fee_pct ?? raw.dynamic_fee_pct),
    createdAt: asNumber(raw.pool_created_at ?? raw.created_at),
    ageDays: ageDaysFromTimestamp(raw.pool_created_at ?? raw.created_at, now),
    isBlacklisted: Boolean(raw.is_blacklisted),
    stablePair: isStablePair(name),
    rawTimeframe: raw.__timeframe || null,
  };
}

export function filterPools(rawPools, config, { limit = null, now = Date.now() } = {}) {
  const cfg = config.pools;
  const maxPools = Math.max(1, Number(limit || cfg.limit));
  const excludePairs = new Set(
    (cfg.excludePairs || []).map((pair) => String(pair).toUpperCase()),
  );

  const normalized = rawPools
    .map((pool) => normalizePool(pool, now))
    .filter((pool) => pool.address && pool.name !== "UNKNOWN")
    .filter((pool) => !pool.isBlacklisted)
    .filter((pool) => pool.tvl >= asNumber(cfg.minTvl))
    .filter((pool) => pool.tvl <= asNumber(cfg.maxTvl, Number.POSITIVE_INFINITY))
    .filter((pool) => pool.volume >= asNumber(cfg.minVolume))
    .filter(
      (pool) =>
        pool.uniqueLps == null || pool.uniqueLps >= asNumber(cfg.minUniqueLps),
    )
    .filter(
      (pool) =>
        pool.positionsCreated == null ||
        pool.positionsCreated >= asNumber(cfg.minPositionsCreated),
    )
    .filter((pool) => pool.ageDays >= asNumber(cfg.minAgeDays))
    .filter((pool) => pool.ageDays <= asNumber(cfg.maxAgeDays, Number.POSITIVE_INFINITY))
    .filter(
      (pool) =>
        pool.feeActiveTvlRatio >= asNumber(cfg.minFeeActiveTvlRatio),
    )
    .filter((pool) => !(cfg.excludeStablePairs && pool.stablePair))
    .filter((pool) => !excludePairs.has(pool.name.toUpperCase()));

  for (const pool of normalized) {
    pool.discoveryScore = scorePool(pool, cfg.scoreWeights);
  }

  const sorted = normalized.sort((a, b) => b.discoveryScore - a.discoveryScore);
  const pairCounts = new Map();
  const selected = [];

  for (const pool of sorted) {
    const pair = pool.name.toUpperCase();
    const count = pairCounts.get(pair) || 0;
    if (count >= asNumber(cfg.maxPoolsPerPair, 1)) continue;
    pairCounts.set(pair, count + 1);
    selected.push(pool);
    if (selected.length >= maxPools) break;
  }

  return {
    pools: selected,
    meta: {
      fetched: rawPools.length,
      filtered: normalized.length,
      selected: selected.length,
      limit: maxPools,
    },
  };
}

async function fetchDiscoveryPages(config, logger, { maxPages }) {
  const cfg = config.pools;
  const base = config.api.poolDiscoveryApi.replace(/\/+$/, "");
  const pools = [];
  let afterKey = null;
  let pages = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      page_size: "100",
      timeframe: cfg.timeframe,
    });
    if (asNumber(cfg.minTvl) > 0) {
      params.set("filter_by", `tvl>${asNumber(cfg.minTvl)}`);
    }
    if (afterKey) params.set("after_key", afterKey);

    const data = await fetchJson(`${base}/pools?${params.toString()}`, {
      timeoutMs: config.api.timeoutMs,
      retries: config.api.retries,
      minIntervalMs: config.api.minIntervalMs,
    });

    const batch = Array.isArray(data.data) ? data.data : [];
    for (const pool of batch) {
      pool.__timeframe = cfg.timeframe;
      pools.push(pool);
    }
    pages += 1;
    logger.debug(
      `Pool discovery page ${page + 1}: ${batch.length} pools (total ${pools.length})`,
    );

    afterKey = data.after_key || null;
    if (!data.has_more || !afterKey || batch.length === 0) break;
  }

  return { pools, pages };
}

async function fetchBasicPools(config, logger, { maxPages = 2 } = {}) {
  const base = config.api.meteoraDataApi.replace(/\/+$/, "");
  const pools = [];
  let pages = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      page_size: "100",
      page: String(page),
      sort_by: "tvl:desc",
    });
    const data = await fetchJson(`${base}/pools?${params.toString()}`, {
      timeoutMs: config.api.timeoutMs,
      retries: config.api.retries,
      minIntervalMs: config.api.minIntervalMs,
    });
    const batch = Array.isArray(data.data) ? data.data : [];
    pools.push(...batch);
    pages += 1;
    if (!data.pages || page >= Number(data.pages)) break;
  }

  logger.warn(
    `Pool discovery API failed; using ${pools.length} basic pools from Meteora data API.`,
  );
  return { pools, pages, fallback: true };
}

export async function discoverPools(
  config,
  cache,
  logger,
  { refresh = false, limit = null } = {},
) {
  const maxPools = Math.max(1, Number(limit || config.pools.limit));
  const cacheKey = [
    "pools",
    config.pools.timeframe,
    config.pools.minTvl,
    config.pools.maxTvl,
    config.pools.minVolume,
    config.pools.minUniqueLps,
    config.pools.minPositionsCreated,
    config.pools.minAgeDays,
    config.pools.maxAgeDays,
    config.pools.minFeeActiveTvlRatio,
    config.pools.maxPoolsPerPair,
    config.pools.excludeStablePairs,
    (config.pools.excludePairs || []).join(","),
    JSON.stringify(config.pools.scoreWeights || {}),
    maxPools,
  ].join(":");

  if (!refresh) {
    const cached = cache.get(cacheKey, 15 * 60 * 1000);
    if (cached) {
      logger.debug(`Using cached pool list (${cached.pools.length} pools)`);
      return { ...cached, cached: true };
    }
  }

  let raw;
  let pages = 0;
  let fallback = false;
  try {
    const result = await fetchDiscoveryPages(config, logger, {
      maxPages: config.pools.maxPages,
    });
    raw = result.pools;
    pages = result.pages;
    if (raw.length === 0) {
      throw new Error("Discovery API returned no pools");
    }
  } catch (error) {
    logger.warn(`Discovery API error: ${error.message}`);
    const result = await fetchBasicPools(config, logger, { maxPages: 2 });
    raw = result.pools;
    pages = result.pages;
    fallback = true;
  }

  const filtered = filterPools(raw, config, { limit: maxPools });
  const result = {
    pools: filtered.pools,
    meta: {
      ...filtered.meta,
      pages,
      timeframe: config.pools.timeframe,
      fallback,
      generatedAt: new Date().toISOString(),
    },
  };

  if (result.pools.length === 0) {
    throw new Error(
      "No pools matched the filters. Lower pools.minTvl / pools.minVolume / " +
        "pools.minUniqueLps / pools.minAgeDays in config.json, then retry.",
    );
  }

  cache.set(cacheKey, result);
  return result;
}
