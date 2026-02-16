/**
 * Simple logger with colored output and level filtering.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

class Logger {
  constructor(level = 'info') {
    this.level = LEVELS[level] ?? LEVELS.info;
  }

  _ts() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  _log(level, color, prefix, msg) {
    if (LEVELS[level] < this.level) return;
    console.log(
      `${COLORS.dim}${this._ts()}${COLORS.reset} ${color}${prefix}${COLORS.reset} ${msg}`
    );
  }

  debug(msg) {
    this._log('debug', COLORS.dim, '[DEBUG]', msg);
  }

  info(msg) {
    this._log('info', COLORS.cyan, '[INFO] ', msg);
  }

  success(msg) {
    this._log('info', COLORS.green, '[OK]   ', msg);
  }

  warn(msg) {
    this._log('warn', COLORS.yellow, '[WARN] ', msg);
  }

  error(msg) {
    this._log('error', COLORS.red, '[ERROR]', msg);
  }

  task(msg) {
    this._log('info', COLORS.magenta, '[TASK] ', msg);
  }
}

module.exports = Logger;
