import fs from "node:fs";
import path from "node:path";

const PERFORMANCE_VERSION = 1;
const DEFAULT_CHECKS_TO_KEEP = 20;
const DAY_MS = 86_400_000;

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

export function performancePath(config) {
  return path.join(config.paths.dataDir, "performance.json");
}

export function loadPerformance(config) {
  const file = performancePath(config);
  const empty = { version: PERFORMANCE_VERSION, updatedAt: null, wallets: {} };
  if (!fs.existsSync(file)) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: raw.version || PERFORMANCE_VERSION,
      updatedAt: raw.updatedAt || null,
      wallets:
        raw.wallets && typeof raw.wallets === "object" ? raw.wallets : {},
    };
  } catch {
    return empty;
  }
}

export function savePerformance(config, perf) {
  const file = performancePath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    version: PERFORMANCE_VERSION,
    updatedAt: new Date().toISOString(),
    wallets: perf.wallets || {},
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return payload;
}

export function metricsSnapshot(candidate, { at, source = "scan" } = {}) {
  const metrics = candidate?.metrics || {};
  const score = candidate?.score || {};
  return {
    at: at || new Date().toISOString(),
    source,
    score: numberOrNull(score.score),
    tier: score.tier ?? null,
    status: score.status ?? "unknown",
    n: numberOrNull(metrics.n),
    winRatePct: numberOrNull(metrics.winRatePct),
    feeYieldPct: numberOrNull(metrics.feeYieldPct),
    netRoiPct: numberOrNull(metrics.netRoiPct),
    totalPnlUsd: numberOrNull(metrics.totalPnlUsd),
    totalFeesUsd: numberOrNull(metrics.totalFeesUsd),
    openPositions: numberOrNull(metrics.openPositions),
    daysSinceActive: numberOrNull(metrics.daysSinceActive),
  };
}

function appendCheck(entry, snapshot, config) {
  const keep = Math.max(
    1,
    Number(config.performance?.checksToKeep || DEFAULT_CHECKS_TO_KEEP),
  );
  entry.checks = Array.isArray(entry.checks) ? entry.checks : [];
  entry.checks.push(snapshot);
  if (entry.checks.length > keep) {
    entry.checks.splice(0, entry.checks.length - keep);
  }
  entry.lastCheckedAt = snapshot.at;
  entry.lastStatus = snapshot.status;
  entry.lastScore = snapshot.score;
  entry.lastSource = snapshot.source;
}

/**
 * Record the outcome of a scan: new recommendations get a baseline, already
 * tracked wallets get a fresh measurement point.
 */
export function recordScan(
  config,
  lastScan,
  { now = new Date().toISOString() } = {},
) {
  if (config.performance?.enabled === false) {
    return { added: 0, updated: 0, skipped: 0 };
  }

  const perf = loadPerformance(config);
  const candidates = Array.isArray(lastScan?.candidates)
    ? lastScan.candidates
    : [];
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const address = candidate?.address;
    if (!address) continue;

    const snapshot = metricsSnapshot(candidate, { at: now, source: "scan" });
    const entry = perf.wallets[address];

    if (!entry) {
      if (snapshot.status !== "recommended") {
        skipped += 1;
        continue;
      }
      perf.wallets[address] = {
        address,
        short: candidate.short || null,
        recommendedAt: now,
        lastRecommendedAt: now,
        timesRecommended: 1,
        baseline: snapshot,
        checks: [],
        lastCheckedAt: snapshot.at,
        lastStatus: snapshot.status,
        lastScore: snapshot.score,
        lastSource: "scan",
      };
      added += 1;
      continue;
    }

    const wasRecommended = entry.lastStatus === "recommended";
    appendCheck(entry, snapshot, config);
    if (snapshot.status === "recommended") {
      entry.lastRecommendedAt = now;
      if (!wasRecommended) {
        entry.timesRecommended = Number(entry.timesRecommended || 1) + 1;
      }
    }
    updated += 1;
  }

  if (added > 0 || updated > 0) savePerformance(config, perf);
  return { added, updated, skipped, perf };
}

