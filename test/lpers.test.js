import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, deepMerge } from "../src/config.js";
import {
  aggregateCandidates,
  isSolanaAddress,
  normalizeStudyFallback,
} from "../src/lpers.js";

const WALLET_A = "7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK";
const WALLET_B = "28F7nEtbmHJbAZkDH6U6LYNvWrXksDSoGUhhrdvyTs6L";
const WALLET_C = "13ir3HLG7vUBidTNHY23Xdkeh6hte5z4QKqByPpJdEvs";
const POOL_1 = "2tFYCTqYJ2pyrb7CeA824o2Ybq3jq7agvr3Qpv2uVDmL";
const POOL_2 = "zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX";

function baseConfig(overrides = {}) {
  return deepMerge(DEFAULT_CONFIG, overrides);
}

function lper(owner, overrides = {}) {
  return {
    owner,
    ownerShort: `${owner.slice(0, 6)}...`,
    totalInflowUsd: overrides.totalInflowUsd ?? 10_000,
    totalFeeUsd: overrides.totalFeeUsd ?? 1_000,
    totalPnlUsd: overrides.totalPnlUsd ?? 1_500,
    feePercent: overrides.feePercent ?? 10,
    pnlPerInflowPct: overrides.pnlPerInflowPct ?? 15,
    winRatePct: overrides.winRatePct ?? 70,
    avgAgeHours: overrides.avgAgeHours ?? 8,
    firstActivity: "2026-10-01T00:00:00.000Z",
    lastActivity: overrides.lastActivity ?? new Date().toISOString(),
    source: overrides.source ?? "top-lp",
  };
}

function poolResult(address, name, lpers) {
  return {
    pool: { address, name, discoveryScore: 30 },
    lpers,
    historicalOwners: [],
    source: "top-lp",
  };
}

test("validates Solana wallet addresses", () => {
  assert.equal(isSolanaAddress(WALLET_A), true);
  assert.equal(isSolanaAddress("not-a-wallet"), false);
  assert.equal(isSolanaAddress(""), false);
});

test("aggregates a wallet seen in multiple pools", () => {
  const result = aggregateCandidates(
    [
      poolResult(POOL_1, "BTC-SOL", [lper(WALLET_A), lper(WALLET_B)]),
      poolResult(POOL_2, "STONK-SOL", [lper(WALLET_A)]),
    ],
    baseConfig({ discovery: { deepCheckTop: 10 } }),
  );

  assert.equal(result.all.length, 2);
  const walletA = result.all.find((entry) => entry.address === WALLET_A);
  assert.equal(walletA.appearances, 2);
  assert.equal(walletA.pools.length, 2);
  assert.ok(walletA.prelimReasons.includes("top LPer in 2 pools"));
  assert.equal(walletA.sources[0], "top-lp");
  assert.equal(result.meta.candidatesFound, 2);
  assert.equal(result.meta.multiPoolCandidates, 1);
});

test("uses percentage fallback when inflow data is missing", () => {
  const result = aggregateCandidates(
    [
      poolResult(POOL_1, "BTC-SOL", [
        lper(WALLET_A, {
          totalInflowUsd: 0,
          totalFeeUsd: 0,
          totalPnlUsd: 0,
          feePercent: 12,
          pnlPerInflowPct: 14,
          source: "study-top-lp",
        }),
      ]),
    ],
    baseConfig(),
  );

  const entry = result.all[0];
  assert.equal(entry.topLperFeePercent, 12);
  assert.equal(entry.topLperNetRoiPct, 14);
  assert.ok(entry.prelimScore > 0);
});

test("skips existing, excluded and program addresses", () => {
  const result = aggregateCandidates(
    [
      poolResult(POOL_1, "BTC-SOL", [
        lper(WALLET_A),
        lper(WALLET_B),
        lper(WALLET_C),
        lper("11111111111111111111111111111111"),
      ]),
    ],
    baseConfig(),
    {
      existingAddresses: new Set([WALLET_A]),
      excludeAddresses: new Set([WALLET_B]),
    },
  );

  assert.deepEqual(
    result.all.map((entry) => entry.address),
    [WALLET_C],
  );
});

test("normalizes study-top-lp fallback data", () => {
  const normalized = normalizeStudyFallback(
    {
      topWinnersByPct: [
        {
          owner: WALLET_A,
          pnlPct: 12,
          feePercent: 8,
          winRatePct: 70,
          pnlUsd: 100,
        },
      ],
      topHistoricalOwners: [
        {
          owner: WALLET_B,
          avgPnlPct: 20,
          avgFeePercent: 5,
          avgHoldHours: 6,
          avgWidthBins: 40,
          preferredStrategy: "bid_ask",
          preferredRangeStyle: "wide",
        },
      ],
    },
    { address: POOL_1, name: "BTC-SOL" },
  );

  assert.equal(normalized.lpers.length, 2);
  const winner = normalized.lpers.find((entry) => entry.owner === WALLET_A);
  assert.equal(winner.totalPnlUsd, 100);
  assert.equal(winner.pnlPerInflowPct, 12);
  assert.equal(winner.feePercent, 8);
  assert.equal(winner.winRatePct, 70);
  assert.equal(winner.source, "study-top-lp");

  const historical = normalized.lpers.find((entry) => entry.owner === WALLET_B);
  assert.equal(historical.pnlPerInflowPct, 20);
  assert.equal(historical.feePercent, 5);
  assert.equal(historical.avgAgeHours, 6);
  assert.equal(historical.preferredStrategy, "bid_ask");
  assert.equal(historical.avgWidthBins, 40);
  assert.equal(normalized.historicalOwners.length, 1);
});

test("deep-checks top candidates and keeps extra multi-pool wallets", () => {
  const highScoreWallet = WALLET_A.slice(0, -1) + "1";
  const result = aggregateCandidates(
    [
      poolResult(POOL_1, "BTC-SOL", [
        lper(highScoreWallet, {
          totalFeeUsd: 5_000,
          totalPnlUsd: 6_000,
        }),
        lper(WALLET_B, { totalFeeUsd: 100, totalPnlUsd: 120 }),
      ]),
      poolResult(POOL_2, "STONK-SOL", [
        lper(WALLET_B, { totalFeeUsd: 100, totalPnlUsd: 120 }),
      ]),
    ],
    baseConfig({ discovery: { deepCheckTop: 1 } }),
  );

  const selected = result.selected.map((entry) => entry.address);
  assert.equal(selected.length, 2);
  assert.equal(selected[0], highScoreWallet);
  assert.ok(selected.includes(WALLET_B));
  assert.equal(
    result.selected.find((entry) => entry.address === WALLET_B).appearances,
    2,
  );
});
