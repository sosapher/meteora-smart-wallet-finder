import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BOT_COMMANDS,
  allowedChatIds,
  buildScanArgs,
  commandPlan,
  createBotState,
  formatLastScan,
  formatStatus,
  formatWalletReport,
  formatWatchStatus,
  helpText,
  loadWatchSettings,
  parseBotCommand,
  parseWatchInterval,
  saveWatchSettings,
} from "../src/bot.js";

const CONFIG = {
  telegram: { allowedChatIds: [], chatId: "" },
  paths: { dataDir: "/tmp/does-not-exist" },
};

const WALLET_A = "7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK";

test("parseBotCommand handles commands and @bot suffixes", () => {
  assert.deepEqual(parseBotCommand("/scan --pools 5"), {
    name: "scan",
    args: ["--pools", "5"],
  });
  assert.deepEqual(parseBotCommand("/status@MyBot"), { name: "status", args: [] });
  assert.equal(parseBotCommand("hello"), null);
  assert.equal(parseBotCommand(""), null);
});

test("buildScanArgs accepts valid options and normalizes them", () => {
  assert.deepEqual(buildScanArgs([]), []);
  assert.deepEqual(
    buildScanArgs(["--pools", "5", "--top=10", "--min-score", "80", "--refresh"]),
    ["--pools", "5", "--top", "10", "--min-score", "80", "--refresh"],
  );
});

test("buildScanArgs rejects unsafe or invalid options", () => {
  assert.throws(() => buildScanArgs(["--merge"]), /Unknown option/);
  assert.throws(() => buildScanArgs(["--pools", "0"]), /integer 1-100/);
  assert.throws(() => buildScanArgs(["--pools", "101"]), /integer 1-100/);
  assert.throws(() => buildScanArgs(["--top", "5; rm -rf /"]), /integer 1-200/);
  assert.throws(() => buildScanArgs(["--pools"]), /needs a number/);
  assert.throws(() => buildScanArgs(["--pools=5", "--pools=6"]), /Duplicate/);
  assert.throws(() => buildScanArgs(["--refresh=yes"]), /does not take a value/);
});

test("allowedChatIds uses the allowlist, then falls back to chatId", () => {
  assert.deepEqual(
    [...allowedChatIds({ telegram: { allowedChatIds: ["123", 456] } })],
    ["123", "456"],
  );
  assert.deepEqual(
    [...allowedChatIds({ telegram: { chatId: "789", allowedChatIds: [] } })],
    ["789"],
  );
  assert.equal(
    allowedChatIds({ telegram: { chatId: "", allowedChatIds: [] } }).size,
    0,
  );
});

test("help and id commands reply without actions", () => {
  const state = { ...createBotState(), chatId: "42" };
  const help = commandPlan({ text: "/help", state, config: CONFIG });
  assert.match(help.reply, /\/scan/);
  assert.equal(help.action, undefined);

  const id = commandPlan({ text: "/id", state, config: CONFIG });
  assert.match(id.reply, /42/);
});

test("scan command produces a scan action with safe arguments", () => {
  const state = createBotState();
  const plan = commandPlan({
    text: "/scan --pools 5 --top 10",
    state,
    config: CONFIG,
  });

  assert.equal(plan.action.type, "scan");
  assert.deepEqual(plan.action.args, ["--pools", "5", "--top", "10"]);
  assert.match(plan.reply, /Scan started/);
});

test("scan command rejects bad arguments and concurrent scans", () => {
  const bad = commandPlan({
    text: "/scan --pools 999",
    state: createBotState(),
    config: CONFIG,
  });
  assert.match(bad.reply, /integer 1-100/);
  assert.equal(bad.action, undefined);

  const running = createBotState();
  running.child = {};
  running.startedAt = Date.now() - 5000;
  const busy = commandPlan({ text: "/scan", state: running, config: CONFIG });
  assert.match(busy.reply, /already running/);
  assert.equal(busy.action, undefined);
});

test("stop command only acts when a scan is running", () => {
  const idle = commandPlan({
    text: "/stop",
    state: createBotState(),
    config: CONFIG,
  });
  assert.match(idle.reply, /No scan/);

  const running = createBotState();
  running.child = {};
  const stop = commandPlan({ text: "/stop", state: running, config: CONFIG });
  assert.equal(stop.action.type, "stop");
});

test("export command plans GMGN document delivery", () => {
  const state = createBotState();

  const auto = commandPlan({ text: "/export", state, config: CONFIG });
  assert.equal(auto.action.type, "export");
  assert.equal(auto.action.mode, "auto");
  assert.equal(auto.reply, undefined);

  const fresh = commandPlan({ text: "/export new", state, config: CONFIG });
  assert.equal(fresh.action.mode, "new");

  const full = commandPlan({ text: "/export full", state, config: CONFIG });
  assert.equal(full.action.mode, "full");

  const invalid = commandPlan({
    text: "/export everything",
    state,
    config: CONFIG,
  });
  assert.match(invalid.reply, /Usage/);
  assert.equal(invalid.action, undefined);
});

