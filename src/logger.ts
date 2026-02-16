const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

export class Logger {
  private level: number;

  constructor(level: string = 'info') {
    this.level = LEVELS[level] ?? LEVELS.info;
  }

  private ts(): string {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  private log(level: string, color: string, prefix: string, msg: string): void {
    if ((LEVELS[level] ?? 0) < this.level) return;
    console.log(
      `${COLORS.dim}${this.ts()}${COLORS.reset} ${color}${prefix}${COLORS.reset} ${msg}`
    );
  }

  debug(msg: string): void {
    this.log('debug', COLORS.dim, '[DEBUG]', msg);
  }

  info(msg: string): void {
    this.log('info', COLORS.cyan, '[INFO] ', msg);
  }

  success(msg: string): void {
    this.log('info', COLORS.green, '[OK]   ', msg);
  }

  warn(msg: string): void {
    this.log('warn', COLORS.yellow, '[WARN] ', msg);
  }

  error(msg: string): void {
    this.log('error', COLORS.red, '[ERROR]', msg);
  }

  task(msg: string): void {
    this.log('info', COLORS.magenta, '[TASK] ', msg);
  }
}
