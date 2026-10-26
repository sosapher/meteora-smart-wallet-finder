import fs from "node:fs";

const LEVEL_ORDER = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export function createLogger({ verbose = false, logFile = null } = {}) {
  const write = (level, message) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
    if (level === "ERROR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);

    if (logFile) {
      try {
        fs.appendFileSync(logFile, `${line}\n`);
      } catch {
        // Logging must never crash the bot.
      }
    }
  };

  return {
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
    debug: (message) => {
      if (verbose) write("DEBUG", message);
    },
    levelEnabled: (level) => verbose || LEVEL_ORDER[level] >= LEVEL_ORDER.INFO,
    plain: (...args) => console.log(...args),
  };
}
