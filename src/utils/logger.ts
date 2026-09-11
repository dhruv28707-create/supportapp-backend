type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = (): LogLevel => {
  const env = process.env.LOG_LEVEL?.toLowerCase() as LogLevel;
  return LOG_LEVELS[env] !== undefined ? env : 'info';
};

const formatMessage = (level: LogLevel, context: string, message: string, data?: unknown): string => {
  const timestamp = new Date().toISOString();
  const levelStr = level.toUpperCase().padEnd(5);
  const base = `[${timestamp}] ${levelStr} [${context}] ${message}`;
  return data !== undefined ? `${base} ${JSON.stringify(data)}` : base;
};

const shouldLog = (level: LogLevel): boolean => LOG_LEVELS[level] >= LOG_LEVELS[currentLevel()];

export const logger = {
  debug(context: string, message: string, data?: unknown): void {
    if (shouldLog('debug')) console.debug(formatMessage('debug', context, message, data));
  },
  info(context: string, message: string, data?: unknown): void {
    if (shouldLog('info')) console.info(formatMessage('info', context, message, data));
  },
  warn(context: string, message: string, data?: unknown): void {
    if (shouldLog('warn')) console.warn(formatMessage('warn', context, message, data));
  },
  error(context: string, message: string, data?: unknown): void {
    if (shouldLog('error')) console.error(formatMessage('error', context, message, data));
  },
};
