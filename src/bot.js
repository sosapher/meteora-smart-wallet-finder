import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "./config.js";
import { isSolanaAddress } from "./lpers.js";
import { writeAllWalletsText, writeSmartWalletText } from "./output.js";
import { loadState } from "./state.js";
import {
  escapeHtml,
  formatCandidateAlert,
  getTelegramMe,
  getTelegramUpdates,
  sendTelegramDocument,
  sendTelegramMessage,
} from "./telegram.js";
import { shortAddress } from "./util.js";

const MAX_TAIL_LINES = 20;
const KILL_GRACE_MS = 10_000;

const SCAN_LIMITS = {
  "--pools": { min: 1, max: 100 },
  "--top": { min: 1, max: 200 },
  "--min-score": { min: 0, max: 100 },
};

export const SCAN_USAGE =
  "Usage: <code>/scan [--pools 1-100] [--top 1-200] [--min-score 0-100] [--refresh]</code>";

export function helpText() {
  return [
    "🤖 <b>Meteora Smart Wallet Finder</b>",
    "<i>Read-only control bot. No private keys, no transactions.</i>",
    "",
    "<b>Commands</b>",
    "/scan — run a scan with default settings",
    "/scan --pools 5 --top 10 — quick scan",
    "/scan --refresh — ignore cache",
    "/stop — stop the running scan",
    "/status — show scan status",
    "/last — show top wallets from the last scan",
    "/wallet <address> — show wallet details",
    "/wallet <address> --refresh — run a live wallet check",
    "/watch on 30m — run scheduled scans",
    "/watch off — stop scheduled scans",
    "/watch — show schedule status",
    "/export — send the latest GMGN file",
    "/export new — send only new GMGN wallets",
    "/export full — send the full GMGN list",
    "/exporttxt — send smart wallets as a ranked .txt file",
    "/exporttxtfull — send every wallet ever found, ranked by tier",
    "/id — show this chat ID",
    "/help — show this message",
    "",
    SCAN_USAGE,
    "",
    "<i>Merging into Meridian stays manual: run</i> <code>node finder.js export --merge</code> <i>on the VPS.</i>",
  ].join("\n");
}

export function parseBotCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;

  const [raw, ...args] = trimmed.split(/\s+/);
  const name = raw.slice(1).split("@")[0].toLowerCase();
  if (!name) return null;
  return { name, args };
}

export function parseWatchInterval(value, fallback = 30) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  const match = text.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/);
  if (!match) {
    throw new Error("Interval must look like 30m, 90m, or 1h");
  }
  const amount = Number(match[1]);
  const unit = match[2] || "m";
  const minutes = unit.startsWith("h") ? amount * 60 : amount;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error("Interval must be between 1m and 1440m (24h)");
  }
  return minutes;
}

