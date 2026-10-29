import test from "node:test";
import assert from "node:assert/strict";
import {
  clusterCandidates,
  formatClusterReport,
  formatDiversityPreview,
  selectDiverse,
} from "../src/clusters.js";

const FUNDER_A = "6nKGfqzWjXKLdfcBLivx4Y2YwSANYfsHtFQ3b5Ck3bo9";
const FUNDER_B = "DMnanMNSwgm3s8yN5n7QjFTm4nDfVjuMJvaAv6biWYd6";
const POOL_1 = "4HTy7aTjPm5PTSEws2yWRDPX6gjWM6sC2dV5mv9u8JsH";
const POOL_2 = "CoqYNCGKpiGgLJJ6DntdbcvKmqTZBrxdvQDrxDCfb9GH";

function wallet(address, { score = 80, status = "recommended", funder = null, fundedAt = null, funderType = "wallet", pools = [POOL_1] } = {}) {
  return {
    address,
    short: `${address.slice(0, 6)}...`,
    score: { score, status, tier: "A" },
    metrics: {
      n: 20,
      poolBreakdown: pools.map((pool) => ({ pool })),
      hygiene: {
        enabled: true,
        funder,
        fundedAt,
        funderType,
      },
    },
    poolsChecked: pools.map((pool) => ({ address: pool, name: pool.slice(0, 4) })),
  };
}

const A1 = "7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK";
const A2 = "2KmmUnQ6nscD7j6siUjZMbDoT1u6jnjfZWF386CcRjak";
const A3 = "28539zFvJd4vJ7oXkZkPz5jCk1oLkQ8zWq4mJ8bYQabCM";
const B1 = "8tsAvhYhLQ4nZ1oQmJ7pQe9wVd3zK2sN6tR5uW8xY3abC";

test("clusterCandidates groups wallets by shared funder", () => {
  const analysis = clusterCandidates([
    wallet(A1, { funder: FUNDER_A }),
    wallet(A2, { funder: FUNDER_A }),
    wallet(B1, { funder: FUNDER_B }),
  ]);

  assert.equal(analysis.analyzed, 3);
  assert.equal(analysis.clusters.length, 1);
  assert.equal(analysis.clusters[0].size, 2);
  assert.equal(analysis.clusters[0].funder, FUNDER_A);
  assert.equal(analysis.clusters[0].sharedPools.length, 1);
  assert.equal(analysis.byAddress[A1], analysis.byAddress[A2]);
  assert.notEqual(analysis.byAddress[A1], analysis.byAddress[B1]);
  assert.equal(analysis.clusterOf(A1).size, 2);
  assert.equal(analysis.clusterOf(B1).isCluster, false);
});

test("clusterCandidates ignores program funders", () => {
  const analysis = clusterCandidates([
    wallet(A1, { funder: FUNDER_A, funderType: "program" }),
    wallet(A2, { funder: FUNDER_A, funderType: "program" }),
  ]);
  assert.equal(analysis.clusters.length, 0);
});

test("clusterCandidates links same funding moment only with a shared pool", () => {
  const at = "2026-10-20T02:49:41.000Z";
  const linked = clusterCandidates(
    [
      wallet(A1, { fundedAt: at, pools: [POOL_1] }),
      wallet(A2, { fundedAt: at, pools: [POOL_1, POOL_2] }),
    ],
    { fundingWindowMinutes: 1 },
  );
  assert.equal(linked.clusters.length, 1);

  const differentPool = clusterCandidates(
    [
      wallet(A1, { fundedAt: at, pools: [POOL_1] }),
      wallet(A2, { fundedAt: at, pools: [POOL_2] }),
    ],
    { fundingWindowMinutes: 1 },
  );
  assert.equal(differentPool.clusters.length, 0);

  const disabled = clusterCandidates(
    [
      wallet(A1, { fundedAt: at, pools: [POOL_1] }),
      wallet(A2, { fundedAt: at, pools: [POOL_1] }),
    ],
    { fundingWindowMinutes: 0 },
  );
  assert.equal(disabled.clusters.length, 0);
});