test("exporttxt command plans a ranked text document", () => {
  const plan = commandPlan({
    text: "/exporttxt",
    state: createBotState(),
    config: CONFIG,
  });
  assert.equal(plan.action.type, "exporttxt");
  assert.equal(plan.reply, undefined);
});

test("exporttxtfull command plans the unfiltered text document", () => {
  const plan = commandPlan({
    text: "/exporttxtfull",
    state: createBotState(),
    config: CONFIG,
  });
  assert.equal(plan.action.type, "exporttxtfull");
  assert.equal(plan.reply, undefined);
});

test("parseWatchInterval accepts minutes and hours", () => {
  assert.equal(parseWatchInterval("30m"), 30);
  assert.equal(parseWatchInterval("90"), 90);
  assert.equal(parseWatchInterval("1h"), 60);
  assert.equal(parseWatchInterval("2h"), 120);
  assert.equal(parseWatchInterval(undefined, 45), 45);
  assert.throws(() => parseWatchInterval("0m"), /between 1m and 1440m/);
  assert.throws(() => parseWatchInterval("25h"), /between 1m and 1440m/);
  assert.throws(() => parseWatchInterval("soon"), /Interval must look like/);
});

test("loadWatchSettings reads a saved schedule", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swf-watch-"));
  const config = {
    paths: { dataDir: dir },
    watch: { intervalMinutes: 30 },
    telegram: { chatId: "1" },
  };
  fs.writeFileSync(
    path.join(dir, "telegram-watch.json"),
    JSON.stringify({
      enabled: true,
      intervalMinutes: 60,
      chatId: "42",
      nextRunAt: 123456,
    }),
  );

  assert.deepEqual(loadWatchSettings(config), {
    enabled: true,
    intervalMinutes: 60,
    chatId: "42",
    nextRunAt: 123456,
  });
});

test("saveWatchSettings persists an active schedule and clears it when off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swf-watch-save-"));
  const config = {
    paths: { dataDir: dir },
    watch: { intervalMinutes: 30 },
    telegram: { chatId: "1" },
  };
  const file = path.join(dir, "telegram-watch.json");

  saveWatchSettings(config, {
    enabled: true,
    intervalMinutes: 15,
    chatId: "42",
    nextRunAt: 999,
  });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).intervalMinutes, 15);

  saveWatchSettings(config, {
    enabled: false,
    intervalMinutes: 15,
    chatId: "42",
    nextRunAt: 0,
  });
  assert.equal(fs.existsSync(file), false);
});

test("helpText is safe for Telegram HTML parsing", () => {
  const text = helpText();
  const stripped = text.replace(/<\/?(b|i|code|pre|a)\b[^>]*>/g, "");
  assert.equal(stripped.includes("<"), false, "raw '<' left in help text");
  assert.equal(stripped.includes(">"), false, "raw '>' left in help text");
  assert.match(text, /\/wallet &lt;address&gt;/);
  assert.match(text, /\/watch on 30m/);
});

test("BOT_COMMANDS are valid Telegram commands and all are handled", () => {
  const state = createBotState();
  const seen = new Set();

  for (const entry of BOT_COMMANDS) {
    assert.match(entry.command, /^[a-z0-9_]{1,32}$/);
    assert.equal(seen.has(entry.command), false, "duplicate command");
    seen.add(entry.command);
    assert.ok(entry.description.length > 0 && entry.description.length <= 256);

    const plan = commandPlan({
      text: `/${entry.command}`,
      state,
      config: CONFIG,
    });
    assert.ok(plan, `no plan for /${entry.command}`);
    assert.doesNotMatch(
      String(plan.reply || ""),
      /Unknown command/,
      `/${entry.command} is not handled`,
    );
  }
});

test("perf command parses refresh, limit, and day window", () => {
  const state = createBotState();

  const plain = commandPlan({ text: "/perf", state, config: CONFIG });
  assert.equal(plain.action.type, "perf");
  assert.equal(plain.action.refresh, false);

  const refresh = commandPlan({
    text: "/perf refresh 5",
    state,
    config: CONFIG,
  });
  assert.equal(refresh.action.refresh, true);
  assert.equal(refresh.action.limit, 5);

  const days = commandPlan({
    text: "/perf --days 7",
    state,
    config: CONFIG,
  });
  assert.equal(days.action.days, 7);
  assert.equal(days.action.refresh, false);

  const tooMany = commandPlan({
    text: "/perf refresh 99",
    state,
    config: CONFIG,
  });
  assert.match(tooMany.reply, /between 1 and 20/);

  const badDays = commandPlan({
    text: "/perf --days nope",
    state,
    config: CONFIG,
  });
  assert.match(badDays.reply, /positive number/);
});

