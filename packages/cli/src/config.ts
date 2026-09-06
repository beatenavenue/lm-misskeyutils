import { type LogLevel, normalizeOrigin, type RetryPolicy } from '@lm/core';
import { z } from 'zod';

/** Environment-like input (`process.env`). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface Config {
  origin: string;
  token: string;
  retry: RetryPolicy;
  logLevel: LogLevel;
  /** Path of the log file, or `null` for console only. */
  logFile: string | null;
  /** IANA time zone used to format log timestamps. */
  logTimeZone: string;
  deleteRule: string;
  printNotes: boolean;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const boolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const v = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off', ''].includes(v)) return false;
  return value;
}, z.boolean());

const seconds = z.coerce.number().nonnegative();

const LOG_LEVEL_ALIASES: Record<string, LogLevel> = {
  debug: 'debug',
  notset: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  critical: 'error',
  fatal: 'error',
};

const logLevel = z.preprocess(
  (value) => (typeof value === 'string' ? (LOG_LEVEL_ALIASES[value.trim().toLowerCase()] ?? value) : value),
  z.enum(['debug', 'info', 'warn', 'error']),
);

const EnvSchema = z.object({
  LM_ORIGIN: z.string().trim().min(1).optional(),
  LM_BASE_URL: z.string().trim().min(1).optional(),
  LM_API_TOKEN: z.string({ error: 'LM_API_TOKEN is required' }).trim().min(1, 'LM_API_TOKEN is required'),
  LM_POLL_BASE: seconds.default(3),
  LM_POLL_NETERROR: seconds.default(300),
  LM_POLL_RATELIMIT_BASE: seconds.default(600),
  LM_POLL_RATELIMIT_MAX: seconds.default(43200),
  LM_NETERROR_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  LM_LOGLEVEL: logLevel.default('info'),
  LM_LOGFILE: boolean.default(false),
  LM_LOGFILENAME: z.string().trim().min(1).default('limitmanage.log'),
  LM_LOG_TIMEZONE: z.string().trim().min(1).default('Asia/Tokyo'),
  LM_DELETERULE: z.string().trim().min(1).default('deleterule.json'),
  LM_DELETE_STEP2PRINT: boolean.default(false),
});

const DEPRECATED = ['LM_DEBUGLEVEL', 'LM_USERAGENT'] as const;

export function isValidTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Only `LM_*` keys with a non-empty value take part in validation. */
function pickLmVars(env: EnvSource): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('LM_') && value !== undefined && value !== '') picked[key] = value;
  }
  return picked;
}

export interface LoadedConfig {
  config: Config;
  /** Compatibility and deprecation notices to log at startup. */
  warnings: string[];
}

/**
 * Build the configuration from environment variables (plan §5.1). Callers
 * apply CLI arguments on top and load `.env` beforehand with `loadEnvFile`.
 */
export function loadConfig(env: EnvSource): LoadedConfig {
  const warnings: string[] = [];
  const vars = pickLmVars(env);
  const problems: string[] = [];
  if (vars.LM_ORIGIN === undefined && vars.LM_BASE_URL === undefined) {
    problems.push('✖ LM_ORIGIN is required (e.g. https://misskey.io)');
  }
  const parsed = EnvSchema.safeParse(vars);
  if (!parsed.success) problems.push(z.prettifyError(parsed.error));
  if (problems.length > 0 || !parsed.success) {
    throw new ConfigError(`invalid configuration:\n${problems.join('\n')}`);
  }
  const e = parsed.data;
  const rawOrigin = (e.LM_ORIGIN ?? e.LM_BASE_URL) as string;
  const { origin, changed } = normalizeOrigin(rawOrigin);
  if (e.LM_ORIGIN === undefined) {
    warnings.push(`LM_BASE_URL is deprecated; set LM_ORIGIN=${origin} instead`);
  } else if (changed) {
    warnings.push(`LM_ORIGIN should be the server origin without /api; using ${origin}`);
  }

  let logTimeZone = e.LM_LOG_TIMEZONE;
  if (!isValidTimeZone(logTimeZone)) {
    warnings.push(`invalid LM_LOG_TIMEZONE=${logTimeZone}, falling back to UTC`);
    logTimeZone = 'UTC';
  }

  for (const key of DEPRECATED) {
    if (vars[key] !== undefined) warnings.push(`${key} is no longer used and was ignored`);
  }

  return {
    config: {
      origin,
      token: e.LM_API_TOKEN,
      retry: {
        pollBase: e.LM_POLL_BASE,
        netErrorWait: e.LM_POLL_NETERROR,
        maxNetErrorRetries: e.LM_NETERROR_MAX_RETRIES,
        rateLimitBase: e.LM_POLL_RATELIMIT_BASE,
        rateLimitMax: e.LM_POLL_RATELIMIT_MAX,
        pollBaseOverrides: { 'users/show': 0 },
      },
      logLevel: e.LM_LOGLEVEL,
      logFile: e.LM_LOGFILE ? e.LM_LOGFILENAME : null,
      logTimeZone,
      deleteRule: e.LM_DELETERULE,
      printNotes: e.LM_DELETE_STEP2PRINT,
    },
    warnings,
  };
}

/**
 * Load a `.env` file into `process.env` with Node's built-in parser
 * (`process.loadEnvFile`, plan §3.5). Variables that are already set win over
 * the file. Returns `false` when the file does not exist.
 */
export function loadEnvFile(path: string): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