test("selectDiverse caps wallets per cluster", () => {
  const candidates = [
    wallet(A1, { score: 95, funder: FUNDER_A }),
    wallet(A2, { score: 94, funder: FUNDER_A }),
    wallet(A3, { score: 93, funder: FUNDER_A }),
    wallet(B1, { score: 70, funder: FUNDER_B }),
  ];
  const analysis = clusterCandidates(candidates);
  const { selected, skipped } = selectDiverse(candidates, analysis, {
    maxPerCluster: 2,
    maxPerPool: 0,
  });

  assert.deepEqual(
    selected.map((item) => item.address),
    [A1, A2, B1],
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].address, A3);
  assert.equal(skipped[0].reason, "cluster");
});

test("selectDiverse caps wallets per pool", () => {
  const candidates = [
    wallet(A1, { score: 95, pools: [POOL_1] }),
    wallet(A2, { score: 94, pools: [POOL_1] }),
    wallet(A3, { score: 93, pools: [POOL_1] }),
    wallet(B1, { score: 60, pools: [POOL_2] }),
  ];
  const analysis = clusterCandidates(candidates);
  const { selected, skipped } = selectDiverse(candidates, analysis, {
    maxPerCluster: 0,
    maxPerPool: 2,
  });

  assert.deepEqual(
    selected.map((item) => item.address),
    [A1, A2, B1],
  );
  assert.equal(skipped[0].reason, "pool");
});

test("selectDiverse keeps a wallet when only some of its pools are full", () => {
  const candidates = [
    wallet(A1, { score: 95, pools: [POOL_1] }),
    wallet(A2, { score: 94, pools: [POOL_1] }),
    wallet(B1, { score: 93, pools: [POOL_1, POOL_2] }),
  ];
  const analysis = clusterCandidates(candidates);
  const { selected } = selectDiverse(candidates, analysis, {
    maxPerCluster: 0,
    maxPerPool: 2,
  });
  assert.deepEqual(
    selected.map((item) => item.address),
    [A1, A2, B1],
  );
});

test("selectDiverse honours the wallet limit", () => {
  const candidates = [
    wallet(A1, { score: 95 }),
    wallet(A2, { score: 94 }),
    wallet(B1, { score: 93 }),
  ];
  const analysis = clusterCandidates(candidates);
  const { selected, skipped } = selectDiverse(candidates, analysis, {
    maxPerCluster: 0,
    maxPerPool: 0,
    limit: 2,
  });
  assert.equal(selected.length, 2);
  assert.equal(skipped[0].reason, "limit");
});

test("formatClusterReport renders groups and handles empty input", () => {
  assert.match(formatClusterReport(null), /No scan data yet/);

  const none = clusterCandidates([wallet(A1), wallet(B1)]);
  assert.match(formatClusterReport(none), /look independent/);

  const analysis = clusterCandidates([
    wallet(A1, { funder: FUNDER_A }),
    wallet(A2, { funder: FUNDER_A }),
  ]);
  const text = formatClusterReport(analysis, {
    poolNames: { [POOL_1]: "OPENAI-USDC" },
  });
  assert.match(text, /clusters: <b>1<\/b>/);
  assert.match(text, /<b>c1<\/b> — 2 wallets/);
  assert.match(text, /OPENAI-USDC/);
});

test("formatDiversityPreview counts skipped wallets by reason", () => {
  const text = formatDiversityPreview({
    selected: [wallet(A1)],
    skipped: [
      { address: A2, reason: "cluster" },
      { address: A3, reason: "pool" },
    ],
  });
  assert.match(text, /1 wallet\(s\) kept/);
  assert.match(text, /Dropped: 2 \(cluster 1, pool 1, limit 0\)/);

  const clean = formatDiversityPreview({ selected: [], skipped: [] });
  assert.match(clean, /No wallet was dropped/);
});
