import { shortAddress } from "./util.js";

const DEFAULTS = {
  maxPerCluster: 2,
  maxPerPool: 4,
  fundingWindowMinutes: 1,
};

function funderOf(candidate) {
  const hygiene = candidate?.metrics?.hygiene || candidate?.hygiene;
  if (!hygiene?.enabled) return null;
  const funder = String(hygiene.funder || "").trim();
  if (!funder) return null;
  // Programs fund thousands of wallets; they are not a person.
  if (hygiene.funderType === "program") return null;
  return funder;
}

function fundedAtMs(candidate) {
  const hygiene = candidate?.metrics?.hygiene || candidate?.hygiene;
  const value = Date.parse(String(hygiene?.fundedAt ?? ""));
  return Number.isFinite(value) ? value : null;
}

export function poolAddressesOf(candidate) {
  const pools = new Set();
  const add = (value) => {
    const address = String(value || "").trim();
    if (address) pools.add(address);
  };

  for (const pool of candidate?.pools || []) add(pool?.address);
  for (const pool of candidate?.candidate?.pools || []) add(pool?.address);
  for (const pool of candidate?.metrics?.poolBreakdown || []) add(pool?.pool);
  for (const pool of candidate?.poolsChecked || []) add(pool?.address);

  return [...pools];
}

function makeUnionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (node) => {
    let current = node;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  return { find, union };
}

/**
 * Group wallets that are probably controlled by the same person: same funding
 * wallet, or funded in the same moment while trading the same pool.
 */
export function clusterCandidates(candidates, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const windowMs =
    Math.max(0, Number(config.fundingWindowMinutes) || 0) * 60_000;
  const list = (candidates || []).filter((candidate) => candidate?.address);

  const pools = list.map(poolAddressesOf);
  const funders = list.map(funderOf);
  const fundedAt = list.map(fundedAtMs);
  const { find, union } = makeUnionFind(list.length);

  for (let left = 0; left < list.length; left += 1) {
    for (let right = left + 1; right < list.length; right += 1) {
      const sameFunder =
        funders[left] && funders[right] && funders[left] === funders[right];
      if (sameFunder) {
        union(left, right);
        continue;
      }

      // Same funding moment plus a shared pool is a strong sybil signal, but
      // only when the window is enabled.
      if (windowMs <= 0) continue;
      if (fundedAt[left] == null || fundedAt[right] == null) continue;
      if (Math.abs(fundedAt[left] - fundedAt[right]) > windowMs) continue;
      const shared = pools[left].some((pool) => pools[right].includes(pool));
      if (shared) union(left, right);
    }
  }

  const groups = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(index);
  }

  const clusters = [];
  const byAddress = {};
  const indexOf = new Map(list.map((candidate, index) => [candidate.address, index]));

  for (const indexes of groups.values()) {
    const members = indexes.map((index) => list[index]);
    const first = members[0];
    const isCluster = members.length > 1;

    let sharedPools = [];
    if (isCluster) {
      const counts = new Map();
      for (const index of indexes) {
        for (const pool of pools[index]) {
          counts.set(pool, (counts.get(pool) || 0) + 1);
        }
      }
      sharedPools = [...counts.entries()]
        .filter(([, count]) => count === indexes.length)
        .map(([pool]) => pool);
    }

    const scores = members
      .map((candidate) => Number(candidate.score?.score))
      .filter((score) => Number.isFinite(score));
    const recommended = members.filter(
      (candidate) => candidate.score?.status === "recommended",
    ).length;
    const funder = funders[indexOf.get(first.address)] || null;

    const cluster = {
      id: isCluster
        ? `c${clusters.length + 1}`
        : `solo:${first.address}`,
      size: members.length,
      isCluster,
      funder,
      funderShort: funder ? shortAddress(funder) : null,
      fundedAt: fundedAt[indexOf.get(first.address)]
        ? new Date(fundedAt[indexOf.get(first.address)]).toISOString()
        : null,
      addresses: members.map((candidate) => candidate.address),
      sharedPools,
      avgScore:
        scores.length > 0
          ? Math.round(
              (scores.reduce((sum, score) => sum + score, 0) / scores.length) *
                10,
            ) / 10
          : null,
      recommended,
    };

    if (isCluster) clusters.push(cluster);
    for (const candidate of members) byAddress[candidate.address] = cluster.id;
  }

  const allClusters = new Map(
    [...clusters, ...list
      .filter((candidate) => !clusters.some((cluster) => cluster.addresses.includes(candidate.address)))
      .map((candidate) => ({
        id: `solo:${candidate.address}`,
        size: 1,
        isCluster: false,
        addresses: [candidate.address],
      }))]
      .map((cluster) => [cluster.id, cluster]),
  );

  clusters.sort((left, right) => right.size - left.size || right.avgScore - left.avgScore);

  return {
    clusters,
    byAddress,
    clusterOf: (address) => allClusters.get(byAddress[address]) || null,
    analyzed: list.length,
    clusteredWallets: clusters.reduce((sum, cluster) => sum + cluster.size, 0),
  };
}