/** Record the result of a live `finder.js check` run. */
export function recordLiveCheck(
  config,
  result,
  { now = new Date().toISOString() } = {},
) {
  const address = result?.address;
  if (!address) return { recorded: false };

  const perf = loadPerformance(config);
  const snapshot = metricsSnapshot(result, { at: now, source: "live" });
  const entry = perf.wallets[address];

  if (!entry) {
    if (snapshot.status !== "recommended") {
      return { recorded: false, perf };
    }
    perf.wallets[address] = {
      address,
      short: result.short || null,
      recommendedAt: now,
      lastRecommendedAt: now,
      timesRecommended: 1,
      baseline: snapshot,
      checks: [],
      lastCheckedAt: snapshot.at,
      lastStatus: snapshot.status,
      lastScore: snapshot.score,
      lastSource: "live",
    };
  } else {
    const wasRecommended = entry.lastStatus === "recommended";
    appendCheck(entry, snapshot, config);
    if (snapshot.status === "recommended") {
      entry.lastRecommendedAt = now;
      if (!wasRecommended) {
        entry.timesRecommended = Number(entry.timesRecommended || 1) + 1;
      }
    }
  }

  savePerformance(config, perf);
  return { recorded: true, perf };
}

function pnlDelta(entry) {
  const latest = entry.checks?.length
    ? entry.checks[entry.checks.length - 1]
    : null;
  if (!latest) return null;
  if (latest.totalPnlUsd == null || entry.baseline?.totalPnlUsd == null) {
    return null;
  }
  return latest.totalPnlUsd - entry.baseline.totalPnlUsd;
}

function roiDelta(entry) {
  const latest = entry.checks?.length
    ? entry.checks[entry.checks.length - 1]
    : null;
  if (!latest) return null;
  if (latest.netRoiPct == null || entry.baseline?.netRoiPct == null) {
    return null;
  }
  return latest.netRoiPct - entry.baseline.netRoiPct;
}

function daysBetween(fromIso, nowMs) {
  const start = Date.parse(String(fromIso ?? ""));
  if (!Number.isFinite(start)) return null;
  return Math.max(0, (nowMs - start) / DAY_MS);
}

/**
 * Summarise how the wallets we recommended are doing now. A wallet is a "hit"
 * when its realised PnL grew after it was recommended.
 */
export function performanceSummary(
  perf,
  { now = Date.now(), horizonDays = null } = {},
) {
  const entries = Object.values(perf?.wallets || {});
  const horizonMs =
    Number.isFinite(Number(horizonDays)) && Number(horizonDays) > 0
      ? Number(horizonDays) * DAY_MS
      : null;

  const scoped = entries.filter((entry) => {
    if (!horizonMs) return true;
    const start = Date.parse(String(entry.recommendedAt ?? ""));
    return Number.isFinite(start) && now - start <= horizonMs;
  });

  const evaluated = [];
  const pending = [];

  for (const entry of scoped) {
    const latest = entry.checks?.length
      ? entry.checks[entry.checks.length - 1]
      : null;
    if (!latest) {
      pending.push(entry);
      continue;
    }
    const pnl = pnlDelta(entry);
    const roi = roiDelta(entry);
    evaluated.push({
      address: entry.address,
      short: entry.short,
      recommendedAt: entry.recommendedAt,
      daysTracked: daysBetween(entry.recommendedAt, now),
      baseline: entry.baseline,
      latest,
      pnlDeltaUsd: pnl,
      roiDeltaPct: roi,
      hit: pnl != null ? pnl > 0 : null,
      stillRecommended: latest.status === "recommended",
      active:
        latest.openPositions > 0 ||
        (latest.daysSinceActive != null && latest.daysSinceActive <= 7),
    });
  }

  const withPnl = evaluated.filter((item) => item.pnlDeltaUsd != null);
  const hits = withPnl.filter((item) => item.pnlDeltaUsd > 0);
  const withRoi = evaluated.filter((item) => item.roiDeltaPct != null);

  const average = (list, key) => {
    if (list.length === 0) return null;
    return round(list.reduce((sum, item) => sum + Number(item[key]), 0) / list.length);
  };

  const sorted = [...withPnl].sort(
    (left, right) => right.pnlDeltaUsd - left.pnlDeltaUsd,
  );

  return {
    tracked: scoped.length,
    evaluated: evaluated.length,
    pending: pending.length,
    withPnl: withPnl.length,
    hits: hits.length,
    losses: withPnl.length - hits.length,
    hitRatePct:
      withPnl.length > 0 ? round((hits.length / withPnl.length) * 100, 1) : null,
    avgPnlDeltaUsd: average(withPnl, "pnlDeltaUsd"),
    avgRoiDeltaPct: average(withRoi, "roiDeltaPct"),
    stillRecommended: evaluated.filter((item) => item.stillRecommended).length,
    stillRecommendedPct:
      evaluated.length > 0
        ? round(
            (evaluated.filter((item) => item.stillRecommended).length /
              evaluated.length) *
              100,
            1,
          )
        : null,
    active: evaluated.filter((item) => item.active).length,
    activePct:
      evaluated.length > 0
        ? round(
            (evaluated.filter((item) => item.active).length /
              evaluated.length) *
              100,
            1,
          )
        : null,
    avgDaysTracked: average(evaluated, "daysTracked"),
    best: sorted.slice(0, 5),
    worst: sorted.slice(-5).reverse(),
    items: evaluated,
    horizonDays: horizonMs ? Number(horizonDays) : null,
  };
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const sign = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${sign}$${Math.abs(number).toFixed(0)}`;
}

function points(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number > 0 ? "+" : ""}${number.toFixed(1)} pts`;
}

