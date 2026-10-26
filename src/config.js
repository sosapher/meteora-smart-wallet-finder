import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");

export const DEFAULT_CONFIG = {
  paths: {
    dataDir: "data",
    cacheDir: "data/cache",
    exportDir: "exports",
    logFile: "data/finder.log",
  },
  api: {
    agentMeridianBase: "https://api.agentmeridian.xyz/api",
    agentMeridianApiKey: "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz",
    meteoraDataApi: "https://dlmm.datapi.meteora.ag",
    poolDiscoveryApi: "https://pool-discovery-api.datapi.meteora.ag",
    timeoutMs: 25000,
    retries: 2,
    minIntervalMs: 300,
  },
  pools: {
    timeframe: "24h",
    limit: 20,
    maxPages: 5,
    minTvl: 50000,
    maxTvl: 50000000,
    minVolume: 50000,
    minUniqueLps: 25,
    minPositionsCreated: 50,
    minAgeDays: 3,
    maxAgeDays: 730,
    minFeeActiveTvlRatio: 0.005,
    maxPoolsPerPair: 2,
    excludeStablePairs: true,
    excludePairs: [],
    scoreWeights: {
      tvl: 1,
      volume: 1.5,
      lps: 3,
      positions: 1.5,
      fee: 1,
      age: 3,
    },
  },
  discovery: {
    topLpersPerPool: 20,
    deepCheckTop: 25,
    concurrency: 2,
    cacheTtlMinutes: 30,
    pnlCacheTtlMinutes: 60,
    openCacheTtlMinutes: 10,
    maxPoolsPerWallet: 3,
    checkMaxPools: 10,
    progressEvery: 5,
  },
  metrics: {
    minClosedPositions: 5,
    minPositionDepositUsd: 50,
    minTotalDepositUsd: 500,
    maxPagesPerPool: 2,
    maxDaysSinceActive: 30,
  },
  score: {
    minScore: 75,
    watchMinScore: 62,
    minWinRatePct: 45,
    minFeeYieldPct: 1,
    minNetRoiPct: 0,
    allowLowConfidence: false,
  },
  export: {
    minScore: 75,
    maxWallets: 10,
    namePrefix: "auto",
    category: "smart",
    type: "lp",
    meridianSmartWalletsPath: "../meridian/smart-wallets.json",
    excludeExisting: true,
    writeMarkdown: true,
  },
  watch: {
    intervalMinutes: 30,
    alertMinScore: 80,
    alertScoreDelta: 5,
    alertOnFirstRun: false,
    telegram: false,
  },
  telegram: {
    botToken: "",
    chatId: "",
  },
  hygiene: {
    checkWalletAge: false,
    rpcUrl: "",
    maxSignaturePages: 3,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base)) return override;
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function resolveFromRoot(value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

export function loadConfig(configPath = path.join(ROOT, "config.json")) {
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot parse config file ${configPath}: ${error.message}`);
    }
  }

  const config = deepMerge(DEFAULT_CONFIG, userConfig);

  // Environment overrides. Keep secrets out of config.json when possible.
  if (process.env.AGENT_MERIDIAN_BASE) {
    config.api.agentMeridianBase = process.env.AGENT_MERIDIAN_BASE;
  }
  if (process.env.AGENT_MERIDIAN_API_KEY) {
    config.api.agentMeridianApiKey = process.env.AGENT_MERIDIAN_API_KEY;
  }
  if (process.env.MERIDIAN_SMART_WALLETS) {
    config.export.meridianSmartWalletsPath = process.env.MERIDIAN_SMART_WALLETS;
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
  }
  if (process.env.TELEGRAM_CHAT_ID) {
    config.telegram.chatId = process.env.TELEGRAM_CHAT_ID;
  }
  if (process.env.RPC_URL) {
    config.hygiene.rpcUrl = process.env.RPC_URL;
  }

  config.paths.root = ROOT;
  config.paths.dataDir = resolveFromRoot(config.paths.dataDir);
  config.paths.cacheDir = resolveFromRoot(config.paths.cacheDir);
  config.paths.exportDir = resolveFromRoot(config.paths.exportDir);
  config.paths.logFile = resolveFromRoot(config.paths.logFile);
  config.export.meridianSmartWalletsPath = resolveFromRoot(
    config.export.meridianSmartWalletsPath,
  );

  for (const dir of [
    config.paths.dataDir,
    config.paths.cacheDir,
    config.paths.exportDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const numbers = [
    ["pools.limit", config.pools.limit, 1, 500],
    ["pools.maxPages", config.pools.maxPages, 1, 50],
    ["pools.minTvl", config.pools.minTvl, 0, Infinity],
    ["discovery.deepCheckTop", config.discovery.deepCheckTop, 1, 500],
    ["discovery.concurrency", config.discovery.concurrency, 1, 20],
    ["metrics.minClosedPositions", config.metrics.minClosedPositions, 1, 1000],
    ["metrics.maxPagesPerPool", config.metrics.maxPagesPerPool, 1, 20],
    ["score.minScore", config.score.minScore, 0, 100],
    ["export.minScore", config.export.minScore, 0, 100],
  ];
  for (const [name, value, min, max] of numbers) {
    if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new Error(`Invalid config ${name}: ${value} (expected ${min}..${max})`);
    }
  }
  if (!["5m", "30m", "1h", "2h", "4h", "12h", "24h"].includes(config.pools.timeframe)) {
    throw new Error(`Invalid pools.timeframe: ${config.pools.timeframe}`);
  }
}
