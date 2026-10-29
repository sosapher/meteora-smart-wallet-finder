import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatPerformanceReport,
  loadPerformance,
  metricsSnapshot,
  performanceSummary,
  recordLiveCheck,
  recordScan,
  savePerformance,
  staleWallets,
} from "../src/performance.js";

function tempConfig(performance = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swf-perf-"));
  return {
    config: { paths: { dataDir: dir }, performance },
    dir,
  };
}

function candidate(address, overrides = {}) {
  return {
    address,
    short: `${address.slice(0, 6)}...`,
    score: { score: 88, tier: "S", status: "recommended", ...overrides.score },
    metrics: {
      n: 40,
      winRatePct: 70,
      feeYieldPct: 20,
      netRoiPct: 15,
      totalPnlUsd: 1000,
      totalFeesUsd: 500,
      openPositions: 2,
      daysSinceActive: 0,
      ...overrides.metrics,
    },
  };
}

const WALLET_A = "7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK";
const WALLET_B = "2KmmUnQ6nscD7j6siUjZMbDoT1u6jnjfZWF386CcRjak";

test("metricsSnapshot copies score and metrics", () => {
  const snapshot = metricsSnapshot(candidate(WALLET_A), {
    at: "2026-10-01T00:00:00.000Z",
    source: "live",
  });
  assert.equal(snapshot.score, 88);
  assert.equal(snapshot.status, "recommended");
  assert.equal(snapshot.netRoiPct, 15);
  assert.equal(snapshot.totalPnlUsd, 1000);
  assert.equal(snapshot.source, "live");
  assert.equal(snapshot.at, "2026-10-01T00:00:00.000Z");
});

test("recordScan tracks only recommended wallets as baselines", () => {
  const { config } = tempConfig();
  const now = "2026-10-01T00:00:00.000Z";

  const result = recordScan(
    config,
    {
      candidates: [
        candidate(WALLET_A),
        candidate(WALLET_B, { score: { status: "watch", score: 60 } }),
      ],
    },
    { now },
  );

  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 1);

  const perf = loadPerformance(config);
  assert.deepEqual(Object.keys(perf.wallets), [WALLET_A]);
  assert.equal(perf.wallets[WALLET_A].baseline.totalPnlUsd, 1000);
  assert.equal(perf.wallets[WALLET_A].checks.length, 0);
  assert.equal(perf.wallets[WALLET_A].timesRecommended, 1);
});

test("recordScan appends follow-up checks and counts re-recommendations", () => {
  const { config } = tempConfig();
  recordScan(config, { candidates: [candidate(WALLET_A)] }, {
    now: "2026-10-01T00:00:00.000Z",
  });

  recordScan(
    config,
    {
      candidates: [
        candidate(WALLET_A, {
          metrics: { totalPnlUsd: 1300, netRoiPct: 18, status: undefined },
        }),
      ],
    },
    { now: "2026-10-02T00:00:00.000Z" },
  );

  const entry = loadPerformance(config).wallets[WALLET_A];
  assert.equal(entry.checks.length, 1);
  assert.equal(entry.checks[0].totalPnlUsd, 1300);
  assert.equal(entry.lastCheckedAt, "2026-10-02T00:00:00.000Z");

  // Dropped to watch, then recommended again: the counter goes to 2.
  recordScan(
    config,
    {
      candidates: [
        candidate(WALLET_A, { score: { status: "watch", score: 55 } }),
      ],
    },
    { now: "2026-10-03T00:00:00.000Z" },
  );
  recordScan(config, { candidates: [candidate(WALLET_A)] }, {
    now: "2026-10-04T00:00:00.000Z",
  });

  const after = loadPerformance(config).wallets[WALLET_A];
  assert.equal(after.timesRecommended, 2);
  assert.equal(after.checks.length, 3);
});

test("recordScan keeps only the configured number of checks", () => {
  const { config } = tempConfig({ checksToKeep: 2 });
  recordScan(config, { candidates: [candidate(WALLET_A)] }, {
    now: "2026-10-01T00:00:00.000Z",
  });

  for (let day = 2; day <= 5; day += 1) {
    recordScan(config, { candidates: [candidate(WALLET_A)] }, {
      now: `2026-10-0${day}T00:00:00.000Z`,
    });
  }

  const entry = loadPerformance(config).wallets[WALLET_A];
  assert.equal(entry.checks.length, 2);
  assert.equal(entry.checks[1].at, "2026-10-05T00:00:00.000Z");
});

test("recordLiveCheck stores a live measurement", () => {
  const { config } = tempConfig();
  recordScan(config, { candidates: [candidate(WALLET_A)] }, {
    now: "2026-10-01T00:00:00.000Z",
  });

  const result = recordLiveCheck(
    config,
    candidate(WALLET_A, { metrics: { totalPnlUsd: 900, netRoiPct: 10 } }),
    { now: "2026-10-02T00:00:00.000Z" },
  );

  assert.equal(result.recorded, true);
  const entry = loadPerformance(config).wallets[WALLET_A];
  assert.equal(entry.lastSource, "live");
  assert.equal(entry.checks.at(-1).totalPnlUsd, 900);
});

