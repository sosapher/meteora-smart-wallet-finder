import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, deepMerge } from "../src/config.js";
import {
  buildExportPayload,
  mergeIntoMeridian,
  selectExportCandidates,
  writeExports,
} from "../src/output.js";

function baseConfig(overrides = {}) {
  return deepMerge(DEFAULT_CONFIG, overrides);
}

function candidate(address, score, status = "recommended", overrides = {}) {
  return {
    address,
    short: `${address.slice(0, 6)}...${address.slice(-4)}`,
    score: {
      score,
      tier: score >= 85 ? "S" : score >= 75 ? "A" : "B",
      status,
      warnings: overrides.warnings ?? [],
    },
    metrics: {
      n: overrides.n ?? 12,
      winRatePct: 78,
      feeYieldPct: 6,
      netRoiPct: 12,
      profitFactor: 4,
      avgHoldHours: 8,
      medianWidthBins: 40,
      poolCount: 2,
      daysSinceActive: 0,
      openPositions: 1,
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meteora-wallet-finder-"));
}

const WALLET_A = "7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK";
const WALLET_B = "28F7nEtbmHJbAZkDH6U6LYNvWrXksDSoGUhhrdvyTs6L";
const WALLET_C = "13ir3HLG7vUBidTNHY23Xdkeh6hte5z4QKqByPpJdEvs";

test("selects only recommended candidates above the score threshold", () => {
  const config = baseConfig({ export: { minScore: 75, maxWallets: 10 } });
  const selected = selectExportCandidates(
    [
      candidate(WALLET_A, 86, "recommended"),
      candidate(WALLET_B, 76, "watch"),
      candidate(WALLET_C, 74, "recommended"),
    ],
    config,
  );

  assert.deepEqual(selected.map((entry) => entry.address), [WALLET_A]);
});

test("builds Meridian-compatible entries with metadata kept separate", () => {
  const config = baseConfig({
    export: { namePrefix: "auto", category: "smart", type: "lp" },
  });
  const { wallets, detailed } = buildExportPayload(
    [candidate(WALLET_A, 86)],
    config,
  );

  assert.equal(wallets.length, 1);
  assert.deepEqual(Object.keys(wallets[0]).sort(), [
    "addedAt",
    "address",
    "category",
    "name",
    "type",
  ]);
  assert.equal(wallets[0].address, WALLET_A);
  assert.equal(wallets[0].name, `auto-${WALLET_A.slice(0, 6)}`);
  assert.equal(wallets[0].category, "smart");
  assert.equal(wallets[0].type, "lp");
  assert.ok(wallets[0].addedAt);

  assert.equal(detailed.length, 1);
  assert.equal(detailed[0]._meta.score, 86);
  assert.equal(detailed[0]._meta.closedPositions, 12);
});

test("excludes existing addresses and avoids duplicate names", () => {
  const config = baseConfig();
  const existing = {
    wallets: [
      {
        name: `auto-${WALLET_A.slice(0, 6)}`,
        address: WALLET_A,
        category: "existing",
        type: "lp",
      },
    ],
  };

  const { wallets } = buildExportPayload(
    [candidate(WALLET_A, 90), candidate(WALLET_B, 80)],
    config,
    existing,
  );

  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].address, WALLET_B);
  assert.notEqual(wallets[0].name, `auto-${WALLET_A.slice(0, 6)}`);
});

test("can include existing addresses when excludeExisting is disabled", () => {
  const config = baseConfig({ export: { excludeExisting: false } });
  const existing = {
    wallets: [
      {
        name: "genesis",
        address: WALLET_A,
        category: "smart",
        type: "lp",
      },
    ],
  };

  const { wallets } = buildExportPayload(
    [candidate(WALLET_A, 90)],
    config,
    existing,
  );

  assert.equal(wallets.length, 1);
  assert.notEqual(wallets[0].name, "genesis");
});

test("writes JSON, snippet and markdown exports", () => {
  const dir = tempDir();
  const config = baseConfig({
    paths: { exportDir: path.join(dir, "exports") },
    export: {
      meridianSmartWalletsPath: path.join(dir, "smart-wallets.json"),
      writeMarkdown: true,
    },
  });
  fs.mkdirSync(config.paths.exportDir, { recursive: true });

  const result = writeExports(
    { candidates: [candidate(WALLET_A, 88)] },
    config,
  );

  assert.equal(result.exported, 1);
  assert.ok(fs.existsSync(result.paths.jsonPath));
  assert.ok(fs.existsSync(result.paths.snippetPath));
  assert.ok(fs.existsSync(result.paths.markdownPath));

  const snippet = JSON.parse(fs.readFileSync(result.paths.snippetPath, "utf8"));
  assert.equal(snippet[0].address, WALLET_A);
  assert.equal(snippet[0]._meta, undefined);

  const markdown = fs.readFileSync(result.paths.markdownPath, "utf8");
  assert.match(markdown, /Recommended Meteora smart wallets/);
  assert.match(markdown, new RegExp(WALLET_A));
});

test("merges new wallets, skips duplicates and creates a backup", () => {
  const dir = tempDir();
  const target = path.join(dir, "smart-wallets.json");
  const original = {
    wallets: [
      {
        name: "genesis",
        address: WALLET_A,
        category: "smart",
        type: "lp",
      },
    ],
  };
  fs.writeFileSync(target, `${JSON.stringify(original, null, 2)}\n`, "utf8");

  const config = baseConfig({
    export: {
      meridianSmartWalletsPath: target,
      category: "smart",
      type: "lp",
    },
  });

  const result = mergeIntoMeridian(
    [
      { name: "auto-dupe", address: WALLET_A, category: "smart", type: "lp" },
      { name: "auto-new", address: WALLET_B, category: "smart", type: "lp" },
    ],
    config,
  );

  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.ok(result.backupPath);
  assert.ok(fs.existsSync(result.backupPath));

  const merged = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(merged.wallets.length, 2);
  assert.equal(merged.wallets[0].name, "genesis");
  assert.equal(merged.wallets[1].address, WALLET_B);
});

test("creates the Meridian file when it does not exist yet", () => {
  const dir = tempDir();
  const target = path.join(dir, "smart-wallets.json");
  const config = baseConfig({
    export: { meridianSmartWalletsPath: target },
  });

  const result = mergeIntoMeridian(
    [{ name: "auto-a", address: WALLET_A, category: "smart", type: "lp" }],
    config,
  );

  assert.equal(result.added, 1);
  const merged = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(
    merged.wallets.map((wallet) => wallet.address),
    [WALLET_A],
  );
});
