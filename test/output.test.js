import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, deepMerge } from "../src/config.js";
import {
  buildAllWalletsText,
  buildExportPayload,
  buildGmgnPayload,
  buildSmartWalletText,
  GMGN_MAX_WALLETS,
  mergeIntoMeridian,
  selectExportCandidates,
  selectGmgnCandidates,
  writeAllWalletsText,
  writeExports,
  writeSmartWalletText,
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

test("builds a ranked plain-text smart wallet export", () => {
  const config = baseConfig({ export: { minScore: 75, maxWallets: 10 } });
  const text = buildSmartWalletText(
    [
      candidate(WALLET_A, 86),
      candidate(WALLET_B, 92),
      candidate(WALLET_C, 76, "watch"),
    ],
    config,
    { generatedAt: "2026-10-28T00:00:00.000Z", source: "unit-test" },
  );

  assert.match(text, /^# Meteora Smart Wallets/);
  assert.match(text, /# Count: 2/);
  assert.match(text, /Sorted by score, best first/);
  assert.ok(text.includes(WALLET_A));
  assert.ok(text.includes(WALLET_B));
  assert.ok(!text.includes(WALLET_C));
  assert.ok(
    text.indexOf(WALLET_B) < text.indexOf(WALLET_A),
    "higher score should be listed first",
  );
  assert.match(text, /Read-only research, not financial advice/);
});

test("handles an empty smart wallet text export", () => {
  const config = baseConfig({ export: { minScore: 90 } });
  const text = buildSmartWalletText([candidate(WALLET_A, 80)], config);

  assert.match(text, /# Count: 0/);
  assert.match(text, /No smart wallets matched/);
  assert.ok(!text.includes(WALLET_A));
});

test("writes the ranked smart wallet text file", () => {
  const dir = tempDir();
  const config = baseConfig({
    paths: {
      dataDir: path.join(dir, "data"),
      exportDir: path.join(dir, "exports"),
    },
    export: { minScore: 75, maxWallets: 10 },
  });

  const result = writeSmartWalletText(
    [candidate(WALLET_A, 80), candidate(WALLET_B, 90)],
    config,
  );

  assert.equal(result.count, 2);
  assert.ok(fs.existsSync(result.path));
  assert.match(path.basename(result.path), /\.txt$/);
  assert.equal(fs.readFileSync(result.path, "utf8"), result.text);
  assert.ok(result.text.indexOf(WALLET_B) < result.text.indexOf(WALLET_A));
});

test("builds an unfiltered all-wallets export ranked by tier", () => {
  const wallets = [
    {
      address: WALLET_C,
      lastTier: "B",
      lastScore: 80,
      bestScore: 90,
      status: "watch",
      pools: [{ address: "p1" }, { address: "p2" }],
      lastSeen: "2026-10-28T02:00:00.000Z",
    },
    {
      address: WALLET_A,
      lastTier: "S",
      lastScore: 70,
      bestScore: 75,
      status: "recommended",
      pools: [{ address: "p1" }],
      lastSeen: "2026-10-28T02:00:00.000Z",
    },
    {
      address: WALLET_B,
      lastTier: "S",
      lastScore: 88,
      bestScore: 88,
      status: "recommended",
      pools: [{ address: "p1" }],
      lastSeen: "2026-10-28T02:00:00.000Z",
    },
    {
      address: "D".repeat(44),
      lastTier: "D",
      lastScore: 40,
      bestScore: 45,
      status: "rejected",
      pools: [],
      lastSeen: "2026-10-27T02:00:00.000Z",
    },
  ];

  const text = buildAllWalletsText(wallets, {
    generatedAt: "2026-10-28T03:00:00.000Z",
    source: "unit-test",
    scanAt: "2026-10-28T02:37:45.620Z",
  });

  assert.match(text, /^# Meteora All Wallets/);
  assert.match(text, /# Wallets: 4/);
  assert.match(text, /Sorted by tier \(S best\), then score/);
  assert.ok(text.includes("rejected"));
  assert.ok(text.includes(WALLET_A));
  assert.ok(text.includes(WALLET_C));

  const order = [WALLET_B, WALLET_A, WALLET_C, "D".repeat(44)].map((address) =>
    text.indexOf(address),
  );
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("writes the unfiltered all-wallets text file", () => {
  const dir = tempDir();
  const config = baseConfig({
    paths: {
      dataDir: path.join(dir, "data"),
      exportDir: path.join(dir, "exports"),
    },
  });
  const wallets = [
    {
      address: WALLET_A,
      lastTier: "S",
      lastScore: 88,
      bestScore: 90,
      status: "recommended",
      pools: [],
      lastSeen: "2026-10-28T02:00:00.000Z",
    },
  ];

  const result = writeAllWalletsText(wallets, config, { source: "unit-test" });

  assert.equal(result.count, 1);
  assert.equal(path.basename(result.path), "all-wallets.txt");
  assert.ok(fs.existsSync(result.path));
  assert.equal(fs.readFileSync(result.path, "utf8"), result.text);
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
    paths: {
      dataDir: path.join(dir, "data"),
      exportDir: path.join(dir, "exports"),
    },
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
  assert.ok(fs.existsSync(result.paths.gmgnPath));

  const snippet = JSON.parse(fs.readFileSync(result.paths.snippetPath, "utf8"));
  assert.equal(snippet[0].address, WALLET_A);
  assert.equal(snippet[0]._meta, undefined);

  const gmgn = JSON.parse(fs.readFileSync(result.paths.gmgnPath, "utf8"));
  assert.deepEqual(gmgn, [
    {
      address: WALLET_A,
      name: "meteora-7Weigv",
      emoji: "🔥",
    },
  ]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.paths.gmgnNewPath, "utf8")),
    gmgn,
  );
  assert.ok(fs.existsSync(result.paths.gmgnLedgerPath));

  const markdown = fs.readFileSync(result.paths.markdownPath, "utf8");
  assert.match(markdown, /Recommended Meteora smart wallets/);
  assert.match(markdown, new RegExp(WALLET_A));
  assert.match(markdown, /GMGN import/);
});

test("builds GMGN import entries with unique names and tier emojis", () => {
  const config = baseConfig({ export: { gmgn: { namePrefix: "meteora" } } });
  const samePrefix = "7WeigvZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

  const payload = buildGmgnPayload(
    [
      candidate(WALLET_A, 90),
      candidate(samePrefix, 90),
      candidate(WALLET_B, 82),
      candidate(WALLET_C, 70),
    ],
    config,
  );

  assert.deepEqual(Object.keys(payload[0]), ["address", "name", "emoji"]);
  assert.equal(payload[0].name, "meteora-7Weigv");
  assert.equal(payload[1].name, "meteora-7Weigv-2");
  assert.notEqual(payload[0].name, payload[1].name);
  assert.equal(payload[0].emoji, "🔥");
  assert.equal(payload[2].emoji, "⭐");
  assert.equal(payload[3].emoji, "👀");
});

test("selects GMGN wallets independently from Meridian", () => {
  const config = baseConfig({
    export: {
      maxWallets: 1,
      minScore: 75,
      gmgn: { maxWallets: 3, minScore: 70 },
    },
  });
  const candidates = [
    candidate(WALLET_A, 88),
    candidate(WALLET_B, 78),
    candidate(WALLET_C, 72),
  ];

  assert.equal(selectExportCandidates(candidates, config).length, 1);
  assert.deepEqual(
    selectGmgnCandidates(candidates, config).map((entry) => entry.address),
    [WALLET_A, WALLET_B, WALLET_C],
  );
});

test("caps GMGN exports at 2000 wallets", () => {
  const config = baseConfig({
    export: { gmgn: { maxWallets: 5000 } },
  });
  const candidates = Array.from({ length: GMGN_MAX_WALLETS + 25 }, (_, index) => {
    const address = `W${String(index).padStart(5, "0")}${"x".repeat(38)}`;
    return candidate(address, 90);
  });

  const payload = buildGmgnPayload(
    selectGmgnCandidates(candidates, config),
    config,
  );
  assert.equal(payload.length, GMGN_MAX_WALLETS);
  assert.equal(new Set(payload.map((entry) => entry.name)).size, GMGN_MAX_WALLETS);
});

test("writes an empty GMGN file when nothing qualifies", () => {
  const dir = tempDir();
  const config = baseConfig({
    paths: {
      dataDir: path.join(dir, "data"),
      exportDir: path.join(dir, "exports"),
    },
    export: {
      meridianSmartWalletsPath: path.join(dir, "smart-wallets.json"),
      writeMarkdown: true,
    },
  });
  fs.mkdirSync(config.paths.exportDir, { recursive: true });

  const result = writeExports({ candidates: [] }, config);

  assert.equal(result.exported, 0);
  assert.deepEqual(result.gmgnWallets, []);
  assert.deepEqual(result.gmgnNewWallets, []);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.paths.gmgnPath, "utf8")),
    [],
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.paths.gmgnNewPath, "utf8")),
    [],
  );
});

test("writes only new GMGN wallets and keeps names stable", () => {
  const dir = tempDir();
  const config = baseConfig({
    paths: {
      dataDir: path.join(dir, "data"),
      exportDir: path.join(dir, "exports"),
    },
    export: {
      meridianSmartWalletsPath: path.join(dir, "smart-wallets.json"),
      gmgn: { incremental: true },
    },
  });
  fs.mkdirSync(config.paths.exportDir, { recursive: true });

  const first = writeExports(
    { candidates: [candidate(WALLET_A, 80)] },
    config,
  );
  assert.equal(first.gmgnWallets.length, 1);
  assert.equal(first.gmgnNewWallets.length, 1);
  assert.equal(first.gmgnWallets[0].name, "meteora-7Weigv");
  assert.equal(first.gmgnWallets[0].emoji, "⭐");

  const second = writeExports(
    { candidates: [candidate(WALLET_A, 92)] },
    config,
  );
  assert.equal(second.gmgnNewWallets.length, 0);
  assert.equal(second.gmgnWallets[0].name, "meteora-7Weigv");
  assert.equal(second.gmgnWallets[0].emoji, "🔥");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(second.paths.gmgnNewPath, "utf8")),
    [],
  );

  const third = writeExports(
    {
      candidates: [
        candidate(WALLET_A, 92),
        candidate(WALLET_B, 86),
      ],
    },
    config,
  );
  assert.equal(third.gmgnWallets.length, 2);
  assert.equal(third.gmgnNewWallets.length, 1);
  assert.equal(third.gmgnNewWallets[0].address, WALLET_B);

  const ledger = JSON.parse(
    fs.readFileSync(third.paths.gmgnLedgerPath, "utf8"),
  );
  assert.equal(ledger.wallets[WALLET_A].name, "meteora-7Weigv");
  assert.equal(ledger.wallets[WALLET_B].name, "meteora-28F7nE");
});

