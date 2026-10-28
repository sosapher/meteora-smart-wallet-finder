import fs from "node:fs";
import path from "node:path";
import { loadExistingSmartWallets } from "./wallets.js";
import { round, shortAddress } from "./util.js";

function truncate(value, width) {
  const text = String(value ?? "");
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

export function printTable(headers, rows, widths) {
  const resolvedWidths = headers.map((header, index) => {
    const configured = widths?.[index];
    if (configured) return configured;
    const maxCell = Math.max(
      String(header).length,
      ...rows.map((row) => String(row[index] ?? "").length),
    );
    return Math.min(maxCell, 40);
  });

  const formatRow = (cells) =>
    cells
      .map((cell, index) => truncate(cell, resolvedWidths[index]).padEnd(resolvedWidths[index]))
      .join("  ")
      .trimEnd();

  console.log(formatRow(headers));
  console.log(resolvedWidths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(formatRow(row));
}

function pct(value) {
  if (!Number.isFinite(value)) return "-";
  return `${round(value, 1)}%`;
}

function num(value) {
  if (!Number.isFinite(value)) return "-";
  return String(round(value, 1));
}

function lastSeen(metrics) {
  if (metrics.openPositions > 0) return "now";
  if (!Number.isFinite(metrics.daysSinceActive)) return "-";
  return `${round(metrics.daysSinceActive, 0)}d`;
}

export function printCandidates(candidates, { limit = 30 } = {}) {
  const rows = candidates.slice(0, limit).map((candidate, index) => {
    const metrics = candidate.metrics || {};
    const score = candidate.score || {};
    const flags = (metrics.flags || []).slice(0, 2).join(",");
    return [
      String(index + 1),
      score.score ?? "-",
      score.tier ?? "-",
      score.status ?? "-",
      candidate.short || shortAddress(candidate.address),
      metrics.n ?? "-",
      pct(metrics.winRatePct),
      pct(metrics.feeYieldPct),
      pct(metrics.netRoiPct),
      num(metrics.profitFactor),
      metrics.avgHoldHours ? `${round(metrics.avgHoldHours, 1)}h` : "-",
      metrics.medianWidthBins ? String(round(metrics.medianWidthBins, 0)) : "-",
      metrics.poolCount ?? "-",
      lastSeen(metrics),
      flags || "-",
    ];
  });

  printTable(
    [
      "#",
      "Score",
      "Tier",
      "Status",
      "Wallet",
      "Closed",
      "Win%",
      "Fee%",
      "ROI%",
      "PF",
      "Hold",
      "Width",
      "Pools",
      "Last",
      "Flags",
    ],
    rows,
    [4, 6, 5, 11, 16, 7, 6, 6, 6, 5, 7, 6, 6, 6, 28],
  );
}

export function printPools(pools) {
  const rows = pools.map((pool, index) => [
    String(index + 1),
    pool.name,
    pool.address,
    String(Math.round(pool.tvl)),
    String(Math.round(pool.volume)),
    pool.uniqueLps == null ? "-" : String(Math.round(pool.uniqueLps)),
    pool.positionsCreated == null ? "-" : String(Math.round(pool.positionsCreated)),
    pool.ageDays === Infinity ? "-" : String(Math.round(pool.ageDays)),
    `${round(pool.feeActiveTvlRatio, 3)}`,
    round(pool.discoveryScore, 1),
  ]);

  printTable(
    ["#", "Pool", "Address", "TVL", "Vol24h", "LPs", "Pos", "AgeD", "Fee/TVL", "Score"],
    rows,
    [4, 22, 46, 10, 11, 6, 7, 6, 8, 7],
  );
}

export function printDetailedReport(result) {
  const { candidate, metrics, score, open, poolsChecked, errors } = result;
  console.log("");
  console.log(`Wallet      : ${candidate.address}`);
  console.log(`Short       : ${candidate.short || shortAddress(candidate.address)}`);
  console.log(`Score/Tier  : ${score.score} / ${score.tier} (${score.status})`);
  console.log(`Qualified   : ${score.qualified ? "yes" : "no"}`);
  console.log(
    `Open        : ${open.totalPositions} position(s) in ${open.pools.length} pool(s)`,
  );
  console.log(`Pools check : ${poolsChecked.length}`);
  if (errors?.length) console.log(`Errors      : ${errors.length}`);

  console.log("");
  console.log("Metrics");
  console.log("-------");
  const metricRows = [
    ["Closed positions", metrics.n],
    ["Win rate", pct(metrics.winRatePct)],
    ["Total deposits", `$${metrics.totalDepositUsd}`],
    ["Total fees", `$${metrics.totalFeesUsd}`],
    ["Net PnL", `$${metrics.totalPnlUsd}`],
    ["Price PnL", `$${metrics.pricePnlUsd}`],
    ["Fee yield", pct(metrics.feeYieldPct)],
    ["Net ROI", pct(metrics.netRoiPct)],
    ["Fee share", pct(metrics.feeSharePct)],
    ["Profit factor", metrics.profitFactor],
    ["Avg hold", `${metrics.avgHoldHours}h`],
    ["Median hold", `${metrics.medianHoldHours}h`],
    ["Median range", `${metrics.medianWidthBins} bins`],
    ["Avg deposit", `$${metrics.avgDepositUsd}`],
    ["Outlier share", pct(metrics.outlierSharePct)],
    ["Pools", metrics.poolCount],
    ["Active days", metrics.activeDays],
    ["Last activity", metrics.daysSinceActive == null ? "-" : `${metrics.daysSinceActive}d ago`],
    ["Confidence", metrics.confidence],
    ...(metrics.hygiene?.enabled
      ? [
          [
            "Wallet age",
            metrics.hygiene.walletAgeDays == null
              ? "-"
              : `${metrics.hygiene.walletAgeDays}d${metrics.hygiene.ageCapped ? "+" : ""}`,
          ],
          [
            "On-chain last",
            metrics.hygiene.daysSinceLastSignature == null
              ? "-"
              : `${metrics.hygiene.daysSinceLastSignature}d ago`,
          ],
          [
            "SOL balance",
            metrics.hygiene.solBalance == null ? "-" : metrics.hygiene.solBalance,
          ],
          [
            "Funder",
            metrics.hygiene.funder
              ? `${shortAddress(metrics.hygiene.funder)} (${metrics.hygiene.funderType})`
              : "-",
          ],
        ]
      : []),
  ];
  for (const [label, value] of metricRows) {
    console.log(`  ${String(label).padEnd(18)} ${value}`);
  }

  console.log("");
  console.log("Score components");
  console.log("----------------");
  for (const [name, value] of Object.entries(score.components)) {
    console.log(`  ${String(name).padEnd(18)} ${value}`);
  }

  if (metrics.poolBreakdown?.length) {
    console.log("");
    console.log("Pool breakdown");
    console.log("--------------");
    printTable(
      ["Pool", "Pos", "Deposit", "Fees", "PnL", "Win%", "Hold", "Width"],
      metrics.poolBreakdown.map((pool) => [
        shortAddress(pool.pool, 6),
        String(pool.positions),
        `$${pool.depositUsd}`,
        `$${pool.feesUsd}`,
        `$${pool.pnlUsd}`,
        pct(pool.winRatePct),
        `${pool.avgHoldHours}h`,
        `${pool.medianWidthBins}`,
      ]),
      [16, 5, 10, 8, 8, 6, 7, 6],
    );
  }

  if (metrics.recentPositions?.length) {
    console.log("");
    console.log("Recent closed positions");
    console.log("-----------------------");
    printTable(
      ["Position", "Pool", "Deposit", "Fees", "PnL", "PnL%", "Hold", "Width"],
      metrics.recentPositions.map((position) => [
        shortAddress(position.position, 6),
        shortAddress(position.pool, 6),
        `$${position.depositUsd}`,
        `$${position.feeUsd}`,
        `$${position.pnlUsd}`,
        `${position.pnlPct}%`,
        `${position.holdHours}h`,
        position.widthBins ?? "-",
      ]),
      [16, 16, 9, 8, 9, 8, 7, 6],
    );
  }

  console.log("");
  console.log("Reasons");
  console.log("-------");
  console.log(`  ${score.reasons.join(", ") || "-"}`);
  if (score.warnings.length) {
    console.log("");
    console.log("Warnings");
    console.log("--------");
    console.log(`  ${score.warnings.join(", ")}`);
  }
  if (score.rejectionReasons.length) {
    console.log("");
    console.log("Failed gates");
    console.log("------------");
    for (const reason of score.rejectionReasons) console.log(`  - ${reason}`);
  }
}

export const GMGN_MAX_WALLETS = 2000;

export const GMGN_TIER_EMOJI = Object.freeze({
  S: "🔥",
  A: "⭐",
  B: "👀",
  C: "🧐",
  D: "💤",
  default: "👀",
});

export function gmgnEnabled(config) {
  return config.export?.gmgn?.enabled !== false;
}

function gmgnSettings(config) {
  return config.export?.gmgn || {};
}

function gmgnName(candidate, config) {
  const prefix = gmgnSettings(config).namePrefix || "meteora";
  return `${prefix}-${candidate.address.slice(0, 6)}`;
}

/**
 * Select the GMGN list independently from Meridian. This lets the GMGN file
 * hold more wallets than the small Meridian list without changing Meridian's
 * `export.maxWallets`.
 */
export function selectGmgnCandidates(candidates, config) {
  const settings = gmgnSettings(config);
  const minScore = Number(
    settings.minScore ?? config.export?.minScore ?? config.score?.minScore ?? 0,
  );
  const configured = Number(settings.maxWallets ?? GMGN_MAX_WALLETS);
  const limit = Math.min(
    GMGN_MAX_WALLETS,
    Math.max(
      1,
      Number.isFinite(configured)
        ? Math.floor(configured)
        : GMGN_MAX_WALLETS,
    ),
  );

  return candidates
    .filter((candidate) => candidate.score?.status === "recommended")
    .filter((candidate) => Number(candidate.score?.score || 0) >= minScore)
    .sort((a, b) => (b.score?.score || 0) - (a.score?.score || 0))
    .slice(0, limit);
}

/**
 * Build the array GMGN expects when batch-importing followed wallets:
 * [{ address, name, emoji }]. GMGN accepts at most 2,000 addresses and the
 * names must be unique inside one import. Names are address-based so they stay
 * stable while scores change; the emoji carries the current tier.
 */
export function buildGmgnPayload(
  candidates,
  config,
  { namesByAddress = {} } = {},
) {
  const usedNames = new Set();
  return candidates.map((candidate) => {
    const savedName = namesByAddress[candidate.address];
    let name = savedName || gmgnName(candidate, config);
    if (!savedName) {
      const base = name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${base}-${suffix}`;
        suffix += 1;
      }
    }
    usedNames.add(name);

    const tier = String(candidate.score?.tier || "").toUpperCase();
    return {
      address: candidate.address,
      name,
      emoji: GMGN_TIER_EMOJI[tier] || GMGN_TIER_EMOJI.default,
    };
  });
}

export function gmgnLedgerPath(config) {
  const fileName = gmgnSettings(config).stateFile || "gmgn-exported.json";
  return path.join(config.paths.dataDir, fileName);
}

export function loadGmgnLedger(filePath) {
  const empty = { version: 1, updatedAt: null, wallets: {} };
  if (!filePath || !fs.existsSync(filePath)) return empty;
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const hasWallets =
      payload?.wallets &&
      typeof payload.wallets === "object" &&
      !Array.isArray(payload.wallets);
    const wallets = hasWallets ? payload.wallets : {};
    return {
      version: payload?.version || 1,
      updatedAt: payload?.updatedAt || null,
      wallets,
    };
  } catch {
    return empty;
  }
}

/**
 * Write the full GMGN list and, when incremental mode is on, a second file that
 * contains only addresses never exported before. The ledger keeps names stable
 * and lets repeated scans produce small importable diffs.
 */
export function writeGmgnExport(
  candidates,
  config,
  { dryRun = false, logger = null } = {},
) {
  const settings = gmgnSettings(config);
  const selected = selectGmgnCandidates(candidates, config);
  const ledgerPath = gmgnLedgerPath(config);
  const ledger = loadGmgnLedger(ledgerPath);
  const namesByAddress = Object.fromEntries(
    Object.entries(ledger.wallets)
      .map(([address, entry]) => [address, entry?.name])
      .filter(([, name]) => Boolean(name)),
  );

  const wallets = buildGmgnPayload(selected, config, { namesByAddress });
  const incremental = settings.incremental !== false;
  const newWallets = incremental
    ? wallets.filter((wallet) => !Object.hasOwn(ledger.wallets, wallet.address))
    : [];

  const gmgnPath = path.join(
    config.paths.exportDir,
    settings.fileName || "gmgn-follow.json",
  );
  const newPath = incremental
    ? path.join(
        config.paths.exportDir,
        settings.newFileName || "gmgn-new.json",
      )
    : null;

  if (!dryRun) {
    writeJsonAtomic(gmgnPath, wallets);
    if (newPath) writeJsonAtomic(newPath, newWallets);

    if (incremental) {
      const now = new Date().toISOString();
      const candidateByAddress = new Map(
        selected.map((candidate) => [candidate.address, candidate]),
      );

      for (const wallet of wallets) {
        const previous = ledger.wallets[wallet.address];
        const candidate = candidateByAddress.get(wallet.address);
        ledger.wallets[wallet.address] = {
          name: wallet.name,
          emoji: wallet.emoji,
          firstExportedAt: previous?.firstExportedAt || now,
          lastExportedAt: now,
          score: candidate?.score?.score ?? null,
          tier: candidate?.score?.tier ?? null,
        };
      }

      ledger.updatedAt = now;
      writeJsonAtomic(ledgerPath, ledger);
    }
  }

  logger?.debug?.(
    `GMGN export: ${wallets.length} wallet(s), ${newWallets.length} new` +
      (dryRun ? " (dry run)" : ""),
  );

  return {
    wallets,
    newWallets,
    gmgnPath,
    newPath,
    ledgerPath: incremental ? ledgerPath : null,
  };
}

export function toMeridianEntry(candidate, config, existingNames = new Set()) {
  const prefix = config.export.namePrefix || "auto";
  const base = `${prefix}-${candidate.address.slice(0, 6)}`;
  let name = base;
  let suffix = 2;
  while (existingNames.has(name)) {
    name = `${base}-${suffix}`;
    suffix += 1;
  }
  return {
    name,
    address: candidate.address,
    category: config.export.category || "smart",
    type: config.export.type || "lp",
    addedAt: new Date().toISOString(),
  };
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function selectExportCandidates(candidates, config) {
  const minScore = Number(config.export.minScore || config.score.minScore || 0);
  return candidates
    .filter((candidate) => candidate.score?.status === "recommended")
    .filter((candidate) => candidate.score?.score >= minScore)
    .sort((a, b) => b.score.score - a.score.score)
    .slice(0, Math.max(1, Number(config.export.maxWallets || 10)));
}

export function buildExportPayload(candidates, config, existing = null) {
  const existingWallets = existing?.wallets || [];
  const existingNames = new Set(
    existingWallets.map((wallet) => String(wallet.name || "")).filter(Boolean),
  );
  const existingAddresses = new Set(
    existingWallets.map((wallet) => String(wallet.address || "")).filter(Boolean),
  );

  const filtered = candidates.filter(
    (candidate) =>
      !config.export.excludeExisting || !existingAddresses.has(candidate.address),
  );

  const wallets = filtered.map((candidate) =>
    toMeridianEntry(candidate, config, existingNames),
  );
  wallets.forEach((wallet) => existingNames.add(wallet.name));

  const detailed = filtered.map((candidate, index) => ({
    ...wallets[index],
    _meta: {
      score: candidate.score.score,
      tier: candidate.score.tier,
      closedPositions: candidate.metrics.n,
      winRatePct: candidate.metrics.winRatePct,
      feeYieldPct: candidate.metrics.feeYieldPct,
      netRoiPct: candidate.metrics.netRoiPct,
      profitFactor: candidate.metrics.profitFactor,
      avgHoldHours: candidate.metrics.avgHoldHours,
      medianWidthBins: candidate.metrics.medianWidthBins,
      poolCount: candidate.metrics.poolCount,
      daysSinceActive: candidate.metrics.daysSinceActive,
      walletAgeDays: candidate.metrics.hygiene?.walletAgeDays ?? null,
      solBalance: candidate.metrics.hygiene?.solBalance ?? null,
      funder: candidate.metrics.hygiene?.funder ?? null,
      funderType: candidate.metrics.hygiene?.funderType ?? null,
      sharedFunderCount:
        candidate.metrics.hygiene?.sharedFunderCount ?? null,
      warnings: candidate.score.warnings,
    },
  }));

  return { wallets, detailed };
}

function markdownTable(candidates) {
  const header =
    "| # | Wallet | Score | Tier | Closed | Win% | Fee yield | Net ROI | PF | Hold | Width | Pools | Last | Age | SOL |\n" +
    "|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|";
  const rows = candidates.map((candidate, index) => {
    const metrics = candidate.metrics;
    const hygiene = metrics.hygiene;
    return `| ${index + 1} | \`${candidate.address}\` | ${candidate.score.score} | ${
      candidate.score.tier
    } | ${metrics.n} | ${metrics.winRatePct}% | ${metrics.feeYieldPct}% | ${
      metrics.netRoiPct
    }% | ${metrics.profitFactor} | ${metrics.avgHoldHours}h | ${
      metrics.medianWidthBins
    } | ${metrics.poolCount} | ${
      metrics.openPositions > 0 ? "now" : `${metrics.daysSinceActive ?? "-"}d`
    } | ${
      hygiene?.walletAgeDays == null
        ? "-"
        : `${hygiene.walletAgeDays}${hygiene.ageCapped ? "+" : ""}d`
    } | ${hygiene?.solBalance ?? "-"} |`;
  });
  return [header, ...rows].join("\n");
}

export function writeExports(
  scanResult,
  config,
  logger = null,
  { writeMeridian = true, writeGmgn = true, dryRun = false } = {},
) {
  const candidates = scanResult.candidates || [];
  const generatedAt = new Date().toISOString();
  const selected = writeMeridian
    ? selectExportCandidates(candidates, config)
    : [];
  let wallets = [];
  let detailed = [];

  const jsonPath = path.join(config.paths.exportDir, "recommended.json");
  const snippetPath = path.join(
    config.paths.exportDir,
    "recommended.snippet.json",
  );
  const markdownPath = path.join(config.paths.exportDir, "recommended.md");

  if (writeMeridian) {
    const existing = loadExistingSmartWallets(
      config.export.meridianSmartWalletsPath,
      logger,
    );
    ({ wallets, detailed } = buildExportPayload(selected, config, existing));

    const payload = {
      generatedAt,
      source: "meteora-smart-wallet-finder",
      criteria: {
        minScore: config.export.minScore,
        maxWallets: config.export.maxWallets,
        minClosedPositions: config.metrics.minClosedPositions,
        minWinRatePct: config.score.minWinRatePct,
        minFeeYieldPct: config.score.minFeeYieldPct,
        minNetRoiPct: config.score.minNetRoiPct,
      },
      walletCount: wallets.length,
      wallets: detailed,
    };

    if (!dryRun) {
      writeJsonAtomic(jsonPath, payload);
      writeJsonAtomic(snippetPath, wallets);
    }
  }

  const gmgn =
    writeGmgn && gmgnEnabled(config)
      ? writeGmgnExport(candidates, config, { dryRun, logger })
      : {
          wallets: [],
          newWallets: [],
          gmgnPath: null,
          newPath: null,
          ledgerPath: null,
        };

  if (writeMeridian && config.export.writeMarkdown) {
    const snippet = JSON.stringify(wallets, null, 2);
    const markdown = [
      "# Recommended Meteora smart wallets",
      "",
      `Generated: ${generatedAt}`,
      "",
      `Criteria: score >= ${config.export.minScore}, >= ${config.metrics.minClosedPositions} closed positions, win rate >= ${config.score.minWinRatePct}%, fee yield >= ${config.score.minFeeYieldPct}%, net ROI >= ${config.score.minNetRoiPct}%.`,
      "",
      "> Read-only research, not financial advice. Smart wallet history does not guarantee future performance. Verify each wallet manually before adding it.",
      "",
      "## Candidates",
      "",
      selected.length > 0 ? markdownTable(selected) : "_No candidates matched the export criteria._",
      "",
      "## Meridian snippet",
      "",
      "```json",
      snippet,
      "```",
      "",
      "To add manually, merge these objects into the `wallets` array of",
      "`/home/ubuntu/meridian/smart-wallets.json`, or run:",
      "",
      "```bash",
      "node finder.js export --merge",
      "```",
      "",
      ...(gmgn.gmgnPath
        ? [
            "## GMGN import",
            "",
            `\`${gmgn.gmgnPath}\` contains ${gmgn.wallets.length} wallet(s) in GMGN's`,
            "batch-import format. Import it at https://gmgn.ai/follow -> Batch import.",
            gmgn.newPath
              ? `\`${gmgn.newPath}\` contains only the ${gmgn.newWallets.length} wallet(s) not exported before.`
              : "",
            "GMGN accepts at most 2,000 addresses per import.",
            "",
          ]
        : []),
    ].join("\n");
    if (!dryRun) fs.writeFileSync(markdownPath, markdown, "utf8");
  }

  const summary = [];
  if (writeMeridian) {
    summary.push(`${wallets.length} Meridian wallet(s) -> ${jsonPath}`);
  }
  if (gmgn.gmgnPath) {
    summary.push(
      `${gmgn.wallets.length} GMGN wallet(s) -> ${gmgn.gmgnPath}` +
        (gmgn.newPath ? ` (${gmgn.newWallets.length} new)` : ""),
    );
  }
  if (summary.length > 0) {
    logger?.info(
      `${dryRun ? "Dry run: would write" : "Exports written:"} ${summary.join("; ")}`,
    );
  }

  return {
    exported: wallets.length,
    wallets,
    detailed,
    gmgnWallets: gmgn.wallets,
    gmgnNewWallets: gmgn.newWallets,
    dryRun,
    paths: {
      jsonPath: writeMeridian ? jsonPath : null,
      snippetPath: writeMeridian ? snippetPath : null,
      markdownPath:
        writeMeridian && config.export.writeMarkdown ? markdownPath : null,
      gmgnPath: gmgn.gmgnPath,
      gmgnNewPath: gmgn.newPath,
      gmgnLedgerPath: gmgn.ledgerPath,
    },
  };
}

export function mergeIntoMeridian(entries, config, logger = null) {
  const target = config.export.meridianSmartWalletsPath;
  let raw = { wallets: [] };

  if (fs.existsSync(target)) {
    raw = JSON.parse(fs.readFileSync(target, "utf8"));
    if (Array.isArray(raw)) {
      raw = { wallets: raw };
    }
    if (!Array.isArray(raw.wallets)) {
      throw new Error(`${target} does not contain a wallets array`);
    }
  }

  const existingAddresses = new Set(
    raw.wallets.map((wallet) => String(wallet.address || "")).filter(Boolean),
  );
  const existingNames = new Set(
    raw.wallets.map((wallet) => String(wallet.name || "")).filter(Boolean),
  );

  let added = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (existingAddresses.has(entry.address)) {
      skipped += 1;
      continue;
    }
    let name = entry.name;
    let suffix = 2;
    while (existingNames.has(name)) {
      name = `${entry.name}-${suffix}`;
      suffix += 1;
    }
    raw.wallets.push({
      name,
      address: entry.address,
      category: entry.category || config.export.category || "smart",
      type: entry.type || config.export.type || "lp",
      addedAt: entry.addedAt || new Date().toISOString(),
    });
    existingAddresses.add(entry.address);
    existingNames.add(name);
    added += 1;
  }

  let backupPath = null;
  if (fs.existsSync(target)) {
    backupPath = `${target}.bak.${Date.now()}`;
    fs.copyFileSync(target, backupPath);
  }
  writeJsonAtomic(target, raw);
  logger?.info(
    `Merged into ${target}: ${added} added, ${skipped} skipped${
      backupPath ? `, backup ${backupPath}` : ""
    }`,
  );
  return { added, skipped, backupPath, target };
}
