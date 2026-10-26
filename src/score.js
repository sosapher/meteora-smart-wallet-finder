import { clamp, recencyScoreDays, round } from "./util.js";

const FLAG_LABELS = {
  low_sample: "small sample",
  low_win_rate: "win rate below 45%",
  negative_net: "negative net PnL",
  low_fee_yield: "low fee yield",
  stale: "inactive >60d",
  scalper: "avg hold <30m",
  passive: "avg hold >72h",
  ultra_tight: "ultra-tight range (<=5 bins)",
  too_wide: "very wide range (>150 bins)",
  outlier_dependent: "profit depends on one outlier",
  big_loss: "single loss worse than -40%",
  one_pool: "active in only one pool",
  small_capital: "average position < $200",
  whale: "average position > $500k",
  high_churn: "high position churn",
  fee_driven: "profit mostly from fees",
  price_dependent: "profit mostly from price movement",
  partial_data: "incomplete history",
  no_hold_data: "hold time unavailable",
  no_width_data: "range width unavailable",
};

export function tierForScore(score) {
  if (score >= 85) return "S";
  if (score >= 75) return "A";
  if (score >= 65) return "B";
  if (score >= 55) return "C";
  return "D";
}

function holdScore(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  if (hours < 0.25) return 2;
  if (hours < 0.5) return 4;
  if (hours < 1) return 7;
  if (hours <= 24) return 10;
  if (hours <= 48) return 8;
  if (hours <= 72) return 5;
  if (hours <= 168) return 2;
  return 0;
}

function widthScore(bins) {
  if (!Number.isFinite(bins) || bins <= 0) return 0;
  if (bins <= 5) return 3;
  if (bins < 20) return 7;
  if (bins <= 80) return 10;
  if (bins <= 120) return 8;
  if (bins <= 200) return 4;
  return 1;
}

function riskScore(metrics) {
  let score = 2;
  const flags = new Set(metrics.flags || []);
  if (flags.has("outlier_dependent")) score -= 0.8;
  if (flags.has("big_loss")) score -= 0.4;
  if (flags.has("small_capital") || flags.has("whale")) score -= 0.3;
  if (flags.has("high_churn")) score -= 0.3;
  if (flags.has("partial_data")) score -= 0.2;
  return clamp(score, 0, 2);
}

function buildReasons(metrics) {
  const reasons = [];
  if (metrics.n > 0) reasons.push(`${metrics.n} closed positions`);
  if (metrics.winRatePct > 0) reasons.push(`win rate ${metrics.winRatePct}%`);
  if (metrics.feeYieldPct > 0) reasons.push(`fee yield ${metrics.feeYieldPct}%`);
  if (metrics.netRoiPct !== 0) reasons.push(`net ROI ${metrics.netRoiPct}%`);
  if (metrics.profitFactor > 0) reasons.push(`PF ${metrics.profitFactor}`);
  if (metrics.avgHoldHours > 0) reasons.push(`avg hold ${metrics.avgHoldHours}h`);
  if (metrics.medianWidthBins > 0) reasons.push(`range ${metrics.medianWidthBins} bins`);
  if (metrics.daysSinceActive === 0 && metrics.openPositions > 0) {
    reasons.push("active now");
  } else if (Number.isFinite(metrics.daysSinceActive)) {
    reasons.push(`active ${metrics.daysSinceActive}d ago`);
  }
  if (metrics.feeSharePct >= 70) reasons.push(`fee-driven ${metrics.feeSharePct}%`);
  if (metrics.poolCount >= 2) reasons.push(`${metrics.poolCount} pools`);
  return reasons;
}