export function buildScanArgs(tokens = []) {
  const out = [];
  const seen = new Set();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    const [flag, inlineValue] = token.split("=", 2);

    if (flag === "--refresh") {
      if (inlineValue !== undefined) {
        throw new Error("--refresh does not take a value");
      }
      if (!seen.has(flag)) out.push(flag);
      seen.add(flag);
      continue;
    }

    const limits = SCAN_LIMITS[flag];
    if (!limits) {
      throw new Error(`Unknown option: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`Duplicate option: ${flag}`);
    }

    let value = inlineValue;
    if (value === undefined) {
      value = tokens[index + 1];
      index += 1;
    }
    if (value === undefined || value === "") {
      throw new Error(`${flag} needs a number`);
    }

    const number = Number(value);
    if (!Number.isInteger(number) || number < limits.min || number > limits.max) {
      throw new Error(`${flag} must be an integer ${limits.min}-${limits.max}`);
    }

    out.push(flag, String(number));
    seen.add(flag);
  }

  return out;
}

export function allowedChatIds(config) {
  const raw = config.telegram?.allowedChatIds;
  const values = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\s]+/);
  const ids = values.map((value) => String(value).trim()).filter(Boolean);
  if (ids.length === 0 && config.telegram?.chatId) {
    ids.push(String(config.telegram.chatId));
  }
  return new Set(ids);
}

export function createBotState() {
  return {
    child: null,
    startedAt: 0,
    startedBy: null,
    killRequested: false,
    killTimer: null,
    scanArgs: [],
    tail: [],
    watch: {
      enabled: false,
      intervalMinutes: 30,
      nextRunAt: 0,
      timer: null,
      chatId: null,
    },
  };
}

function watchSettingsPath(config) {
  return path.join(config.paths.dataDir, "telegram-watch.json");
}

export function loadWatchSettings(config) {
  const configured = Number(config.watch?.intervalMinutes);
  const fallback = {
    enabled: false,
    intervalMinutes:
      Number.isFinite(configured) && configured >= 1 && configured <= 1440
        ? Math.floor(configured)
        : 30,
    chatId: config.telegram?.chatId ? String(config.telegram.chatId) : null,
    nextRunAt: 0,
  };
  const file = watchSettingsPath(config);
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const interval = Number(raw.intervalMinutes);
    return {
      enabled: Boolean(raw.enabled),
      intervalMinutes:
        Number.isFinite(interval) && interval >= 1 && interval <= 1440
          ? Math.floor(interval)
          : fallback.intervalMinutes,
      chatId: raw.chatId ? String(raw.chatId) : fallback.chatId,
      nextRunAt: Number.isFinite(Number(raw.nextRunAt))
        ? Number(raw.nextRunAt)
        : 0,
    };
  } catch {
    return fallback;
  }
}

export function saveWatchSettings(config, watch) {
  const file = watchSettingsPath(config);

  // Keep the file only while a schedule is active, so a disabled watch leaves
  // no stale state behind.
  if (!watch.enabled) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Ignore: a missing file is the desired end state.
    }
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        enabled: Boolean(watch.enabled),
        intervalMinutes: watch.intervalMinutes,
        chatId: watch.chatId,
        nextRunAt: watch.nextRunAt || 0,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function formatWatchStatus(state) {
  const watch = state?.watch;
  if (!watch?.enabled) {
    return (
      "👀 <b>Watch</b>: off\n" +
      "Use <code>/watch on 30m</code> to run scans on a schedule."
    );
  }
  const next =
    watch.nextRunAt > Date.now()
      ? formatDuration(watch.nextRunAt - Date.now())
      : "soon";
  return `👀 <b>Watch</b>: on · every ${watch.intervalMinutes}m · next in ${next}`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatAge(iso) {
  const timestamp = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(timestamp)) return "unknown time";
  const age = Date.now() - timestamp;
  if (age < 60_000) return "just now";
  return `${formatDuration(age)} ago`;
}

export function readLastScan(config) {
  const file = path.join(config.paths.dataDir, "last-scan.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function formatStatus(state, lastScan) {
  const lines = ["🤖 <b>Bot online</b>"];

  if (state.child) {
    const elapsed = formatDuration(Date.now() - state.startedAt);
    const options = state.scanArgs.length > 0
      ? `<code>${escapeHtml(state.scanArgs.join(" "))}</code>`
      : "default settings";
    lines.push(`Scan: <b>running</b> · ${elapsed} · ${options}`);
  } else {
    lines.push("Scan: idle");
  }

  if (lastScan?.meta) {
    lines.push(
      `Last scan: ${formatAge(lastScan.meta.generatedAt)} · ` +
        `✅ ${lastScan.meta.recommended ?? 0} recommended · ` +
        `👀 ${lastScan.meta.watch ?? 0} watch`,
    );
  } else {
    lines.push("Last scan: none yet");
  }

  if (state.watch?.enabled) {
    const next =
      state.watch.nextRunAt > Date.now()
        ? ` · next in ${formatDuration(state.watch.nextRunAt - Date.now())}`
        : "";
    lines.push(`Watch: <b>on</b> · every ${state.watch.intervalMinutes}m${next}`);
  } else {
    lines.push("Watch: off");
  }

  return lines.join("\n");
}

export function formatLastScan(lastScan, { limit = 8, header = true } = {}) {
  if (!lastScan?.meta && !lastScan?.candidates?.length) {
    return "No scan results yet. Send /scan to start one.";
  }

  const meta = lastScan.meta || {};

  if (!lastScan.candidates?.length) {
    const lines = [];
    if (header) {
      lines.push(`📊 <b>Last scan</b> · ${formatAge(meta.generatedAt)}`);
    }
    lines.push(`${meta.poolsScanned ?? "?"} pools scanned · no candidates found.`);
    lines.push(
      "Upstream data can be rate-limited. Try /scan --refresh again in a few minutes.",
    );
    return lines.join("\n");
  }

  const lines = [];

  if (header) {
    lines.push(`📊 <b>Last scan</b> · ${formatAge(meta.generatedAt)}`);
  }
  lines.push(
    `${meta.poolsScanned ?? "?"} pools · ${meta.candidatesFound ?? "?"} candidates · ` +
      `${meta.deepChecked ?? "?"} checked`,
  );
  lines.push(
    `✅ ${meta.recommended ?? 0} recommended · 👀 ${meta.watch ?? 0} watch`,
  );
  lines.push("");

  const actionable = lastScan.candidates.filter(
    (candidate) =>
      candidate.score?.status === "recommended" ||
      candidate.score?.status === "watch",
  );
  const source = actionable.length > 0 ? actionable : lastScan.candidates;
  const candidates = source.slice(0, limit);
  candidates.forEach((candidate, index) => {
    const score = candidate.score || {};
    const metrics = candidate.metrics || {};
    lines.push(
      `${index + 1}. <b>${score.score ?? 0}</b> ${score.tier ?? "?"} · ` +
        `<code>${escapeHtml(candidate.address || "")}</code>`,
    );
    lines.push(
      `   win ${metrics.winRatePct ?? 0}% · fee ${metrics.feeYieldPct ?? 0}% · ` +
        `ROI ${metrics.netRoiPct ?? 0}% · ${metrics.n ?? 0} closed`,
    );
    if (metrics.hygiene?.walletAgeDays != null) {
      lines.push(
        `   on-chain age ${metrics.hygiene.walletAgeDays}d · ` +
          `SOL ${metrics.hygiene.solBalance}` +
          (metrics.hygiene.sharedFunderCount > 1
            ? ` · shared funder x${metrics.hygiene.sharedFunderCount}`
            : ""),
      );
    }
    if (score.status) {
      lines.push(`   status ${score.status}${score.qualified ? "" : " (gated)"}`);
    }
  });

  if (source.length > limit) {
    lines.push("");
    lines.push(`<i>+${source.length - limit} more in exports/recommended.md</i>`);
  }

  return lines.join("\n");
}

/**
 * Turn a message into a reply plus an optional action. Pure function so the
 * command layer is easy to test.
 */
export function commandPlan({ text, state, config, lastScan = null }) {
  const parsed = parseBotCommand(text);
  if (!parsed) return null;

  switch (parsed.name) {
    case "start":
    case "help":
      return { reply: helpText() };

    case "id":
      return {
        reply:
          `Chat ID: <code>${escapeHtml(state.chatId ?? "unknown")}</code>\n` +
          "Use this value in <code>telegram.allowedChatIds</code>.",
      };

    case "status":
      return { reply: formatStatus(state, lastScan) };

    case "last":
      return { reply: formatLastScan(lastScan) };

    case "wallet": {
      const address = parsed.args.find((arg) => !arg.startsWith("--"));
      const refresh = parsed.args.includes("--refresh");
      if (!address) {
        return {
          reply:
            "Usage: <code>/wallet &lt;address&gt;</code> or " +
            "<code>/wallet &lt;address&gt; --refresh</code>.",
        };
      }
      if (!isSolanaAddress(address)) {
        return { reply: "❌ That does not look like a Solana wallet address." };
      }
      return { action: { type: "wallet", address, refresh } };
    }

    case "watch": {
      const mode = String(parsed.args[0] || "status").toLowerCase();
      if (mode === "status") {
        return { action: { type: "watch", mode: "status" } };
      }
      if (mode === "off") {
        return { action: { type: "watch", mode: "off" } };
      }
      if (mode === "now") {
        return { action: { type: "watch", mode: "now" } };
      }
      if (mode === "on") {
        let intervalMinutes;
        try {
          intervalMinutes = parseWatchInterval(
            parsed.args[1],
            Number(config.watch?.intervalMinutes || 30),
          );
        } catch (error) {
          return { reply: `❌ ${escapeHtml(error.message)}` };
        }
        return {
          action: { type: "watch", mode: "on", intervalMinutes },
        };
      }
      return {
        reply:
          "Usage: <code>/watch on 30m</code>, <code>/watch off</code>, " +
          "<code>/watch now</code>, or <code>/watch</code>.",
      };
    }

    case "export": {
      const mode = String(parsed.args[0] || "auto").toLowerCase();
      if (!["auto", "new", "full"].includes(mode)) {
        return {
          reply:
            "Usage: <code>/export</code>, <code>/export new</code>, or " +
            "<code>/export full</code>.",
        };
      }
      return { action: { type: "export", mode } };
    }

    case "exporttxt":
      return { action: { type: "exporttxt" } };

    case "exporttxtfull":
      return { action: { type: "exporttxtfull" } };

    case "scan": {
      if (state.child) {
        return {
          reply: `⏳ A scan is already running (${formatDuration(Date.now() - state.startedAt)}). Use /status or /stop.`,
        };
      }
      try {
        const scanArgs = buildScanArgs(parsed.args);
        const options = scanArgs.length > 0
          ? `<code>${escapeHtml(scanArgs.join(" "))}</code>`
          : "default settings";
        return {
          reply: `🚀 <b>Scan started</b> · ${options}\nUse /status to check progress or /stop to cancel.`,
          action: { type: "scan", args: scanArgs },
        };
      } catch (error) {
        return { reply: `❌ ${escapeHtml(error.message)}\n\n${SCAN_USAGE}` };
      }
    }

    case "stop":
      if (!state.child) return { reply: "No scan is running." };
      return {
        reply: "🛑 Stopping the running scan...",
        action: { type: "stop" },
      };

    default:
      return {
        reply: `Unknown command: /${escapeHtml(parsed.name)}\n\n${helpText()}`,
        action: null,
      };
  }
}

function offsetPath(config) {
  return path.join(config.paths.dataDir, "telegram-offset.json");
}

function loadOffset(config) {
  try {
    const data = JSON.parse(fs.readFileSync(offsetPath(config), "utf8"));
    const offset = Number(data.offset);
    return Number.isInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

function saveOffset(config, offset) {
  const file = offsetPath(config);
  const temp = `${file}.tmp`;
  try {
    fs.writeFileSync(
      temp,
      `${JSON.stringify({ offset, updatedAt: new Date().toISOString() })}\n`,
    );
    fs.renameSync(temp, file);
  } catch {
    // Offset persistence is best-effort.
  }
}

function appendTail(state, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  state.tail.push(...lines);
  if (state.tail.length > MAX_TAIL_LINES) {
    state.tail.splice(0, state.tail.length - MAX_TAIL_LINES);
  }
}

function startScan({
  state,
  config,
  configPath,
  scanArgs,
  chatId,
  logger,
  knownRecommended = null,
}) {
  const childArgs = [path.join(ROOT, "finder.js"), "scan", ...scanArgs];
  if (configPath) childArgs.push("--config", configPath);

  const child = spawn(process.execPath, childArgs, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  state.child = child;
  state.startedAt = Date.now();
  state.startedBy = chatId;
  state.killRequested = false;
  state.scanArgs = scanArgs;
  state.tail = [];

  child.stdout.on("data", (chunk) => appendTail(state, chunk));
  child.stderr.on("data", (chunk) => appendTail(state, chunk));

  child.on("error", (error) => {
    state.child = null;
    sendTelegramMessage(
      chatId,
      `❌ <b>Could not start scan</b>\n<code>${escapeHtml(error.message)}</code>`,
      config,
      logger,
    );
  });

  child.on("exit", (code, signal) => {
    if (state.child !== child) return;

    const elapsed = formatDuration(Date.now() - state.startedAt);
    const wasStopped = state.killRequested;

    state.child = null;
    state.killRequested = false;
    if (state.killTimer) {
      clearTimeout(state.killTimer);
      state.killTimer = null;
    }

    if (wasStopped) {
      sendTelegramMessage(
        chatId,
        `🛑 <b>Scan stopped</b> after ${elapsed}.`,
        config,
        logger,
      );
      logger.info(`Telegram scan stopped by chat ${chatId} after ${elapsed}`);
      return;
    }

    if (code === 0) {
      const lastScan = readLastScan(config);
      const summary = formatLastScan(lastScan, { limit: 5, header: false });
      sendTelegramMessage(
        chatId,
        `✅ <b>Scan finished</b> in ${elapsed}\n\n${summary}`,
        config,
        logger,
      );

      if (knownRecommended) {
        const fresh = (lastScan?.candidates || []).filter(
          (candidate) =>
            candidate.score?.status === "recommended" &&
            !knownRecommended.has(candidate.address),
        );
        if (fresh.length > 0) {
          sendTelegramMessage(
            chatId,
            formatCandidateAlert(fresh),
            config,
            logger,
          );
        }
      }

      logger.info(`Telegram scan finished in ${elapsed}`);
      return;
    }

    const tail = state.tail.join("\n").slice(-1200);
    sendTelegramMessage(
      chatId,
      `❌ <b>Scan failed</b> after ${elapsed} ` +
        `(exit ${code ?? "?"}${signal ? `, ${signal}` : ""})\n` +
        `<pre>${escapeHtml(tail || "no output")}</pre>`,
      config,
      logger,
    );
    logger.warn(`Telegram scan failed: exit ${code ?? "?"} ${signal ?? ""}`);
  });

  logger.info(
    `Telegram scan started by chat ${chatId}: ${scanArgs.join(" ") || "defaults"}`,
  );
}

function stopScan(state, logger) {
  if (!state.child) return false;
  state.killRequested = true;

  try {
    state.child.kill("SIGTERM");
  } catch (error) {
    logger.warn(`Could not send SIGTERM to scan: ${error.message}`);
  }

  if (state.killTimer) clearTimeout(state.killTimer);
  state.killTimer = setTimeout(() => {
    if (!state.child) return;
    logger.warn("Scan did not stop in time; sending SIGKILL.");
    try {
      state.child.kill("SIGKILL");
    } catch {
      // The child may have exited between the check and the kill.
    }
  }, KILL_GRACE_MS);

  return true;
}

function isFatalTelegramError(error) {
  const message = String(error?.message || "");
  return /HTTP (401|404|409)|Conflict|Unauthorized|Not Found|terminated by other/i.test(
    message,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function latestOffset(config, logger) {
  const updates = await getTelegramUpdates({
    config,
    offset: -1,
    timeoutSeconds: 0,
    limit: 1,
    logger,
  });
  if (updates.length === 0) return 0;
  return updates[updates.length - 1].update_id + 1;
}

function readGmgnFile(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function pct(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number}%` : "-";
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "-";
}

export function formatWalletReport(result, { source = "last scan" } = {}) {
  const score = result.score || {};
  const metrics = result.metrics || {};
  const hygiene = metrics.hygiene || result.hygiene || {};
  const open = result.open || {};
  const lines = [
    "👛 <b>Wallet report</b>",
    `<code>${escapeHtml(result.address || "")}</code>`,
    `<i>Source: ${escapeHtml(source)}</i>`,
    "",
    `<b>${score.score ?? "-"} · ${score.tier ?? "?"} · ${score.status ?? "unknown"}</b>`,
  ];

  if (score.qualified != null) {
    lines.push(`Qualified: ${score.qualified ? "yes" : "no"}`);
  }
  lines.push(
    `${metrics.n ?? 0} closed · win ${pct(metrics.winRatePct)} · ` +
      `fee ${pct(metrics.feeYieldPct)} · ROI ${pct(metrics.netRoiPct)}`,
  );
  lines.push(
    `PF ${num(metrics.profitFactor)} · hold ${num(metrics.avgHoldHours)}h · ` +
      `range ${num(metrics.medianWidthBins)} bins · ${metrics.poolCount ?? 0} pool(s)`,
  );
  lines.push(
    `Open: ${open.totalPositions ?? 0} position(s) in ${open.pools?.length ?? 0} pool(s)`,
  );

  if (hygiene?.enabled) {
    const parts = [];
    if (hygiene.walletAgeDays != null) {
      parts.push(
        `age ${hygiene.walletAgeDays}d${hygiene.ageCapped ? "+" : ""}`,
      );
    }
    if (hygiene.solBalance != null) parts.push(`SOL ${hygiene.solBalance}`);
    if (hygiene.funder) parts.push(`funder ${shortAddress(hygiene.funder)}`);
    if (hygiene.sharedFunderCount > 1) {
      parts.push(`shared x${hygiene.sharedFunderCount}`);
    }
    if (parts.length > 0) lines.push(`On-chain: ${parts.join(" · ")}`);
  }

  if (metrics.daysSinceActive != null) {
    lines.push(
      `Active: ${
        metrics.openPositions > 0 ? "now" : `${metrics.daysSinceActive}d ago`
      }`,
    );
  }

  const reasons = (score.reasons || []).slice(0, 6);
  if (reasons.length > 0) {
    lines.push("", "<b>Why</b>");
    reasons.forEach((reason) => lines.push(`• ${escapeHtml(reason)}`));
  }

  const warnings = (score.warnings || []).slice(0, 5);
  if (warnings.length > 0) {
    lines.push("", "<b>Warnings</b>");
    warnings.forEach((warning) => lines.push(`⚠️ ${escapeHtml(warning)}`));
  }

  const failed = (score.gates || []).filter((gate) => gate.ok === false);
  const rejection = (score.rejectionReasons || []).slice(0, 5);
  if (failed.length > 0) {
    lines.push("", "<b>Failed gates</b>");
    failed
      .slice(0, 5)
      .forEach((gate) =>
        lines.push(`❌ ${escapeHtml(gate.code)}: ${escapeHtml(gate.detail)}`),
      );
  } else if (rejection.length > 0) {
    lines.push("", "<b>Rejected because</b>");
    rejection.forEach((reason) => lines.push(`❌ ${escapeHtml(reason)}`));
  }

  const pools = (open.pools || []).slice(0, 5);
  if (pools.length > 0) {
    lines.push("", "<b>Open pools</b>");
    pools.forEach((pool) => {
      lines.push(
        `• ${escapeHtml(pool.name || shortAddress(pool.address))} ` +
          `(${pool.positionCount ?? 0})${pool.outOfRange ? " ⚠️ OOR" : ""}`,
      );
    });
  }

  lines.push("", "<i>Read-only research. Verify manually.</i>");
  return lines.join("\n");
}

function formatWalletState(wallet, { source = "recorded state" } = {}) {
  const lines = [
    "👛 <b>Wallet report</b>",
    `<code>${escapeHtml(wallet.address || "")}</code>`,
    `<i>Source: ${escapeHtml(source)}</i>`,
    "",
    `<b>${wallet.lastScore ?? "-"} · ${wallet.lastTier ?? "?"} · ${
      wallet.status ?? "unknown"
    }</b>`,
    `Best score: ${wallet.bestScore ?? "-"}`,
    `First seen: ${formatAge(wallet.firstSeen)} · Last seen: ${formatAge(
      wallet.lastSeen,
    )}`,
  ];

  const warnings = (wallet.lastWarnings || []).slice(0, 5);
  if (warnings.length > 0) {
    lines.push("", "<b>Warnings</b>");
    warnings.forEach((warning) => lines.push(`⚠️ ${escapeHtml(warning)}`));
  }

  lines.push(
    "",
    "This wallet was not deep-checked in the last scan.",
    `Use <code>/wallet ${escapeHtml(wallet.address || "")} --refresh</code> for live data.`,
  );
  return lines.join("\n");
}

function runWalletCheck({ address, configPath, logger, timeoutMs = 180_000 }) {
  return new Promise((resolve, reject) => {
    const childArgs = [path.join(ROOT, "finder.js"), "check", address, "--json"];
    if (configPath) childArgs.push("--config", configPath);

    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("Wallet check timed out after 3 minutes."));
        return;
      }
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-4).join("\n");
        reject(
          new Error(
            `Wallet check failed (exit ${code ?? signal ?? "?"}): ` +
              (tail || "no output"),
          ),
        );
        return;
      }
      try {
        const start = stdout.indexOf("{");
        const end = stdout.lastIndexOf("}");
        if (start < 0 || end < start) {
          throw new Error("no JSON in output");
        }
        resolve(JSON.parse(stdout.slice(start, end + 1)));
      } catch (error) {
        logger?.warn(`Cannot parse wallet check output: ${error.message}`);
        reject(new Error("Could not read the wallet check result."));
      }
    });
  });
}