test("performanceSummary computes hit rate and deltas", () => {
  const { config } = tempConfig();
  recordScan(
    config,
    { candidates: [candidate(WALLET_A), candidate(WALLET_B)] },
    { now: "2026-10-01T00:00:00.000Z" },
  );

  // A grows, B shrinks.
  recordScan(
    config,
    {
      candidates: [
        candidate(WALLET_A, { metrics: { totalPnlUsd: 1500, netRoiPct: 20 } }),
        candidate(WALLET_B, {
          score: { status: "watch", score: 50 },
          metrics: { totalPnlUsd: 700, netRoiPct: 5, openPositions: 0 },
        }),
      ],
    },
    { now: "2026-10-05T00:00:00.000Z" },
  );

  const summary = performanceSummary(loadPerformance(config), {
    now: Date.parse("2026-10-06T00:00:00.000Z"),
  });

  assert.equal(summary.tracked, 2);
  assert.equal(summary.evaluated, 2);
  assert.equal(summary.withPnl, 2);
  assert.equal(summary.hits, 1);
  assert.equal(summary.hitRatePct, 50);
  assert.equal(summary.avgPnlDeltaUsd, 100);
  assert.equal(summary.avgRoiDeltaPct, -2.5);
  assert.equal(summary.stillRecommended, 1);
  assert.equal(summary.stillRecommendedPct, 50);
  assert.equal(summary.best[0].address, WALLET_A);
  assert.equal(summary.worst[0].address, WALLET_B);
  assert.equal(summary.avgDaysTracked, 5);
});

test("performanceSummary marks wallets without follow-up as pending", () => {
  const { config } = tempConfig();
  recordScan(config, { candidates: [candidate(WALLET_A)] }, {
    now: "2026-10-01T00:00:00.000Z",
  });

  const summary = performanceSummary(loadPerformance(config), {
    now: Date.parse("2026-10-02T00:00:00.000Z"),
  });
  assert.equal(summary.tracked, 1);
  assert.equal(summary.evaluated, 0);
  assert.equal(summary.pending, 1);
});

test("performanceSummary honours the day horizon", () => {
  const { config } = tempConfig();
  recordScan(config, { candidates: [candidate(WALLET_A)] }, {
    now: "2026-09-01T00:00:00.000Z",
  });
  recordScan(config, { candidates: [candidate(WALLET_B)] }, {
    now: "2026-10-01T00:00:00.000Z",
  });

  const summary = performanceSummary(loadPerformance(config), {
    now: Date.parse("2026-10-02T00:00:00.000Z"),
    horizonDays: 7,
  });
  assert.equal(summary.tracked, 1);
  assert.equal(summary.horizonDays, 7);
});

test("formatPerformanceReport handles empty and populated summaries", () => {
  const empty = formatPerformanceReport(
    performanceSummary({ wallets: {} }, { now: Date.now() }),
  );
  assert.match(empty, /No recommendations tracked yet/);

  const { config } = tempConfig();
  recordScan(config, { candidates: [candidate(WALLET_A)] }, {
    now: "2026-10-01T00:00:00.000Z",
  });
  const pending = formatPerformanceReport(
    performanceSummary(loadPerformance(config), { now: Date.now() }),
  );
  assert.match(pending, /Tracked: <b>1<\/b>/);
  assert.match(pending, /No follow-up data yet/);

  recordScan(
    config,
    { candidates: [candidate(WALLET_A, { metrics: { totalPnlUsd: 1400 } })] },
    { now: "2026-10-03T00:00:00.000Z" },
  );
  const report = formatPerformanceReport(
    performanceSummary(loadPerformance(config), {
      now: Date.parse("2026-10-04T00:00:00.000Z"),
    }),
  );
  assert.match(report, /Hit rate: <b>100%<\/b>/);
  assert.match(report, /Avg PnL change: <b>\+\$400<\/b>/);
  assert.match(report, /Best since recommendation/);
});

test("staleWallets returns the oldest measurements first", () => {
  const { config } = tempConfig();
  const perf = {
    version: 1,
    updatedAt: null,
    wallets: {
      [WALLET_A]: {
        address: WALLET_A,
        recommendedAt: "2026-10-01T00:00:00.000Z",
        lastCheckedAt: "2026-10-05T00:00:00.000Z",
        checks: [],
      },
      [WALLET_B]: {
        address: WALLET_B,
        recommendedAt: "2026-10-03T00:00:00.000Z",
        lastCheckedAt: "2026-10-03T00:00:00.000Z",
        checks: [],
      },
    },
  };
  savePerformance(config, perf);

  const stale = staleWallets(loadPerformance(config), {
    now: Date.parse("2026-10-06T00:00:00.000Z"),
    staleHours: 24,
  });
  assert.deepEqual(stale, [WALLET_B, WALLET_A]);

  const fresh = staleWallets(loadPerformance(config), {
    now: Date.parse("2026-10-06T00:00:00.000Z"),
    staleHours: 24,
    limit: 1,
  });
  assert.deepEqual(fresh, [WALLET_B]);
});
