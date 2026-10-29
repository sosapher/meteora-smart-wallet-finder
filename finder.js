#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./src/config.js";
import { createLogger } from "./src/logger.js";
import { Cache } from "./src/cache.js";
import { discoverPools } from "./src/pools.js";
import { aggregateCandidates, fetchPoolLpers } from "./src/lpers.js";
import {
  deepCheckCandidate,
  loadExistingSmartWallets,
} from "./src/wallets.js";
import { scoreWallet } from "./src/score.js";
import {
  mergeIntoMeridian,
  printCandidates,
  printDetailedReport,
  printPools,
  selectExportCandidates,
  writeExports,
  writeJsonAtomic,
} from "./src/output.js";
import { updateState } from "./src/state.js";
import {
  formatPerformanceReport,
  loadPerformance,
  performanceSummary,
  recordScan,
} from "./src/performance.js";
import { formatCandidateAlert, sendTelegram } from "./src/telegram.js";
import { runBot } from "./src/bot.js";
import {
  annotateSharedFunders,
  fetchWalletHygiene,
  hygieneEnabled,
  printHygieneReport,
} from "./src/hygiene.js";
import { mapLimit } from "./src/http.js";
import { shortAddress } from "./src/util.js";
import { isSolanaAddress } from "./src/lpers.js";