async function handleWallet({
  chatId,
  address,
  refresh,
  state,
  config,
  configPath,
  logger,
}) {
  if (refresh) {
    if (state.child) {
      await sendTelegramMessage(
        chatId,
        "⏳ A scan is running. Wait for it to finish, then try again.",
        config,
        logger,
      );
      return;
    }

    await sendTelegramMessage(
      chatId,
      `🔎 Checking <code>${escapeHtml(address)}</code> across the last scan pools...`,
      config,
      logger,
    );

    try {
      const result = await runWalletCheck({
        address,
        configPath,
        logger,
      });
      await sendTelegramMessage(
        chatId,
        formatWalletReport(result, { source: "live check" }),
        config,
        logger,
      );
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        `❌ ${escapeHtml(error.message)}`,
        config,
        logger,
      );
    }
    return;
  }

  const lastScan = readLastScan(config);
  const found = lastScan?.candidates?.find(
    (candidate) => candidate.address === address,
  );
  if (found) {
    await sendTelegramMessage(
      chatId,
      formatWalletReport(found, { source: "last scan" }),
      config,
      logger,
    );
    return;
  }

  const saved = loadState(
    path.join(config.paths.dataDir, "state.json"),
  ).wallets?.[address];
  if (saved) {
    await sendTelegramMessage(
      chatId,
      formatWalletState(saved),
      config,
      logger,
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    "❌ Wallet not found in the last scan or saved state.\n" +
      `Run <code>/wallet ${escapeHtml(address)} --refresh</code> for a live check.`,
    config,
    logger,
  );
}

