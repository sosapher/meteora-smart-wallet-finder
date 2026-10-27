import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, deepMerge } from "../src/config.js";
import { computeMetrics } from "../src/metrics.js";
import { scoreWallet, tierForScore } from "../src/score.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function baseConfig(overrides = {}) {
  return deepMerge(DEFAULT_CONFIG, overrides);
}

function baseMetrics(overrides = {}) {
  const n = overrides.n ?? 20;
  const winRate = overrides.winRate ?? 0.75;
  return {
    n,
    wins: Math.round(n * winRate),
    losses: n - Math.round(n * winRate),
    winRate,
    winRatePct: overrides.winRatePct ?? winRate * 100,
    totalDepositUsd: overrides.totalDepositUsd ?? 20_000,
    totalFeesUsd: overrides.totalFeesUsd ?? 1_600,
    totalPnlUsd: overrides.totalPnlUsd ?? 4_000,
    feeYieldPct: overrides.feeYieldPct ?? 8,
    netRoiPct: overrides.netRoiPct ?? 20,
    feeSharePct: overrides.feeSharePct ?? 40,
    profitFactor: overrides.profitFactor ?? 3,
    avgHoldHours: overrides.avgHoldHours ?? 8,
    medianHoldHours: overrides.medianHoldHours ?? 8,
    medianWidthBins: overrides.medianWidthBins ?? 40,
    avgWidthBins: overrides.avgWidthBins ?? 40,
    outlierSharePct: overrides.outlierSharePct ?? 30,
    poolCount: overrides.poolCount ?? 3,
    openPositions: overrides.openPositions ?? 1,
    daysSinceActive: overrides.daysSinceActive ?? 0,
    confidence: overrides.confidence ?? "high",
    flags: overrides.flags ?? [],
    reasons: [],
  };
}

test("maps scores to tiers at boundaries", () => {
  assert.equal(tierForScore(100), "S");
  assert.equal(tierForScore(85), "S");
  assert.equal(tierForScore(84.9), "A");
  assert.equal(tierForScore(75), "A");
  assert.equal(tierForScore(74.9), "B");
  assert.equal(tierForScore(65), "B");
  assert.equal(tierForScore(55), "C");
  assert.equal(tierForScore(54.9), "D");
});

test("marks a strong wallet as recommended", () => {
  const result = scoreWallet(baseMetrics(), baseConfig());

  assert.equal(result.qualified, true);
  assert.deepEqual(result.rejectionReasons, []);
  assert.equal(result.status, "recommended");
  assert.equal(result.tier, "S");
  assert.ok(result.score >= 75);
  assert.ok(result.reasons.length > 0);
});

test("sample gate uses config.metrics.minClosedPositions", () => {
  const config = baseConfig({ metrics: { minClosedPositions: 10 } });
  const result = scoreWallet(baseMetrics({ n: 6 }), config);

  assert.equal(result.qualified, false);
  assert.equal(result.gates.find((gate) => gate.code === "sample").ok, false);
  assert.match(result.rejectionReasons.join(" "), /6 closed positions \(min 10\)/);
});

test("rejects wallets below win-rate, fee-yield and net-ROI gates", () => {
  const config = baseConfig();

  const lowWin = scoreWallet(
    baseMetrics({ winRate: 0.3, winRatePct: 30 }),
    config,
  );
  assert.equal(lowWin.qualified, false);
  assert.match(lowWin.rejectionReasons.join(" "), /win rate 30%/);

  const lowFee = scoreWallet(baseMetrics({ feeYieldPct: 0.2 }), config);
  assert.equal(lowFee.qualified, false);
  assert.match(lowFee.rejectionReasons.join(" "), /fee yield 0.2%/);

  const negative = scoreWallet(baseMetrics({ netRoiPct: -3 }), config);
  assert.equal(negative.qualified, false);
  assert.match(negative.rejectionReasons.join(" "), /net ROI -3%/);
});

test("rejects stale and under-capitalized wallets", () => {
  const config = baseConfig();

  const stale = scoreWallet(
    baseMetrics({ openPositions: 0, daysSinceActive: 90 }),
    config,
  );
  assert.equal(stale.qualified, false);
  assert.match(stale.rejectionReasons.join(" "), /last activity 90d/);

  const small = scoreWallet(baseMetrics({ totalDepositUsd: 100 }), config);
  assert.equal(small.qualified, false);
  assert.match(small.rejectionReasons.join(" "), /total deposits \$100/);
});

test("rejects low-confidence data unless explicitly allowed", () => {
  const metrics = baseMetrics({ confidence: "low" });
  const config = baseConfig();

  const strict = scoreWallet(metrics, config);
  assert.equal(strict.qualified, false);
  assert.match(strict.rejectionReasons.join(" "), /confidence low/);

  const allowed = scoreWallet(metrics, config, { allowLowConfidence: true });
  assert.equal(allowed.qualified, true);
});