export function scoreWallet(metrics, config, options = {}) {
  const scoreCfg = config.score;
  const allowLowConfidence =
    options.allowLowConfidence ?? scoreCfg.allowLowConfidence ?? false;

  const gates = [
    {
      code: "sample",
      ok: metrics.n >= config.metrics.minClosedPositions,
      detail: `${metrics.n} closed positions (min ${config.metrics.minClosedPositions})`,
    },
    {
      code: "win_rate",
      ok: metrics.winRatePct >= scoreCfg.minWinRatePct,
      detail: `win rate ${metrics.winRatePct}% (min ${scoreCfg.minWinRatePct}%)`,
    },
    {
      code: "net_roi",
      ok: metrics.netRoiPct >= scoreCfg.minNetRoiPct,
      detail: `net ROI ${metrics.netRoiPct}% (min ${scoreCfg.minNetRoiPct}%)`,
    },
    {
      code: "fee_yield",
      ok: metrics.feeYieldPct >= scoreCfg.minFeeYieldPct,
      detail: `fee yield ${metrics.feeYieldPct}% (min ${scoreCfg.minFeeYieldPct}%)`,
    },
    {
      code: "capital",
      ok: metrics.totalDepositUsd >= config.metrics.minTotalDepositUsd,
      detail: `total deposits $${metrics.totalDepositUsd} (min $${config.metrics.minTotalDepositUsd})`,
    },
    {
      code: "recency",
      ok:
        metrics.openPositions > 0 ||
        (Number.isFinite(metrics.daysSinceActive) &&
          metrics.daysSinceActive <= config.metrics.maxDaysSinceActive),
      detail:
        metrics.daysSinceActive == null
          ? "no activity timestamp"
          : `last activity ${metrics.daysSinceActive}d ago (max ${config.metrics.maxDaysSinceActive}d)`,
    },
    {
      code: "confidence",
      ok: allowLowConfidence || metrics.confidence !== "low",
      detail: `data confidence ${metrics.confidence}`,
    },
  ];

  const qualified = gates.every((gate) => gate.ok);
  const rejectionReasons = gates.filter((gate) => !gate.ok).map((gate) => gate.detail);

  const sampleComponent = clamp((metrics.n - 3) / 17) * 10;
  const winComponent = clamp((metrics.winRatePct / 100 - 0.35) / 0.35) * 15;
  const feeComponent = clamp(metrics.feeYieldPct / 8) * 20;
  const roiComponent = clamp(metrics.netRoiPct / 25) * 15;
  const profitFactorComponent = clamp((metrics.profitFactor - 1) / 2) * 10;
  const behaviorComponent =
    holdScore(metrics.avgHoldHours) * 0.6 + widthScore(metrics.medianWidthBins) * 0.4;
  const diversityComponent = clamp((metrics.poolCount - 1) / 3) * 5;
  const recencyComponent = recencyScoreDays(metrics.daysSinceActive);
  const feeShareComponent = clamp((metrics.feeSharePct - 30) / 50) * 3;
  const riskComponent = riskScore(metrics);

  const components = {
    sample: round(sampleComponent, 2),
    winRate: round(winComponent, 2),
    feeYield: round(feeComponent, 2),
    netRoi: round(roiComponent, 2),
    profitFactor: round(profitFactorComponent, 2),
    behavior: round(behaviorComponent, 2),
    diversity: round(diversityComponent, 2),
    recency: round(recencyComponent, 2),
    feeShare: round(feeShareComponent, 2),
    risk: round(riskComponent, 2),
  };

  const rawScore = Object.values(components).reduce((total, value) => total + value, 0);
  const score = round(clamp(rawScore, 0, 100), 1);
  const tier = tierForScore(score);

  let status = "rejected";
  if (qualified) {
    if (score >= scoreCfg.minScore) status = "recommended";
    else if (score >= scoreCfg.watchMinScore) status = "watch";
  }

  const warnings = [...new Set(metrics.flags || [])].map(
    (flag) => FLAG_LABELS[flag] || flag,
  );

  return {
    score,
    tier,
    status,
    qualified,
    gates,
    rejectionReasons,
    components,
    reasons: buildReasons(metrics),
    warnings,
  };
}