function scheduleWatch({
  state,
  config,
  configPath,
  logger,
  delayMs,
}) {
  const watch = state.watch;
  if (!watch?.enabled) return;

  if (watch.timer) clearTimeout(watch.timer);
  watch.nextRunAt = Date.now() + Math.max(1000, delayMs);
  saveWatchSettings(config, watch);

  watch.timer = setTimeout(() => {
    watch.timer = null;
    if (!watch.enabled) return;

    if (state.child) {
      logger.info("Scheduled scan skipped: another scan is already running.");
      scheduleWatch({
        state,
        config,
        configPath,
        logger,
        delayMs: 60_000,
      });
      return;
    }

    const chatId = watch.chatId || config.telegram?.chatId;
    if (!chatId) {
      logger.warn("Watch is enabled but no chat ID is configured; disabling.");
      watch.enabled = false;
      watch.nextRunAt = 0;
      saveWatchSettings(config, watch);
      return;
    }

    const lastScan = readLastScan(config);
    const knownRecommended = new Set(
      (lastScan?.candidates || [])
        .filter((candidate) => candidate.score?.status === "recommended")
        .map((candidate) => candidate.address),
    );

    sendTelegramMessage(
      chatId,
      `⏰ <b>Scheduled scan started</b> · every ${watch.intervalMinutes}m`,
      config,
      logger,
    );
    startScan({
      state,
      config,
      configPath,
      scanArgs: [],
      chatId,
      logger,
      knownRecommended,
    });
    scheduleWatch({
      state,
      config,
      configPath,
      logger,
      delayMs: watch.intervalMinutes * 60_000,
    });
  }, Math.max(1000, delayMs));
}