/**
 * Greedy selection that keeps the list diverse: no more than maxPerCluster
 * wallets from one group and no more than maxPerPool wallets touching one pool.
 */
export function selectDiverse(candidates, analysis, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const maxPerCluster = Math.max(0, Number(config.maxPerCluster) || 0);
  const maxPerPool = Math.max(0, Number(config.maxPerPool) || 0);
  const limit = Number(config.limit) > 0 ? Number(config.limit) : null;

  const sorted = [...(candidates || [])].sort(
    (left, right) =>
      Number(right.score?.score || 0) - Number(left.score?.score || 0),
  );

  const selected = [];
  const skipped = [];
  const clusterCounts = new Map();
  const poolCounts = new Map();

  for (const candidate of sorted) {
    if (limit && selected.length >= limit) {
      skipped.push({ address: candidate.address, reason: "limit" });
      continue;
    }

    const clusterId =
      analysis?.byAddress?.[candidate.address] || `solo:${candidate.address}`;
    const clusterCount = clusterCounts.get(clusterId) || 0;
    if (maxPerCluster > 0 && clusterCount >= maxPerCluster) {
      skipped.push({
        address: candidate.address,
        reason: "cluster",
        clusterId,
      });
      continue;
    }

    const pools = poolAddressesOf(candidate);
    const saturated = pools.filter(
      (pool) => (poolCounts.get(pool) || 0) >= maxPerPool,
    );
    if (maxPerPool > 0 && pools.length > 0 && saturated.length === pools.length) {
      skipped.push({ address: candidate.address, reason: "pool" });
      continue;
    }

    selected.push(candidate);
    clusterCounts.set(clusterId, clusterCount + 1);
    for (const pool of pools) {
      poolCounts.set(pool, (poolCounts.get(pool) || 0) + 1);
    }
  }

  return { selected, skipped };
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatClusterReport(analysis, options = {}) {
  const { limit = 5, poolNames = {} } = options;
  const lines = ["🧩 <b>Cluster analysis</b>"];

  if (!analysis || analysis.analyzed === 0) {
    return (
      "🧩 <b>Cluster analysis</b>\n" +
      "No scan data yet. Run a scan first, then try /clusters again."
    );
  }

  lines.push(
    "",
    `Analyzed: <b>${analysis.analyzed}</b> wallet(s) · ` +
      `clusters: <b>${analysis.clusters.length}</b> · ` +
      `grouped wallets: ${analysis.clusteredWallets}`,
  );

  if (analysis.clusters.length === 0) {
    lines.push(
      "",
      "No shared funders detected in this scan. Wallets look independent.",
    );
    return lines.join("\n");
  }

  lines.push("", "<b>Groups found</b>");
  analysis.clusters.slice(0, limit).forEach((cluster) => {
    const funder = cluster.funderShort
      ? `funder <code>${escapeHtml(cluster.funderShort)}</code>`
      : "shared funding pattern";
    lines.push(
      `• <b>${cluster.id}</b> — ${cluster.size} wallets · ${funder} · ` +
        `avg score ${cluster.avgScore ?? "-"} · ${cluster.recommended} recommended`,
    );
    if (cluster.sharedPools.length > 0) {
      const names = cluster.sharedPools
        .slice(0, 3)
        .map((pool) => poolNames[pool] || shortAddress(pool));
      lines.push(`  pools: ${escapeHtml(names.join(", "))}`);
    }
    lines.push(
      `  ${escapeHtml(
        cluster.addresses.map((address) => shortAddress(address)).join(", "),
      )}`,
    );
  });

  lines.push(
    "",
    "<i>Same funder or same funding moment + shared pool. Use /exporttxt diverse " +
      "to cap wallets per group.</i>",
  );
  return lines.join("\n");
}

export function formatDiversityPreview(selection) {
  const lines = [
    `✅ <b>Diverse selection</b>: ${selection.selected.length} wallet(s) kept`,
  ];
  if (selection.skipped.length === 0) {
    lines.push("No wallet was dropped for diversity.");
    return lines.join("\n");
  }
  const reasons = selection.skipped.reduce((acc, item) => {
    acc[item.reason] = (acc[item.reason] || 0) + 1;
    return acc;
  }, {});
  lines.push(
    `Dropped: ${selection.skipped.length} ` +
      `(cluster ${reasons.cluster || 0}, pool ${reasons.pool || 0}, ` +
      `limit ${reasons.limit || 0})`,
  );
  selection.skipped.slice(0, 5).forEach((item) => {
    lines.push(`• <code>${shortAddress(item.address)}</code> — ${item.reason}`);
  });
  return lines.join("\n");
}
