import { clamp, daysBetween, mean, median, round } from "./util.js";

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function finite(value) {
  return Number.isFinite(value);
}

function buildPoolBreakdown(positions) {
  const map = new Map();
  for (const position of positions) {
    const key = position.pool || "unknown";
    if (!map.has(key)) {
      map.set(key, {
        pool: key,
        positions: 0,
        depositUsd: 0,
        feesUsd: 0,
        pnlUsd: 0,
        wins: 0,
        holdHours: [],
        widths: [],
      });
    }
    const entry = map.get(key);
    entry.positions += 1;
    entry.depositUsd += position.depositUsd;
    entry.feesUsd += position.feeUsd;
    entry.pnlUsd += position.pnlUsd;
    if (position.pnlUsd > 0) entry.wins += 1;
    if (finite(position.holdHours)) entry.holdHours.push(position.holdHours);
    if (finite(position.widthBins)) entry.widths.push(position.widthBins);
  }

  return [...map.values()]
    .map((entry) => ({
      pool: entry.pool,
      positions: entry.positions,
      depositUsd: round(entry.depositUsd, 0),
      feesUsd: round(entry.feesUsd, 0),
      pnlUsd: round(entry.pnlUsd, 0),
      winRatePct: round((entry.wins / entry.positions) * 100, 1),
      avgHoldHours: round(mean(entry.holdHours), 2),
      medianWidthBins: round(median(entry.widths), 1),
    }))
    .sort((a, b) => b.positions - a.positions);
}

