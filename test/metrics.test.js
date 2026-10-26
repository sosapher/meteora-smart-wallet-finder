import assert from "node:assert/strict";
import test from "node:test";
import { computeMetrics } from "../src/metrics.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function position(overrides = {}) {
  const createdAt = overrides.createdAt ?? NOW - 10 * DAY;
  const closedAt = overrides.closedAt ?? NOW - 9 * DAY;
  return {
    position: overrides.position ?? "pos",
    pool: overrides.pool ?? "pool-1",
    depositUsd: overrides.depositUsd ?? 1000,
    feeUsd: overrides.feeUsd ?? 50,
    withdrawUsd: overrides.withdrawUsd ?? 0,
    pnlUsd: overrides.pnlUsd ?? 60,
    pnlPct: overrides.pnlPct ?? 6,
    createdAt,
    closedAt,
    holdHours: overrides.holdHours ?? (closedAt - createdAt) / HOUR,
    widthBins: overrides.widthBins ?? 30,
    inRange: overrides.inRange ?? true,
  };
}

function sample(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) =>
    position({
      position: `pos-${index}`,
      pool: overrides.pool ?? (index % 2 === 0 ? "pool-1" : "pool-2"),
      depositUsd: overrides.depositUsd ?? 1000,
      feeUsd: overrides.feeUsd ?? 60,
      pnlUsd: overrides.pnlUsd ?? 80,
      pnlPct: overrides.pnlPct ?? 8,
      widthBins: overrides.widthBins ?? 30,
    }),
  );
}

test("computes win rate, fee yield, net ROI and profit factor", () => {
  const positions = [
    position({ position: "a", depositUsd: 1000, feeUsd: 100, pnlUsd: 150 }),
    position({ position: "b", depositUsd: 1000, feeUsd: 50, pnlUsd: 80 }),
    position({ position: "c", depositUsd: 1000, feeUsd: 20, pnlUsd: -70 }),
  ];
  const metrics = computeMetrics(positions, { now: NOW });

  assert.equal(metrics.n, 3);
  assert.equal(metrics.wins, 2);
  assert.equal(metrics.losses, 1);
  assert.equal(metrics.winRatePct, 66.7);
  assert.equal(metrics.totalDepositUsd, 3000);
  assert.equal(metrics.totalFeesUsd, 170);
  assert.equal(metrics.totalPnlUsd, 160);
  assert.equal(metrics.feeYieldPct, 5.67);
  assert.equal(metrics.netRoiPct, 5.33);
  assert.equal(metrics.profitFactor, 3.29);
});

test("reports zero percentages when deposits are unavailable", () => {
  const metrics = computeMetrics(
    [
      position({ depositUsd: 0, feeUsd: 0, pnlUsd: 0 }),
      position({ depositUsd: 0, feeUsd: 0, pnlUsd: 0 }),
    ],
    { now: NOW },
  );

  assert.equal(metrics.n, 2);
  assert.equal(metrics.feeYieldPct, 0);
  assert.equal(metrics.netRoiPct, 0);
  assert.ok(Number.isFinite(metrics.profitFactor));
});

test("flags low sample, one pool, tight range and small capital", () => {
  const metrics = computeMetrics(sample(3, { widthBins: 1, depositUsd: 120 }), {
    now: NOW,
    seenPoolCount: 1,
  });

  assert.equal(metrics.confidence, "low");
  for (const flag of ["low_sample", "ultra_tight", "small_capital"]) {
    assert.ok(metrics.flags.includes(flag), `expected flag ${flag}`);
  }
});

test("detects outlier-dependent profit and large losses", () => {
  const positions = [
    position({ position: "a", depositUsd: 1000, feeUsd: 5, pnlUsd: 4000, pnlPct: 400 }),
    position({ position: "b", depositUsd: 1000, feeUsd: 5, pnlUsd: -100, pnlPct: -10 }),
    position({ position: "c", depositUsd: 1000, feeUsd: 5, pnlUsd: 10, pnlPct: 1 }),
    position({ position: "d", depositUsd: 1000, feeUsd: 5, pnlUsd: 20, pnlPct: 2 }),
    position({ position: "e", depositUsd: 1000, feeUsd: 5, pnlUsd: 30, pnlPct: 3 }),
    position({ position: "f", depositUsd: 1000, feeUsd: 5, pnlUsd: -500, pnlPct: -50 }),
  ];
  const metrics = computeMetrics(positions, { now: NOW, seenPoolCount: 2 });

  assert.ok(metrics.flags.includes("outlier_dependent"));
  assert.ok(metrics.flags.includes("big_loss"));
  assert.ok(metrics.outlierSharePct >= 60);
});

test("raises confidence only with enough complete history", () => {
  const high = computeMetrics(sample(10), { now: NOW, seenPoolCount: 2 });
  assert.equal(high.confidence, "high");

  const medium = computeMetrics(sample(5), { now: NOW, seenPoolCount: 2 });
  assert.equal(medium.confidence, "medium");

  const partial = computeMetrics(sample(10), {
    now: NOW,
    seenPoolCount: 2,
    partial: true,
  });
  assert.equal(partial.confidence, "medium");
  assert.ok(partial.flags.includes("partial_data"));
});

test("uses a configurable stale threshold", () => {
  const closedAt = NOW - 45 * DAY;
  const positions = sample(5).map((entry, index) => ({
    ...entry,
    position: `stale-${index}`,
    createdAt: closedAt - 8 * HOUR,
    closedAt,
    holdHours: 8,
  }));

  const defaultMetrics = computeMetrics(positions, {
    now: NOW,
    seenPoolCount: 2,
  });
  assert.ok(defaultMetrics.flags.includes("stale"));

  const relaxed = computeMetrics(positions, {
    now: NOW,
    seenPoolCount: 2,
    maxDaysSinceActive: 60,
  });
  assert.ok(!relaxed.flags.includes("stale"));
});

test("counts open positions as currently active", () => {
  const metrics = computeMetrics(sample(5), {
    now: NOW,
    openPositions: 3,
    openPools: 1,
    seenPoolCount: 2,
  });

  assert.equal(metrics.openPositions, 3);
  assert.equal(metrics.daysSinceActive, 0);
  assert.equal(metrics.poolCount, 2);
});

test("builds per-pool breakdown and recent positions", () => {
  const metrics = computeMetrics(
    [
      position({ position: "a", pool: "pool-1", pnlUsd: 50 }),
      position({ position: "b", pool: "pool-1", pnlUsd: -20 }),
      position({ position: "c", pool: "pool-2", pnlUsd: 30 }),
    ],
    { now: NOW },
  );

  assert.equal(metrics.poolBreakdown.length, 2);
  const pool1 = metrics.poolBreakdown.find((pool) => pool.pool === "pool-1");
  assert.equal(pool1.positions, 2);
  assert.equal(pool1.winRatePct, 50);
  assert.equal(metrics.recentPositions.length, 3);
  assert.ok(metrics.recentPositions[0].closedAt);
});