const HELP = `
Meteora Smart Wallet Finder
===========================

Find and score smart LP wallets on Meteora DLMM. Read-only: no private keys,
no transactions, no wallet signing.

USAGE
  node finder.js scan [options]
  node finder.js check <wallet> [options]
  node finder.js pools [options]
  node finder.js export [options]
  node finder.js watch [options]
  node finder.js bot [options]
  node finder.js hygiene <wallet> [options]
  node finder.js perf [options]
  node finder.js config [options]

COMMANDS
  scan              Discover pools, fetch top LPers, deep-check candidates,
                    score them, and write exports.
  check <wallet>    Deep-check one Solana wallet across scanned pools.
  pools             List candidate pools that pass the filters.
  export            Re-write exports from the last scan (Meridian + GMGN). Use
                    --merge to add the results to Meridian's smart-wallets.json
                    (backup made).
  watch             Run scan on an interval, alert on new recommended wallets.
  bot               Start the Telegram control bot (/scan, /stop, /status).
  hygiene <wallet>  Check wallet age, SOL balance, on-chain activity, and
                    funding source using Helius RPC.
  perf              Show how wallets recommended earlier are performing now.
                    Use --days <n> to limit the window.
  config            Print effective config with secrets masked.

OPTIONS
  --pools <n>       Max pools to scan (default: config.pools.limit)
  --top <n>         Max candidates to deep-check (default: discovery.deepCheckTop)
  --min-score <n>   Override export.minScore for this run
  --pool <addr>     Scan specific pool(s), comma-separated (skip discovery)
  --refresh         Ignore cache
  --no-cache        Disable cache for this run
  --no-export       Do not write export files
  --gmgn-only       Re-write only the GMGN files (export command)
  --dry-run         Show what would be exported without writing files
  --merge           Merge exported wallets into Meridian smart-wallets.json
  --allow-partial   Allow low-confidence wallets (n < 5 or incomplete history)
  --json            Print machine-readable JSON
  --interval <min>  Watch interval in minutes (default: watch.intervalMinutes)
  --once            Watch: run a single scan then exit
  --days <n>        Perf: only wallets recommended in the last n days
  --config <path>   Config file (default: ./config.json)
  --verbose         Debug logs
  --help            Show this help

EXAMPLES
  node finder.js scan --pools 20 --top 25
  node finder.js scan --refresh --verbose
  node finder.js check 7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK
  node finder.js export --min-score 80
  node finder.js export --gmgn-only
  node finder.js export --dry-run
  node finder.js export --merge
  node finder.js watch --interval 30
  node finder.js watch --once
  node finder.js bot
  node finder.js hygiene 7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK
  node finder.js perf
  node finder.js perf --days 7

OUTPUT
  data/last-scan.json                  Full scan result
  data/check-<wallet>.json             Single-wallet report
  exports/recommended.json             Meridian-compatible wrapper
  exports/recommended.snippet.json     Plain array for copy/paste
  exports/recommended.md               Human-readable report
  exports/gmgn-follow.json             Full GMGN batch-import array
  exports/gmgn-new.json                Only wallets never exported before
  data/gmgn-exported.json              GMGN export ledger
  data/performance.json                Recommendation follow-up history

NOTES
  Smart wallet history is not a guarantee of future performance. This tool is
  research software, not financial advice. Always verify a wallet manually.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      args._.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = rawKey;
      if (inlineValue !== undefined) {
        args[key] = inlineValue;
      } else if (
        argv[index + 1] &&
        !argv[index + 1].startsWith("-") &&
        argv[index + 1] !== ""
      ) {
        args[key] = argv[index + 1];
        index += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function intArg(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function boolArg(value) {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function buildContext() {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args._[0] || "scan").toLowerCase();

  if (args.help || args.h || command === "help") {
    console.log(HELP.trim());
    process.exit(0);
  }

  const configPath = args.config
    ? path.resolve(process.cwd(), String(args.config))
    : path.join(ROOT, "config.json");
  const config = loadConfig(configPath);
  const logger = createLogger({
    verbose: boolArg(args.verbose),
    logFile: config.paths.logFile,
    quiet: boolArg(args.json),
  });
  const cache = new Cache(config.paths.cacheDir, {
    enabled: !boolArg(args["no-cache"]),
  });

  return { args, command, config, logger, cache, configPath };
}

function makeScanConfig(config, args) {
  const poolLimit = intArg(args.pools, config.pools.limit);
  const deepTop = intArg(args.top, config.discovery.deepCheckTop);
  const minScore = args["min-score"] != null
    ? Number(args["min-score"])
    : null;

  const scanConfig = {
    ...config,
    pools: {
      ...config.pools,
      limit: poolLimit,
    },
    discovery: {
      ...config.discovery,
      deepCheckTop: deepTop,
    },
    export: {
      ...config.export,
      ...(Number.isFinite(minScore) ? { minScore } : {}),
    },
  };
  return scanConfig;
}

function manualPools(args) {
  if (!args.pool) return null;
  const addresses = String(args.pool)
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  if (addresses.length === 0) return null;
  return {
    pools: addresses.map((address) => ({
      address,
      name: "",
      tvl: 0,
      volume: 0,
      uniqueLps: null,
      positionsCreated: null,
      feeActiveTvlRatio: 0,
      ageDays: 0,
      discoveryScore: 0,
    })),
    meta: {
      fetched: addresses.length,
      filtered: addresses.length,
      selected: addresses.length,
      limit: addresses.length,
      manual: true,
      generatedAt: new Date().toISOString(),
    },
  };
}

async function runScan(ctx, { watchMode = false } = {}) {
  const startedAt = Date.now();
  const { config, args, logger, cache } = ctx;
  const scanConfig = makeScanConfig(config, args);
  const refresh = boolArg(args.refresh);
  const concurrency = Math.max(1, Number(scanConfig.discovery.concurrency));
  const progressEvery = Math.max(1, Number(scanConfig.discovery.progressEvery));

  const poolResult =
    manualPools(args) ||
    (await discoverPools(scanConfig, cache, logger, {
      refresh,
      limit: scanConfig.pools.limit,
    }));

  logger.info(
    `Scanning ${poolResult.pools.length} pool(s), timeframe ${scanConfig.pools.timeframe}` +
      (poolResult.cached ? " (cached pool list)" : ""),
  );

  let completedPools = 0;
  const lperResults = await mapLimit(
    poolResult.pools,
    concurrency,
    async (pool) => {
      try {
        const result = await fetchPoolLpers(pool, scanConfig, cache, logger, {
          refresh,
        });
        completedPools += 1;
        if (
          completedPools % progressEvery === 0 ||
          completedPools === poolResult.pools.length
        ) {
          logger.info(
            `Top LPers: ${completedPools}/${poolResult.pools.length} pools processed`,
          );
        }
        return result;
      } catch (error) {
        completedPools += 1;
        logger.warn(
          `Skipping pool ${pool.name || pool.address.slice(0, 8)}: ${error.message}`,
        );
        return null;
      }
    },
  );

  const validLperResults = lperResults.filter(Boolean);
  if (validLperResults.length === 0) {
    logger.warn(
      "No pool returned LPer data. The upstream API may be rate-limited; " +
        "retry later or increase api.minIntervalMs.",
    );
  }
  const existing = loadExistingSmartWallets(
    scanConfig.export.meridianSmartWalletsPath,
    logger,
  );
  const poolAddresses = new Set(poolResult.pools.map((pool) => pool.address));
  const aggregated = aggregateCandidates(validLperResults, scanConfig, {
    existingAddresses: scanConfig.export.excludeExisting
      ? existing.addresses
      : new Set(),
    excludeAddresses: poolAddresses,
  });

  logger.info(
    `Unique candidates: ${aggregated.all.length}; deep-checking ${aggregated.selected.length}`,
  );

  let completedCandidates = 0;
  const scored = await mapLimit(
    aggregated.selected,
    concurrency,
    async (candidate) => {
      try {
        const deep = await deepCheckCandidate(candidate, {
          config: scanConfig,
          cache,
          logger,
          allPools: poolResult.pools,
          refresh,
          maxPools: scanConfig.discovery.maxPoolsPerWallet,
        });
        const score = scoreWallet(deep.metrics, scanConfig, {
          allowLowConfidence: boolArg(args["allow-partial"]),
        });
        completedCandidates += 1;
        if (
          completedCandidates % progressEvery === 0 ||
          completedCandidates === aggregated.selected.length
        ) {
          logger.info(
            `Deep check: ${completedCandidates}/${aggregated.selected.length} wallets scored`,
          );
        }
        return { ...deep, score };
      } catch (error) {
        completedCandidates += 1;
        logger.warn(
          `Deep check failed for ${candidate.short || candidate.address}: ${error.message}`,
        );
        return {
          address: candidate.address,
          short: candidate.short || shortAddress(candidate.address),
          candidate,
          metrics: null,
          open: { totalPositions: 0, pools: [] },
          poolsChecked: [],
          positions: [],
          errors: [{ pool: "deep-check", error: error.message }],
          partial: false,
          score: {
            score: 0,
            tier: "D",
            status: "rejected",
            qualified: false,
            components: {},
            reasons: [],
            warnings: ["deep check failed"],
            rejectionReasons: [error.message],
            gates: [],
          },
        };
      }
    },
  );

  scored.sort((a, b) => {
    const scoreDiff = (b.score?.score || 0) - (a.score?.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.metrics?.n || 0) - (a.metrics?.n || 0);
  });

  if (hygieneEnabled(scanConfig)) {
    annotateSharedFunders(scored, scanConfig);
  }

  const recommended = scored.filter(
    (candidate) => candidate.score?.status === "recommended",
  ).length;
  const watch = scored.filter(
    (candidate) => candidate.score?.status === "watch",
  ).length;

  const result = {
    meta: {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      poolsScanned: poolResult.pools.length,
      candidatesFound: aggregated.all.length,
      deepChecked: scored.length,
      recommended,
      watch,
      rejected: scored.length - recommended - watch,
      multiPoolCandidates: aggregated.meta.multiPoolCandidates,
      poolMeta: poolResult.meta,
      scanConfig: {
        pools: scanConfig.pools.limit,
        deepCheckTop: scanConfig.discovery.deepCheckTop,
        timeframe: scanConfig.pools.timeframe,
        minScore: scanConfig.score.minScore,
      },
    },
    pools: poolResult.pools,
    candidates: scored,
    candidatePool: aggregated.all.slice(0, 100),
  };

  const lastScanPath = path.join(scanConfig.paths.dataDir, "last-scan.json");
  writeJsonAtomic(lastScanPath, result);

  let exportResult = null;
  if (!boolArg(args["no-export"])) {
    exportResult = writeExports(result, scanConfig, logger);
  }

  if (boolArg(args.merge) && exportResult?.wallets?.length) {
    mergeIntoMeridian(exportResult.wallets, scanConfig, logger);
  }

  console.log("");
  logger.info(
    `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ` +
      `${aggregated.all.length} candidates, ${scored.length} deep-checked, ` +
      `${recommended} recommended, ${watch} watch`,
  );
  printCandidates(scored, { limit: 30 });

  const stateResult = updateState(
    path.join(scanConfig.paths.dataDir, "state.json"),
    scored,
    result.meta,
    scanConfig,
  );

  const perfResult = recordScan(scanConfig, result, {
    now: result.meta.generatedAt,
  });
  if (perfResult.added > 0 || perfResult.updated > 0) {
    logger.info(
      `Performance: ${perfResult.added} new recommendation(s), ` +
        `${perfResult.updated} re-measured.`,
    );
  }

  if (watchMode) {
    const shouldAlert =
      (!stateResult.firstRun || scanConfig.watch.alertOnFirstRun) &&
      stateResult.newCandidates.length > 0;
    if (shouldAlert) {
      const alerts = stateResult.newCandidates.filter(
        (candidate) =>
          (candidate.score?.score || 0) >= scanConfig.watch.alertMinScore,
      );
      if (alerts.length > 0) {
        const message = formatCandidateAlert(alerts);
        if (scanConfig.watch.telegram) {
          await sendTelegram(message, scanConfig, logger);
        } else {
          logger.info(
            `New recommended candidates:\n${message.replace(/<[^>]+>/g, "")}`,
          );
        }
      }
    }
  }

  if (exportResult) {
    logger.info(
      `Export: ${exportResult.exported} wallet(s); snippet ${exportResult.paths.snippetPath}`,
    );
  }

  return { result, exportResult, stateResult, scanConfig };
}

function loadLastScan(config, logger) {
  const file = path.join(config.paths.dataDir, "last-scan.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    logger.warn(`Cannot read ${file}: ${error.message}`);
    return null;
  }
}

function candidateFromScan(lastScan, wallet, allPools, config) {
  const found = lastScan?.candidates?.find(
    (candidate) => candidate.address === wallet,
  );
  if (found?.candidate) {
    return { ...found.candidate, address: wallet };
  }
  return {
    address: wallet,
    short: shortAddress(wallet),
    appearances: 0,
    pools: (allPools || [])
      .slice(0, Number(config.discovery.checkMaxPools || 10))
      .map((pool) => ({ address: pool.address, name: pool.name })),
    poolAddresses: [],
    sumInflowUsd: 0,
    sumFeeUsd: 0,
    sumPnlUsd: 0,
    prelimScore: 0,
    prelimReasons: [],
    sources: ["manual"],
    historical: {},
  };
}

async function runCheck(ctx, wallet) {
  const { config, args, logger, cache } = ctx;
  if (!isSolanaAddress(wallet)) {
    throw new Error(`Invalid Solana wallet address: ${wallet}`);
  }

  const refresh = boolArg(args.refresh);
  let lastScan = loadLastScan(config, logger);
  let allPools = lastScan?.pools || [];

  if (allPools.length === 0) {
    const discovered = await discoverPools(config, cache, logger, {
      refresh,
      limit: Number(config.discovery.checkMaxPools || 10),
    });
    allPools = discovered.pools;
  }

  const candidate = candidateFromScan(lastScan, wallet, allPools, config);
  logger.info(
    `Checking ${wallet} across up to ${config.discovery.checkMaxPools} pool(s)...`,
  );

  const deep = await deepCheckCandidate(candidate, {
    config,
    cache,
    logger,
    allPools,
    refresh,
    maxPools: Number(config.discovery.checkMaxPools || 10),
  });
  const score = scoreWallet(deep.metrics, config, {
    allowLowConfidence: boolArg(args["allow-partial"]),
  });
  const result = { ...deep, score };
  const outPath = path.join(
    config.paths.dataDir,
    `check-${shortAddress(wallet).replace(/[^a-zA-Z0-9]/g, "_")}.json`,
  );
  writeJsonAtomic(outPath, result);

  if (boolArg(args.json)) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printDetailedReport(result);
    logger.info(`Report written to ${outPath}`);
  }

  return result;
}

async function runHygiene(ctx, wallet) {
  const { config, args, logger, cache } = ctx;
  if (!isSolanaAddress(wallet)) {
    throw new Error(`Invalid Solana wallet address: ${wallet}`);
  }
  if (!hygieneEnabled(config)) {
    throw new Error(
      "Helius RPC is not configured. Set hygiene.rpcUrl in config.json or " +
        "export HELIUS_RPC_URL.",
    );
  }

  const result = await fetchWalletHygiene(wallet, config, cache, logger, {
    refresh: boolArg(args.refresh),
  });

  if (boolArg(args.json)) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHygieneReport(wallet, result);
  }
  return result;
}

async function runPools(ctx) {
  const { config, args, logger, cache } = ctx;
  const refresh = boolArg(args.refresh);
  const result = await discoverPools(config, cache, logger, {
    refresh,
    limit: intArg(args.pools, config.pools.limit),
  });

  if (boolArg(args.json)) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  console.log("");
  logger.info(
    `Pools: ${result.meta.selected} selected from ${result.meta.filtered} filtered ` +
      `(${result.meta.fetched} fetched, timeframe ${result.meta.timeframe})`,
  );
  printPools(result.pools);
  return result;
}

async function runExport(ctx) {
  const { config, args, logger } = ctx;
  const lastScan = loadLastScan(config, logger);
  if (!lastScan) {
    throw new Error("No last scan found. Run `node finder.js scan` first.");
  }

  const exportConfig = {
    ...config,
    export: {
      ...config.export,
      ...(args["min-score"] != null
        ? { minScore: Number(args["min-score"]) }
        : {}),
    },
  };

  const gmgnOnly = boolArg(args["gmgn-only"]);
  const dryRun = boolArg(args["dry-run"]);
  const merge = boolArg(args.merge);

  if (gmgnOnly && merge) {
    throw new Error("--gmgn-only cannot be combined with --merge.");
  }
  if (dryRun && merge) {
    throw new Error("--dry-run cannot be combined with --merge.");
  }

  const result = writeExports(lastScan, exportConfig, logger, {
    writeMeridian: !gmgnOnly,
    writeGmgn: true,
    dryRun,
  });
  const selected = gmgnOnly
    ? []
    : selectExportCandidates(lastScan.candidates || [], exportConfig);

  if (boolArg(args.json)) {
    console.log(
      JSON.stringify(gmgnOnly ? result.gmgnWallets : result.wallets, null, 2),
    );
  } else {
    if (result.paths.jsonPath && !dryRun) {
      logger.info(
        `Exported ${result.exported} wallet(s) to ${result.paths.jsonPath}`,
      );
    }
    if (result.paths.gmgnPath) {
      logger.info(
        `${dryRun ? "Would write" : "GMGN list:"} ${result.gmgnWallets.length} wallet(s) -> ${result.paths.gmgnPath}`,
      );
    }
    if (result.paths.gmgnNewPath) {
      logger.info(
        `${dryRun ? "Would write" : "GMGN new:"} ${result.gmgnNewWallets.length} new wallet(s) -> ${result.paths.gmgnNewPath}`,
      );
    }
    if (selected.length > 0) {
      printCandidates(selected, { limit: selected.length });
    }
  }

  if (merge) {
    mergeIntoMeridian(result.wallets, exportConfig, logger);
  }

  return result;
}

async function runWatch(ctx) {
  const { config, args, logger } = ctx;
  if (boolArg(args.once)) {
    return runScan(ctx, { watchMode: false });
  }

  const intervalMinutes = Math.max(
    1,
    intArg(args.interval, config.watch.intervalMinutes),
  );
  let stopping = false;
  let wake = null;
  const stopPromise = new Promise((resolve) => {
    wake = resolve;
  });
  const sleepOrStop = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      stopPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  process.on("SIGINT", () => {
    if (stopping) return;
    stopping = true;
    logger.info("SIGINT received; finishing current cycle and stopping...");
    wake?.();
  });
  process.on("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    logger.info("SIGTERM received; finishing current cycle and stopping...");
    wake?.();
  });

  logger.info(
    `Watch mode started: every ${intervalMinutes} minute(s). Ctrl+C to stop.`,
  );

  while (!stopping) {
    try {
      await runScan(ctx, { watchMode: true });
    } catch (error) {
      logger.error(`Watch scan failed: ${error.stack || error.message}`);
    }
    if (stopping) break;
    logger.info(`Sleeping ${intervalMinutes} minute(s)...`);
    await sleepOrStop(intervalMinutes * 60_000);
  }

  logger.info("Watch mode stopped.");
  return null;
}

async function runPerf(ctx) {
  const { config, args, logger } = ctx;
  const perf = loadPerformance(config);
  const days = args.days ? Number(args.days) : null;
  if (args.days && (!Number.isFinite(days) || days <= 0)) {
    throw new Error("--days needs a positive number");
  }

  const summary = performanceSummary(perf, { horizonDays: days });

  if (boolArg(args.json)) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  const report = formatPerformanceReport(summary);
  console.log(report.replace(/<[^>]+>/g, ""));
  logger.info(
    `Performance: ${summary.tracked} tracked, ${summary.evaluated} evaluated, ` +
      `${summary.pending} pending.`,
  );
  return summary;
}

function maskConfig(config) {
  const clone = JSON.parse(JSON.stringify(config));
  if (clone.api?.agentMeridianApiKey) clone.api.agentMeridianApiKey = "***masked***";
  if (clone.telegram?.botToken) clone.telegram.botToken = "***masked***";
  if (clone.telegram?.chatId) clone.telegram.chatId = "***masked***";
  if (clone.hygiene?.rpcUrl) clone.hygiene.rpcUrl = "***masked***";
  return clone;
}

async function runConfig(ctx) {
  const { config, args } = ctx;
  const payload = maskConfig(config);
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

async function main() {
  const ctx = buildContext();
  const { command, args } = ctx;

  switch (command) {
    case "scan":
      await runScan(ctx);
      break;
    case "check": {
      const wallet = args._[1];
      if (!wallet) throw new Error("Usage: node finder.js check <wallet>");
      await runCheck(ctx, wallet);
      break;
    }
    case "pools":
      await runPools(ctx);
      break;
    case "hygiene": {
      const wallet = args._[1];
      if (!wallet) throw new Error("Usage: node finder.js hygiene <wallet>");
      await runHygiene(ctx, wallet);
      break;
    }
    case "export":
      await runExport(ctx);
      break;
    case "watch":
      await runWatch(ctx);
      break;
    case "bot":
      await runBot(ctx);
      break;
    case "perf":
      await runPerf(ctx);
      break;
    case "config":
      await runConfig(ctx);
      break;
    default:
      console.log(HELP.trim());
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`\nERROR: ${error.stack || error.message}`);
  process.exitCode = 1;
});