export function computeMetrics(positions, options = {}) {
  const now = options.now || Date.now();
  const openPositions = Number(options.openPositions || 0);
  const openPools = Number(options.openPools || 0);
  const seenPoolCount = Number(options.seenPoolCount || 0);
  const maxDaysSinceActive = Number.isFinite(Number(options.maxDaysSinceActive))
    ? Number(options.maxDaysSinceActive)
    : 30;
  const partial = Boolean(options.partial);

  const n = positions.length;
  const deposits = positions.map((position) => position.depositUsd).filter(finite);
  const fees = positions.map((position) => position.feeUsd).filter(finite);
  const pnls = positions.map((position) => position.pnlUsd).filter(finite);
  const pnlPcts = positions
    .map((position) => position.pnlPct)
    .filter(finite);
  const holds = positions.map((position) => position.holdHours).filter(finite);
  const widths = positions.map((position) => position.widthBins).filter(finite);

  const totalDepositUsd = sum(deposits);
  const totalFeesUsd = sum(fees);
  const totalPnlUsd = sum(pnls);
  const totalWithdrawUsd = sum(
    positions.map((position) => position.withdrawUsd).filter(finite),
  );
  const pricePnlUsd = totalPnlUsd - totalFeesUsd;

  const wins = pnls.filter((value) => value > 0).length;
  const losses = pnls.filter((value) => value < 0).length;
  const winRate = n > 0 ? wins / n : 0;

  const positivePnl = pnls.filter((value) => value > 0);
  const negativePnl = pnls.filter((value) => value < 0);
  const positiveSum = sum(positivePnl);
  const negativeSum = Math.abs(sum(negativePnl));
  const profitFactor =
    negativeSum > 0 ? positiveSum / negativeSum : positiveSum > 0 ? 99 : 0;

  const feeYieldPct = totalDepositUsd > 0
    ? (totalFeesUsd / totalDepositUsd) * 100
    : 0;
  const netRoiPct = totalDepositUsd > 0
    ? (totalPnlUsd / totalDepositUsd) * 100
    : 0;
  const feeShareBase = totalFeesUsd + Math.max(0, pricePnlUsd);
  const feeSharePct = feeShareBase > 0
    ? clamp((totalFeesUsd / feeShareBase) * 100, 0, 100)
    : 0;

  const bestPnlUsd = pnls.length > 0 ? Math.max(...pnls) : 0;
  const worstPnlUsd = pnls.length > 0 ? Math.min(...pnls) : 0;
  const outlierSharePct = positiveSum > 0
    ? clamp((Math.max(0, bestPnlUsd) / positiveSum) * 100, 0, 100)
    : 0;

  const depositConcentrationPct = totalDepositUsd > 0
    ? clamp((Math.max(0, ...deposits) / totalDepositUsd) * 100, 0, 100)
    : 0;
  const avgDepositUsd = n > 0 ? totalDepositUsd / n : 0;
  const maxDepositUsd = deposits.length > 0 ? Math.max(...deposits) : 0;

  const avgHoldHours = mean(holds);
  const medianHoldHours = median(holds);
  const avgWidthBins = mean(widths);
  const medianWidthBins = median(widths);
  const maxLossPct = pnlPcts.length > 0 ? Math.min(...pnlPcts) : 0;

  const createdTimes = positions
    .map((position) => position.createdAt)
    .filter((value) => finite(value) && value > 0);
  const closedTimes = positions
    .map((position) => position.closedAt)
    .filter((value) => finite(value) && value > 0);
  const firstActivityMs = createdTimes.length > 0 ? Math.min(...createdTimes) : null;
  const lastClosedMs = closedTimes.length > 0 ? Math.max(...closedTimes) : null;
  const lastActivityMs =
    openPositions > 0 ? now : lastClosedMs;
  const activeDays =
    firstActivityMs && lastClosedMs
      ? Math.max(0, (lastClosedMs - firstActivityMs) / 86_400_000)
      : 0;
  const daysSinceActive =
    openPositions > 0
      ? 0
      : lastActivityMs
        ? daysBetween(lastActivityMs, now)
        : Number.POSITIVE_INFINITY;
  const churnPerDay = activeDays > 0 ? n / activeDays : n;

  const distinctPools = new Set(
    positions.map((position) => position.pool).filter(Boolean),
  ).size;
  const poolCount = Math.max(distinctPools, seenPoolCount);

  const validDeposits = deposits.length;
  const validHolds = holds.length;
  const validWidths = widths.length;
  let confidence = "low";
  if (
    n >= 10 &&
    validDeposits >= n * 0.8 &&
    validHolds >= n * 0.5 &&
    !partial
  ) {
    confidence = "high";
  } else if (n >= 5 && validDeposits >= n * 0.6) {
    confidence = "medium";
  }

  const flags = [];
  if (n < 5) flags.push("low_sample");
  if (winRate < 0.45) flags.push("low_win_rate");
  if (netRoiPct < 0) flags.push("negative_net");
  if (feeYieldPct < 1) flags.push("low_fee_yield");
  if (daysSinceActive > maxDaysSinceActive) flags.push("stale");
  if (avgHoldHours > 0 && avgHoldHours < 0.5) flags.push("scalper");
  if (avgHoldHours > 72) flags.push("passive");
  if (medianWidthBins > 0 && medianWidthBins <= 5) flags.push("ultra_tight");
  if (medianWidthBins > 150) flags.push("too_wide");
  if (outlierSharePct >= 60 && n >= 5) flags.push("outlier_dependent");
  if (maxLossPct < -40) flags.push("big_loss");
  if (poolCount < 2) flags.push("one_pool");
  if (avgDepositUsd > 0 && avgDepositUsd < 200) flags.push("small_capital");
  if (avgDepositUsd > 500_000) flags.push("whale");
  if (churnPerDay > 10) flags.push("high_churn");
  if (feeSharePct >= 70 && netRoiPct > 0) flags.push("fee_driven");
  if (feeSharePct < 30 && netRoiPct > 0) flags.push("price_dependent");
  if (partial) flags.push("partial_data");
  if (validHolds === 0) flags.push("no_hold_data");
  if (validWidths === 0) flags.push("no_width_data");

  const recentPositions = [...positions]
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, 8)
    .map((position) => ({
      position: position.position,
      pool: position.pool,
      depositUsd: round(position.depositUsd, 0),
      feeUsd: round(position.feeUsd, 0),
      pnlUsd: round(position.pnlUsd, 0),
      pnlPct: round(position.pnlPct ?? 0, 2),
      holdHours: round(position.holdHours ?? 0, 2),
      widthBins: position.widthBins,
      closedAt: position.closedAt
        ? new Date(position.closedAt).toISOString()
        : null,
    }));

  return {
    n,
    wins,
    losses,
    winRate,
    winRatePct: round(winRate * 100, 1),
    totalDepositUsd: round(totalDepositUsd, 0),
    totalFeesUsd: round(totalFeesUsd, 0),
    totalPnlUsd: round(totalPnlUsd, 0),
    totalWithdrawUsd: round(totalWithdrawUsd, 0),
    pricePnlUsd: round(pricePnlUsd, 0),
    feeYieldPct: round(feeYieldPct, 2),
    netRoiPct: round(netRoiPct, 2),
    feeSharePct: round(feeSharePct, 1),
    profitFactor: round(profitFactor, 2),
    avgDepositUsd: round(avgDepositUsd, 0),
    maxDepositUsd: round(maxDepositUsd, 0),
    depositConcentrationPct: round(depositConcentrationPct, 1),
    avgHoldHours: round(avgHoldHours, 2),
    medianHoldHours: round(medianHoldHours, 2),
    avgWidthBins: round(avgWidthBins, 1),
    medianWidthBins: round(medianWidthBins, 1),
    maxLossPct: round(maxLossPct, 2),
    bestPnlUsd: round(bestPnlUsd, 0),
    worstPnlUsd: round(worstPnlUsd, 0),
    outlierSharePct: round(outlierSharePct, 1),
    activeDays: round(activeDays, 1),
    daysSinceActive: Number.isFinite(daysSinceActive)
      ? round(daysSinceActive, 1)
      : null,
    churnPerDay: round(churnPerDay, 2),
    poolCount,
    distinctPools,
    openPositions,
    openPools,
    lastActivity: lastActivityMs
      ? new Date(lastActivityMs).toISOString()
      : null,
    firstActivity: firstActivityMs
      ? new Date(firstActivityMs).toISOString()
      : null,
    confidence,
    flags,
    dataQuality: {
      validDeposits,
      validHolds,
      validWidths,
      totalRawPositions: Number(options.totalRawPositions || n),
      partial,
    },
    poolBreakdown: buildPoolBreakdown(positions),
    recentPositions,
  };
}