test("dry run computes exports without writing files", () => {
  const dir = tempDir();
  const config = baseConfig({
    paths: {
      dataDir: path.join(dir, "data"),
      exportDir: path.join(dir, "exports"),
    },
    export: {
      meridianSmartWalletsPath: path.join(dir, "smart-wallets.json"),
    },
  });
  fs.mkdirSync(config.paths.exportDir, { recursive: true });

  const result = writeExports(
    { candidates: [candidate(WALLET_A, 88)] },
    config,
    null,
    { dryRun: true },
  );

  assert.equal(result.dryRun, true);
  assert.equal(result.wallets.length, 1);
  assert.equal(result.gmgnWallets.length, 1);
  assert.equal(result.gmgnNewWallets.length, 1);
  assert.ok(!fs.existsSync(result.paths.jsonPath));
  assert.ok(!fs.existsSync(result.paths.gmgnPath));
  assert.ok(!fs.existsSync(result.paths.gmgnNewPath));
  assert.ok(!fs.existsSync(result.paths.gmgnLedgerPath));
});

test("gmgn-only skips Meridian files", () => {
  const dir = tempDir();
  const config = baseConfig({
    paths: {
      dataDir: path.join(dir, "data"),
      exportDir: path.join(dir, "exports"),
    },
    export: {
      meridianSmartWalletsPath: path.join(dir, "smart-wallets.json"),
    },
  });
  fs.mkdirSync(config.paths.exportDir, { recursive: true });

  const result = writeExports(
    { candidates: [candidate(WALLET_A, 88)] },
    config,
    null,
    { writeMeridian: false },
  );

  assert.equal(result.exported, 0);
  assert.equal(result.wallets.length, 0);
  assert.equal(result.gmgnWallets.length, 1);
  assert.equal(result.paths.jsonPath, null);
  assert.ok(fs.existsSync(result.paths.gmgnPath));
  assert.ok(!fs.existsSync(path.join(config.paths.exportDir, "recommended.json")));
});