function pct(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number}%` : "-";
}

function shortOf(item) {
  return item.short || `${String(item.address || "").slice(0, 6)}...`;
}

export function formatPerformanceReport(summary, { limit = 5 } = {}) {
  const lines = ["📈 <b>Performance tracking</b>"];

  if (!summary || summary.tracked === 0) {
    return (
      "📈 <b>Performance tracking</b>\n" +
      "No recommendations tracked yet. Run a scan first, then check again later."
    );
  }

  lines.push(
    summary.horizonDays
      ? `<i>Window: last ${summary.horizonDays} day(s)</i>`
      : "<i>Window: all time</i>",
    "",
    `Tracked: <b>${summary.tracked}</b> · evaluated: ${summary.evaluated} · pending: ${summary.pending}`,
  );

  if (summary.evaluated === 0) {
    lines.push(
      "",
      "No follow-up data yet. Use <code>/perf refresh</code> to re-check the tracked wallets now.",
    );
    return lines.join("\n");
  }

  lines.push(
    `Hit rate: <b>${pct(summary.hitRatePct)}</b> (${summary.hits}/${summary.withPnl} grew PnL)`,
    `Avg PnL change: <b>${money(summary.avgPnlDeltaUsd)}</b> · avg ROI change: ${points(summary.avgRoiDeltaPct)}`,
    `Still recommended: ${pct(summary.stillRecommendedPct)} · active: ${pct(summary.activePct)}`,
    `Avg tracking time: ${summary.avgDaysTracked ?? "-"} day(s)`,
  );

  const best = (summary.best || []).slice(0, limit);
  if (best.length > 0) {
    lines.push("", "<b>Best since recommendation</b>");
    best.forEach((item) =>
      lines.push(
        `• <code>${shortOf(item)}</code> ${money(item.pnlDeltaUsd)} (${points(
          item.roiDeltaPct,
        )})`,
      ),
    );
  }

  const worst = (summary.worst || []).filter(
    (item) => item.pnlDeltaUsd < 0,
  ).slice(0, limit);
  if (worst.length > 0) {
    lines.push("", "<b>Weakest since recommendation</b>");
    worst.forEach((item) =>
      lines.push(
        `• <code>${shortOf(item)}</code> ${money(item.pnlDeltaUsd)} (${points(
          item.roiDeltaPct,
        )})`,
      ),
    );
  }

  lines.push(
    "",
    "<i>PnL change compares the first recommendation with the latest check.</i>",
  );
  return lines.join("\n");
}

/** Wallets whose last measurement is older than staleHours, oldest first. */
export function staleWallets(
  perf,
  { now = Date.now(), staleHours = 24, limit = 5 } = {},
) {
  const threshold = Math.max(1, Number(staleHours)) * 3_600_000;
  const max = Math.max(1, Number(limit));

  return Object.values(perf?.wallets || {})
    .filter((entry) => {
      const last = Date.parse(String(entry.lastCheckedAt ?? entry.recommendedAt));
      if (!Number.isFinite(last)) return true;
      return now - last >= threshold;
    })
    .sort((left, right) => {
      const a = Date.parse(String(left.lastCheckedAt ?? left.recommendedAt));
      const b = Date.parse(String(right.lastCheckedAt ?? right.recommendedAt));
      return (Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0);
    })
    .slice(0, max)
    .map((entry) => entry.address);
}