test("downgrades qualified but modest wallets to watch", () => {
  const config = baseConfig();
  const result = scoreWallet(
    baseMetrics({
      winRate: 0.75,
      winRatePct: 75,
      feeYieldPct: 4,
      netRoiPct: 6,
      profitFactor: 2,
      avgHoldHours: 8,
      medianWidthBins: 40,
      poolCount: 2,
      daysSinceActive: 7,
      feeSharePct: 50,
    }),
    config,
  );

  assert.equal(result.qualified, true);
  assert.equal(result.status, "watch");
  assert.ok(result.score >= config.score.watchMinScore);
  assert.ok(result.score < config.score.minScore);
});

test("returns rejected when qualified but below watch threshold", () => {
  const result = scoreWallet(
    baseMetrics({
      winRatePct: 46,
      feeYieldPct: 1.1,
      netRoiPct: 0.2,
      profitFactor: 1.1,
      avgHoldHours: 200,
      medianWidthBins: 220,
      poolCount: 1,
      daysSinceActive: 55,
      feeSharePct: 50,
      flags: ["one_pool", "too_wide"],
    }),
    baseConfig(),
  );

  assert.equal(result.qualified, true);
  assert.equal(result.status, "rejected");
  assert.ok(result.score < 62);
});

test("maps risk flags to readable warnings", () => {
  const result = scoreWallet(
    baseMetrics({ flags: ["outlier_dependent", "big_loss", "partial_data"] }),
    baseConfig(),
  );

  assert.deepEqual(result.warnings, [
    "profit depends on one outlier",
    "single loss worse than -40%",
    "incomplete history",
  ]);
  assert.ok(result.components.risk < 2);
});

test("wallet age gate rejects young wallets when Helius hygiene is enabled", () => {
  const config = baseConfig({
    hygiene: { checkWalletAge: true, minWalletAgeDays: 30 },
  });
  const metrics = {
    ...baseMetrics(),
    hygiene: { enabled: true, walletAgeDays: 10, ageCapped: false },
  };
  const result = scoreWallet(metrics, config);

  assert.equal(result.qualified, false);
  assert.ok(result.rejectionReasons.some((reason) => /wallet age 10d/.test(reason)));
  assert.equal(
    result.gates.find((gate) => gate.code === "wallet_age")?.ok,
    false,
  );
});

test("wallet age gate accepts capped and unknown ages by default", () => {
  const config = baseConfig({
    hygiene: { checkWalletAge: true, minWalletAgeDays: 30 },
  });

  const capped = scoreWallet(
    {
      ...baseMetrics(),
      hygiene: { enabled: true, walletAgeDays: 5, ageCapped: true },
    },
    config,
  );
  assert.equal(capped.qualified, true);

  const unknown = scoreWallet(
    {
      ...baseMetrics(),
      hygiene: { enabled: true, walletAgeDays: null, ageCapped: false },
    },
    config,
  );
  assert.equal(unknown.qualified, true);

  const strict = scoreWallet(
    {
      ...baseMetrics(),
      hygiene: { enabled: true, walletAgeDays: null, ageCapped: false },
    },
    baseConfig({
      hygiene: {
        checkWalletAge: true,
        requireOnchainData: true,
        minWalletAgeDays: 30,
      },
    }),
  );
  assert.equal(strict.qualified, false);
});

test("wallet age gate is skipped when hygiene is off", () => {
  const config = baseConfig({
    hygiene: { checkWalletAge: false, minWalletAgeDays: 30 },
  });
  const result = scoreWallet(
    {
      ...baseMetrics(),
      hygiene: { enabled: true, walletAgeDays: 5, ageCapped: false },
    },
    config,
  );
  assert.equal(result.qualified, true);
});

test("scores end-to-end from closed position history", () => {
  const positions = Array.from({ length: 20 }, (_, index) => {
    const closedAt = NOW - (20 - index) * 3 * HOUR;
    const createdAt = closedAt - 8 * HOUR;
    return {
      position: `position-${index}`,
      pool: index % 2 === 0 ? "pool-a" : "pool-b",
      depositUsd: 2_000,
      feeUsd: index === 0 ? -500 : 160,
      withdrawUsd: 0,
      pnlUsd: index === 0 ? -300 : 200,
      pnlPct: index === 0 ? -15 : 10,
      createdAt,
      closedAt,
      holdHours: (closedAt - createdAt) / HOUR,
      widthBins: 40,
      inRange: true,
    };
  });
  const metrics = computeMetrics(positions, {
    now: NOW,
    seenPoolCount: 2,
  });
  const result = scoreWallet(metrics, baseConfig());

  assert.equal(metrics.confidence, "high");
  assert.equal(result.qualified, true);
  assert.equal(result.status, "recommended");
  assert.ok(result.components.sample > 0);
  assert.ok(result.components.recency > 0);
});
