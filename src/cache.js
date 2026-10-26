import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class Cache {
  constructor(directory, { enabled = true } = {}) {
    this.directory = directory;
    this.enabled = enabled;
    fs.mkdirSync(this.directory, { recursive: true });
  }

  fileFor(key) {
    const hash = crypto.createHash("sha1").update(key).digest("hex").slice(0, 10);
    const safe = String(key)
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 90);
    return path.join(this.directory, `${safe}-${hash}.json`);
  }

  get(key, ttlMs) {
    if (!this.enabled) return null;
    try {
      const file = this.fileFor(key);
      if (!fs.existsSync(file)) return null;
      const payload = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!payload || typeof payload.savedAt !== "number") return null;
      if (Number.isFinite(ttlMs) && Date.now() - payload.savedAt > ttlMs) return null;
      return payload.value;
    } catch {
      return null;
    }
  }

  set(key, value) {
    if (!this.enabled) return;
    try {
      const file = this.fileFor(key);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ savedAt: Date.now(), value }, null, 2),
        "utf8",
      );
      fs.renameSync(tmp, file);
    } catch {
      // Cache failures should not break a scan.
    }
  }

  clear() {
    try {
      for (const entry of fs.readdirSync(this.directory)) {
        if (entry.endsWith(".json") || entry.endsWith(".tmp")) {
          fs.rmSync(path.join(this.directory, entry), { force: true });
        }
      }
    } catch {
      // ignore
    }
  }

  stats() {
    try {
      const files = fs
        .readdirSync(this.directory)
        .filter((entry) => entry.endsWith(".json"));
      let bytes = 0;
      for (const file of files) {
        try {
          bytes += fs.statSync(path.join(this.directory, file)).size;
        } catch {
          // ignore
        }
      }
      return { files: files.length, bytes };
    } catch {
      return { files: 0, bytes: 0 };
    }
  }
}