async function handleWatch({
  chatId,
  action,
  state,
  config,
  configPath,
  logger,
}) {
  const watch = state.watch;

  if (action.mode === "status") {
    await sendTelegramMessage(
      chatId,
      formatWatchStatus(state),
      config,
      logger,
    );
    return;
  }

  if (action.mode === "off") {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
    watch.enabled = false;
    watch.nextRunAt = 0;
    saveWatchSettings(config, watch);
    await sendTelegramMessage(
      chatId,
      "👀 <b>Watch off</b>. Scheduled scans stopped.",
      config,
      logger,
    );
    logger.info(`Telegram watch disabled by chat ${chatId}`);
    return;
  }

  if (action.mode === "on") {
    watch.enabled = true;
    watch.intervalMinutes = action.intervalMinutes;
    watch.chatId = chatId;
    scheduleWatch({
      state,
      config,
      configPath,
      logger,
      delayMs: action.intervalMinutes * 60_000,
    });
    await sendTelegramMessage(
      chatId,
      `👀 <b>Watch on</b> · every ${action.intervalMinutes}m.\n` +
        `Next scan in ${action.intervalMinutes}m. Use /watch off to stop.`,
      config,
      logger,
    );
    logger.info(
      `Telegram watch enabled by chat ${chatId}: every ${action.intervalMinutes}m`,
    );
    return;
  }

  if (action.mode === "now") {
    if (!watch.enabled) {
      await sendTelegramMessage(
        chatId,
        "Watch is off. Use <code>/watch on 30m</code> first.",
        config,
        logger,
      );
      return;
    }
    if (state.child) {
      await sendTelegramMessage(
        chatId,
        "⏳ A scan is already running. Use /status or /stop.",
        config,
        logger,
      );
      return;
    }
    const lastScan = readLastScan(config);
    const knownRecommended = new Set(
      (lastScan?.candidates || [])
        .filter((candidate) => candidate.score?.status === "recommended")
        .map((candidate) => candidate.address),
    );
    await sendTelegramMessage(
      chatId,
      "⏰ <b>Scheduled scan started now</b>",
      config,
      logger,
    );
    startScan({
      state,
      config,
      configPath,
      scanArgs: [],
      chatId,
      logger,
      knownRecommended,
    });
    scheduleWatch({
      state,
      config,
      configPath,
      logger,
      delayMs: watch.intervalMinutes * 60_000,
    });
    return;
  }
}