test("wallet command validates the address and refresh flag", () => {
  const state = createBotState();
  const plan = commandPlan({
    text: `/wallet ${WALLET_A}`,
    state,
    config: CONFIG,
  });
  assert.equal(plan.action.type, "wallet");
  assert.equal(plan.action.address, WALLET_A);
  assert.equal(plan.action.refresh, false);

  const refresh = commandPlan({
    text: `/wallet ${WALLET_A} --refresh`,
    state,
    config: CONFIG,
  });
  assert.equal(refresh.action.refresh, true);

  const missing = commandPlan({ text: "/wallet", state, config: CONFIG });
  assert.match(missing.reply, /Usage/);

  const invalid = commandPlan({
    text: "/wallet not-a-wallet",
    state,
    config: CONFIG,
  });
  assert.match(invalid.reply, /Solana wallet address/);
});

test("watch command parses on, off, and status", () => {
  const state = createBotState();

  const status = commandPlan({ text: "/watch", state, config: CONFIG });
  assert.equal(status.action.type, "watch");
  assert.equal(status.action.mode, "status");

  const on = commandPlan({
    text: "/watch on 45m",
    state,
    config: CONFIG,
  });
  assert.equal(on.action.mode, "on");
  assert.equal(on.action.intervalMinutes, 45);

  const off = commandPlan({ text: "/watch off", state, config: CONFIG });
  assert.equal(off.action.mode, "off");

  const now = commandPlan({ text: "/watch now", state, config: CONFIG });
  assert.equal(now.action.mode, "now");

  const bad = commandPlan({
    text: "/watch on 0m",
    state,
    config: CONFIG,
  });
  assert.match(bad.reply, /between 1m and 1440m/);
});

test("formatWalletReport renders score, metrics, and warnings", () => {
  const report = formatWalletReport(
    {
      address: WALLET_A,
      score: {
        score: 88.3,
        tier: "S",
        status: "recommended",
        qualified: true,
        reasons: ["37 closed positions", "win rate 70.3%"],
        warnings: ["avg hold >72h"],
        gates: [{ code: "sample", ok: true, detail: "37 closed positions" }],
        rejectionReasons: [],
      },
      metrics: {
        n: 37,
        winRatePct: 70.3,
        feeYieldPct: 20.56,
        netRoiPct: 16.96,
        profitFactor: 9.69,
        avgHoldHours: 127.59,
        medianWidthBins: 32,
        poolCount: 3,
        daysSinceActive: 0,
        openPositions: 2,
        hygiene: {
          enabled: true,
          walletAgeDays: 50.1,
          solBalance: 0.4,
          funder: "DMnanMNSwgm3s8yN5n7QjFTm4nDfVjuMJvaAv6biWYd6",
          sharedFunderCount: 2,
        },
      },
      open: {
        totalPositions: 2,
        pools: [
          { name: "OPENAI-USDC", positionCount: 2, outOfRange: true },
        ],
      },
    },
    { source: "unit-test" },
  );

  assert.match(report, /Wallet report/);
  assert.match(report, new RegExp(WALLET_A));
  assert.match(report, /88\.3/);
  assert.match(report, /S · recommended/);
  assert.match(report, /37 closed/);
  assert.match(report, /avg hold &gt;72h/);
  assert.match(report, /OPENAI-USDC/);
  assert.match(report, /OOR/);
  assert.match(report, /Read-only research/);
});

test("formatWatchStatus reflects the schedule", () => {
  const state = createBotState();
  assert.match(formatWatchStatus(state), /Watch<\/b>: off/);

  state.watch.enabled = true;
  state.watch.intervalMinutes = 15;
  state.watch.nextRunAt = Date.now() + 5 * 60_000;
  const text = formatWatchStatus(state);
  assert.match(text, /Watch<\/b>: on/);
  assert.match(text, /every 15m/);
  assert.match(text, /next in/);
});

test("formatStatus reports idle and running states", () => {
  const idle = formatStatus(createBotState(), null);
  assert.match(idle, /idle/);
  assert.match(idle, /none yet/);

  const running = createBotState();
  running.child = {};
  running.startedAt = Date.now() - 12_000;
  running.scanArgs = ["--pools", "5"];
  const text = formatStatus(running, {
    meta: { generatedAt: new Date().toISOString(), recommended: 3, watch: 2 },
  });
  assert.match(text, /running/);
  assert.match(text, /3 recommended/);
});

test("formatLastScan renders top wallets and handles empty state", () => {
  assert.match(formatLastScan(null), /No scan results/);

  const emptyScan = {
    meta: { generatedAt: new Date().toISOString(), poolsScanned: 1 },
    candidates: [],
  };
  assert.match(formatLastScan(emptyScan), /no candidates found/);

  const lastScan = {
    meta: {
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
      poolsScanned: 20,
      candidatesFound: 295,
      deepChecked: 35,
      recommended: 12,
      watch: 5,
    },
    candidates: [
      {
        address: "BWAPhpTestAddress",
        score: { score: 95.5, tier: "S", status: "recommended", qualified: true },
        metrics: { winRatePct: 78, feeYieldPct: 4.2, netRoiPct: 12.3, n: 42 },
      },
    ],
  };

  const text = formatLastScan(lastScan);
  assert.match(text, /BWAPhpTestAddress/);
  assert.match(text, /95.5/);
  assert.match(text, /12 recommended/);
});
