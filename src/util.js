export function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function round(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(digits));
}

export function mean(values) {
  const list = values.filter((value) => Number.isFinite(value));
  if (list.length === 0) return 0;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

export function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return 0;
  const middle = Math.floor(list.length / 2);
  if (list.length % 2 === 1) return list[middle];
  return (list[middle - 1] + list[middle]) / 2;
}

/**
 * Recency score 0..10. Lower days = fresher.
 */
export function recencyScoreDays(days) {
  if (!Number.isFinite(days)) return 0;
  if (days <= 2) return 10;
  if (days <= 7) return 8;
  if (days <= 14) return 6;
  if (days <= 30) return 4;
  if (days <= 60) return 1;
  return 0;
}

export function daysBetween(timestampMs, now = Date.now()) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - timestampMs) / 86_400_000);
}

export function parseTimestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function shortAddress(address, size = 6) {
  const text = String(address || "");
  if (text.length <= size * 2 + 3) return text;
  return `${text.slice(0, size)}...${text.slice(-4)}`;
}