async function handleExport({ chatId, mode, config, logger }) {
  const settings = config.export?.gmgn || {};
  const fullPath = path.join(
    config.paths.exportDir,
    settings.fileName || "gmgn-follow.json",
  );
  const newPath = path.join(
    config.paths.exportDir,
    settings.newFileName || "gmgn-new.json",
  );

  let target = mode === "new" ? newPath : mode === "full" ? fullPath : null;
  if (!target) {
    const newWallets = readGmgnFile(newPath);
    target = newWallets && newWallets.length > 0 ? newPath : fullPath;
  }

  if (!fs.existsSync(target)) {
    await sendTelegramMessage(
      chatId,
      "❌ No GMGN export found yet. Run /scan first.",
      config,
      logger,
    );
    return;
  }

  const wallets = readGmgnFile(target);
  if (!wallets) {
    await sendTelegramMessage(
      chatId,
      `❌ Could not read <code>${escapeHtml(path.basename(target))}</code>.`,
      config,
      logger,
    );
    return;
  }
  if (wallets.length === 0) {
    await sendTelegramMessage(
      chatId,
      `❌ <code>${escapeHtml(path.basename(target))}</code> is empty. ` +
        "Run /scan first, or use /export full.",
      config,
      logger,
    );
    return;
  }

  const label = target === newPath ? "🆕 GMGN new" : "📋 GMGN full";
  const caption =
    `${label}: ${wallets.length} wallet(s)\n` +
    "Import: https://gmgn.ai/follow -> Batch import";
  const ok = await sendTelegramDocument(chatId, target, {
    caption,
    config,
    logger,
  });
  if (!ok) {
    await sendTelegramMessage(
      chatId,
      "❌ Failed to send the GMGN file. Check the bot logs.",
      config,
      logger,
    );
  }
}