test("can disable incremental GMGN diffs", () => {
  const dir = tempDir();
  const config = baseConfig({
    paths: {
      dataDir: path.join(dir, "data"),
      exportDir: path.join(dir, "exports"),
    },
    export: {
      meridianSmartWalletsPath: path.join(dir, "smart-wallets.json"),
      gmgn: { incremental: false },
    },
  });
  fs.mkdirSync(config.paths.exportDir, { recursive: true });

  const result = writeExports(
    { candidates: [candidate(WALLET_A, 88)] },
    config,
  );

  assert.equal(result.paths.gmgnNewPath, null);
  assert.equal(result.paths.gmgnLedgerPath, null);
  assert.deepEqual(result.gmgnNewWallets, []);
  assert.ok(fs.existsSync(result.paths.gmgnPath));
  assert.ok(!fs.existsSync(path.join(config.paths.exportDir, "gmgn-new.json")));
});

test("skips the GMGN file when disabled", () => {
  const dir = tempDir();
  const config = baseConfig({
    paths: {
      dataDir: path.join(dir, "data"),
      exportDir: path.join(dir, "exports"),
    },
    export: {
      meridianSmartWalletsPath: path.join(dir, "smart-wallets.json"),
      gmgn: { enabled: false },
    },
  });
  fs.mkdirSync(config.paths.exportDir, { recursive: true });

  const result = writeExports(
    { candidates: [candidate(WALLET_A, 88)] },
    config,
  );

  assert.equal(result.paths.gmgnPath, null);
  assert.equal(result.gmgnWallets.length, 0);
  assert.ok(!fs.existsSync(path.join(config.paths.exportDir, "gmgn-follow.json")));
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
