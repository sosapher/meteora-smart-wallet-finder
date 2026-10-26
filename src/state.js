import fs from "node:fs";
import path from "node:path";

const STATE_VERSION = 1;

export function loadState(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      version: STATE_VERSION,
      lastScanAt: null,
      wallets: {},
    };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      version: payload.version || STATE_VERSION,
      lastScanAt: payload.lastScanAt || null,
      wallets: payload.wallets && typeof payload.wallets === "object"
        ? payload.wallets
        : {},
    };
  } catch {
    return {
      version: STATE_VERSION,
      lastScanAt: null,
      wallets: {},
    };
  }
}

export function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function updateState(statePath, candidates, meta, config) {
  const state = loadState(statePath);
  const firstRun = !state.lastScanAt;
  const now = new Date().toISOString();
  const alertDelta = Number(config.watch.alertScoreDelta || 5);
  const newCandidates = [];

  for (const candidate of candidates) {
    const previous = state.wallets[candidate.address];
    const isNew = !previous;
    const scoreDelta = previous
      ? Number(candidate.score?.score || 0) - Number(previous.lastScore || 0)
      : 0;
    const becameRecommended =
      previous &&
      candidate.score?.status === "recommended" &&
      previous.status !== "recommended";

    if (
      candidate.score?.status === "recommended" &&
      (isNew || scoreDelta >= alertDelta || becameRecommended)
    ) {
      newCandidates.push(candidate);
    }

    state.wallets[candidate.address] = {
      address: candidate.address,
      short: candidate.short,
      firstSeen: previous?.firstSeen || now,
      lastSeen: now,
      lastScore: candidate.score?.score ?? null,
      bestScore: Math.max(
        Number(previous?.bestScore || 0),
        Number(candidate.score?.score || 0),
      ),
      lastTier: candidate.score?.tier ?? null,
      status: candidate.score?.status ?? "unknown",
      pools: (candidate.pools || []).map((pool) => ({
        address: pool.address,
        name: pool.name,
      })),
      lastReasons: candidate.score?.reasons || [],
      lastWarnings: candidate.score?.warnings || [],
    };
  }

  state.lastScanAt = meta?.generatedAt || now;
  state.lastMeta = {
    poolsScanned: meta?.poolsScanned ?? null,
    candidatesFound: meta?.candidatesFound ?? null,
    deepChecked: meta?.deepChecked ?? null,
    recommended: meta?.recommended ?? null,
    durationMs: meta?.durationMs ?? null,
  };
  saveState(statePath, state);

  return { newCandidates, firstRun, state };
}