async function handleExportTxt({ chatId, config, logger }) {
  const lastScan = readLastScan(config);
  if (!lastScan) {
    await sendTelegramMessage(
      chatId,
      "❌ No scan result yet. Run /scan first.",
      config,
      logger,
    );
    return;
  }

  const candidates = Array.isArray(lastScan.candidates)
    ? lastScan.candidates
    : [];
  const result = writeSmartWalletText(candidates, config, {
    source: "data/last-scan.json",
  });

  if (result.count === 0) {
    await sendTelegramMessage(
      chatId,
      "❌ No smart wallets matched the export criteria. " +
        "Run /scan with a lower --min-score or adjust export.minScore.",
      config,
      logger,
    );
    return;
  }

  const caption =
    `📄 Smart wallets: ${result.count} wallet(s)\n` +
    "Sorted by score, best first.";
  const ok = await sendTelegramDocument(chatId, result.path, {
    caption,
    config,
    logger,
  });
  if (!ok) {
    await sendTelegramMessage(
      chatId,
      "❌ Failed to send the smart wallet text file. Check the bot logs.",
      config,
      logger,
    );
  }
}

async function handleExportTxtFull({ chatId, config, logger }) {
  const state = loadState(path.join(config.paths.dataDir, "state.json"));
  const wallets = Object.values(state.wallets || {});

  if (wallets.length === 0) {
    await sendTelegramMessage(
      chatId,
      "❌ No wallets recorded yet. Run /scan first.",
      config,
      logger,
    );
    return;
  }

  const result = writeAllWalletsText(wallets, config, {
    source: "data/state.json",
    scanAt: state.lastScanAt,
  });
  const caption =
    `📚 All wallets: ${result.count}\n` +
    "Sorted by tier (S best), then score. Nothing filtered.";
  const ok = await sendTelegramDocument(chatId, result.path, {
    caption,
    config,
    logger,
  });
  if (!ok) {
    await sendTelegramMessage(
      chatId,
      "❌ Failed to send the all-wallets text file. Check the bot logs.",
      config,
      logger,
    );
  }
}

