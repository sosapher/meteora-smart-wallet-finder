import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadState, updateState } from "../src/state.js";

const WALLET_A = "7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK";
const WALLET_B = "28F7nEtbmHJbAZkDH6U6LYNvWrXksDSoGUhhrdvyTs6L";

function config(alertScoreDelta = 5) {
  return { watch: { alertScoreDelta } };
}

function candidate(address, score, status = "recommended") {
  return {
    address,
    short: address.slice(0, 6),
    score: {
      score,
      tier: score >= 85 ? "S" : score >= 75 ? "A" : "B",
      status,
      reasons: ["12 closed positions"],
      warnings: [],
    },
    pools: [{ address: "pool-1", name: "BTC-SOL" }],
  };
}

function tempStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meteora-state-"));
  return path.join(dir, "state.json");
}

test("first run records wallets and reports them as new", () => {
  const statePath = tempStatePath();
  const result = updateState(
    statePath,
    [candidate(WALLET_A, 80)],
    { generatedAt: "2026-10-26T09:00:00.000Z", recommended: 1 },
    config(),
  );

  assert.equal(result.firstRun, true);
  assert.equal(result.newCandidates.length, 1);
  assert.equal(result.state.wallets[WALLET_A].lastScore, 80);
  assert.equal(result.state.lastScanAt, "2026-10-26T09:00:00.000Z");
  assert.ok(fs.existsSync(statePath));
});

test("unchanged wallets are not reported again", () => {
  const statePath = tempStatePath();
  updateState(statePath, [candidate(WALLET_A, 80)], {}, config());
  const second = updateState(
    statePath,
    [candidate(WALLET_A, 80)],
    { generatedAt: "2026-10-26T09:30:00.000Z" },
    config(),
  );

  assert.equal(second.firstRun, false);
  assert.equal(second.newCandidates.length, 0);
  assert.equal(second.state.wallets[WALLET_A].bestScore, 80);
});

test("score improvements above the delta trigger an alert", () => {
  const statePath = tempStatePath();
  updateState(statePath, [candidate(WALLET_A, 78)], {}, config(5));
  const below = updateState(
    statePath,
    [candidate(WALLET_A, 81)],
    {},
    config(5),
  );
  assert.equal(below.newCandidates.length, 0);

  const above = updateState(
    statePath,
    [candidate(WALLET_A, 86)],
    {},
    config(5),
  );
  assert.equal(above.newCandidates.length, 1);
  assert.equal(above.state.wallets[WALLET_A].bestScore, 86);
});

test("a wallet promoted from watch to recommended triggers an alert", () => {
  const statePath = tempStatePath();
  updateState(statePath, [candidate(WALLET_A, 70, "watch")], {}, config());
  const promoted = updateState(
    statePath,
    [candidate(WALLET_A, 76, "recommended")],
    {},
    config(),
  );

  assert.equal(promoted.newCandidates.length, 1);
  assert.equal(promoted.state.wallets[WALLET_A].status, "recommended");
});

test("tracks multiple wallets independently", () => {
  const statePath = tempStatePath();
  const result = updateState(
    statePath,
    [
      candidate(WALLET_A, 80),
      candidate(WALLET_B, 90, "watch"),
    ],
    {},
    config(),
  );

  assert.equal(result.newCandidates.length, 1);
  assert.equal(result.newCandidates[0].address, WALLET_A);
  assert.equal(Object.keys(result.state.wallets).length, 2);
  assert.equal(result.state.wallets[WALLET_B].status, "watch");
});

test("recovers from a corrupt state file", () => {
  const statePath = tempStatePath();
  fs.writeFileSync(statePath, "{not valid json", "utf8");

  const loaded = loadState(statePath);
  assert.equal(loaded.lastScanAt, null);
  assert.deepEqual(loaded.wallets, {});

  const result = updateState(statePath, [candidate(WALLET_A, 80)], {}, config());
  assert.equal(result.firstRun, true);
  assert.equal(result.newCandidates.length, 1);
});