export async function runBot(ctx) {
  const { config, configPath, logger } = ctx;
  const token = config.telegram?.botToken;

  if (!token) {
    throw new Error(
      "Telegram bot token is not configured. Set telegram.botToken in config.json " +
        "or export TELEGRAM_BOT_TOKEN.",
    );
  }

  const allowed = allowedChatIds(config);
  if (allowed.size === 0) {
    throw new Error(
      "No allowed Telegram chat IDs configured. Set telegram.allowedChatIds " +
        "(or TELEGRAM_CHAT_ID) to your numeric chat ID. Use @userinfobot in " +
        "Telegram if you do not know it.",
    );
  }

  let me;
  try {
    me = await getTelegramMe(config, logger);
  } catch (error) {
    throw new Error(
      `Telegram rejected the bot token: ${error.message}. Check telegram.botToken.`,
    );
  }

  const state = createBotState();
  let stopping = false;
  let pollController = null;

  const savedWatch = loadWatchSettings(config);
  const watchChat = String(savedWatch.chatId || config.telegram?.chatId || "");
  state.watch.intervalMinutes = savedWatch.intervalMinutes;
  state.watch.chatId = watchChat || null;
  state.watch.enabled =
    Boolean(savedWatch.enabled) && allowed.has(watchChat);
  if (savedWatch.enabled && !state.watch.enabled) {
    logger.warn(
      "Saved watch schedule uses an unauthorized chat ID; disabling it.",
    );
    saveWatchSettings(config, state.watch);
  }
  if (state.watch.enabled) {
    const delay =
      savedWatch.nextRunAt > Date.now()
        ? savedWatch.nextRunAt - Date.now()
        : 5000;
    scheduleWatch({
      state,
      config,
      configPath,
      logger,
      delayMs: delay,
    });
    logger.info(
      `Watch schedule resumed: every ${state.watch.intervalMinutes}m.`,
    );
  }

  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    logger.info("Telegram bot stopping...");
    pollController?.abort();
    if (state.watch?.timer) {
      clearTimeout(state.watch.timer);
      state.watch.timer = null;
    }
    saveWatchSettings(config, state.watch);
    if (state.child) stopScan(state, logger);
  };

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  let offset = loadOffset(config);
  if (offset === null) {
    // First start: skip commands sent while the bot was offline instead of
    // replaying a backlog of scans.
    offset = await latestOffset(config, logger);
    saveOffset(config, offset);
  }

  logger.info(
    `Telegram bot @${me?.username || "unknown"} online. ` +
      `Authorized chats: ${[...allowed].join(", ")}.`,
  );

  let backoffMs = 1000;

  while (!stopping) {
    pollController = new AbortController();
    let updates;

    try {
      updates = await getTelegramUpdates({
        config,
        offset,
        signal: pollController.signal,
        logger,
      });
      backoffMs = 1000;
    } catch (error) {
      if (stopping || error.name === "AbortError") break;
      if (isFatalTelegramError(error)) throw error;

      logger.warn(
        `Telegram polling failed: ${error.message}; retrying in ${backoffMs / 1000}s`,
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
      continue;
    } finally {
      pollController = null;
    }

    for (const update of updates) {
      offset = Math.max(offset, Number(update.update_id || 0) + 1);
      saveOffset(config, offset);

      const message = update.message;
      const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
      if (!message || !chatId || !message.text || message.from?.is_bot) continue;

      if (!allowed.has(chatId)) {
        logger.warn(
          `Ignoring Telegram command from unauthorized chat ${chatId}. ` +
            "Add it to telegram.allowedChatIds if this is you.",
        );
        continue;
      }

      const lastScan = readLastScan(config);
      const plan = commandPlan({
        text: message.text,
        state: { ...state, chatId },
        config,
        lastScan,
      });
      if (!plan) continue;

      if (plan.action?.type === "wallet") {
        await handleWallet({
          chatId,
          address: plan.action.address,
          refresh: plan.action.refresh,
          state,
          config,
          configPath,
          logger,
        });
        continue;
      }

      if (plan.action?.type === "watch") {
        await handleWatch({
          chatId,
          action: plan.action,
          state,
          config,
          configPath,
          logger,
        });
        continue;
      }

      if (plan.action?.type === "export") {
        await handleExport({
          chatId,
          mode: plan.action.mode,
          config,
          logger,
        });
        continue;
      }

      if (plan.action?.type === "exporttxt") {
        await handleExportTxt({ chatId, config, logger });
        continue;
      }

      if (plan.action?.type === "exporttxtfull") {
        await handleExportTxtFull({ chatId, config, logger });
        continue;
      }

      await sendTelegramMessage(chatId, plan.reply, config, logger);

      if (plan.action?.type === "scan") {
        startScan({
          state,
          config,
          configPath,
          scanArgs: plan.action.args,
          chatId,
          logger,
        });
      } else if (plan.action?.type === "stop") {
        stopScan(state, logger);
      }
    }
  }

  if (state.watch?.timer) {
    clearTimeout(state.watch.timer);
    state.watch.timer = null;
  }
  saveWatchSettings(config, state.watch);

  if (state.child) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          state.child?.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve();
      }, 5000);
      state.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  process.removeListener("SIGINT", requestStop);
  process.removeListener("SIGTERM", requestStop);
  logger.info("Telegram bot stopped.");
  return state;
}
