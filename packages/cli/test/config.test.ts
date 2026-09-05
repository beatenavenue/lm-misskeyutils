import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, isValidTimeZone, loadConfig, loadEnvFile } from '../src/config.js';

const base = { LM_ORIGIN: 'https://misskey.example', LM_API_TOKEN: 'tok' };

describe('loadConfig', () => {
  it('applies defaults (plan §5.1)', () => {
    const { config, warnings } = loadConfig(base);
    expect(config).toEqual({
      origin: 'https://misskey.example',
      token: 'tok',
      retry: {
        pollBase: 3,
        netErrorWait: 300,
        maxNetErrorRetries: 5,
        rateLimitBase: 600,
        rateLimitMax: 43200,
        pollBaseOverrides: { 'users/show': 0 },
      },
      logLevel: 'info',
      logFile: null,
      logTimeZone: 'Asia/Tokyo',
      deleteRule: 'deleterule.json',
      printNotes: false,
    });
    expect(warnings).toEqual([]);
  });

  it('reads every LM_* variable', () => {
    const { config } = loadConfig({
      ...base,
      LM_POLL_BASE: '1',
      LM_POLL_NETERROR: '2',
      LM_POLL_RATELIMIT_BASE: '3',
      LM_POLL_RATELIMIT_MAX: '4',
      LM_NETERROR_MAX_RETRIES: '9',
      LM_LOGLEVEL: 'DEBUG',
      LM_LOGFILE: 'True',
      LM_LOGFILENAME: 'x.log',
      LM_LOG_TIMEZONE: 'UTC',
      LM_DELETERULE: 'r.json',
      LM_DELETE_STEP2PRINT: 'true',
    });
    expect(config.retry).toMatchObject({
      pollBase: 1,
      netErrorWait: 2,
      rateLimitBase: 3,
      rateLimitMax: 4,
      maxNetErrorRetries: 9,
    });
    expect(config).toMatchObject({
      logLevel: 'debug',
      logFile: 'x.log',
      logTimeZone: 'UTC',
      deleteRule: 'r.json',
      printNotes: true,
    });
  });

  it.each([
    ['WARNING', 'warn'],
    ['critical', 'error'],
    ['NOTSET', 'debug'],
    ['Info', 'info'],
  ])('maps Python log level %s to %s', (input, expected) => {
    expect(loadConfig({ ...base, LM_LOGLEVEL: input }).config.logLevel).toBe(expected);
  });

  it('accepts the old LM_BASE_URL with a deprecation warning', () => {
    const { config, warnings } = loadConfig({ LM_BASE_URL: 'https://misskey.io/api', LM_API_TOKEN: 'tok' });
    expect(config.origin).toBe('https://misskey.io');
    expect(warnings).toEqual(['LM_BASE_URL is deprecated; set LM_ORIGIN=https://misskey.io instead']);
  });

  it('prefers LM_ORIGIN over LM_BASE_URL and strips /api', () => {
    const { config, warnings } = loadConfig({
      ...base,
      LM_ORIGIN: 'https://a.example/api/',
      LM_BASE_URL: 'https://b.example/api',
    });
    expect(config.origin).toBe('https://a.example');
    expect(warnings).toEqual(['LM_ORIGIN should be the server origin without /api; using https://a.example']);
  });

  it('warns about removed variables and invalid time zones', () => {
    const { config, warnings } = loadConfig({
      ...base,
      LM_DEBUGLEVEL: '1',
      LM_USERAGENT: 'x',
      LM_LOG_TIMEZONE: 'Mars/Olympus',
    });
    expect(config.logTimeZone).toBe('UTC');
    expect(warnings).toEqual([
      'invalid LM_LOG_TIMEZONE=Mars/Olympus, falling back to UTC',
      'LM_DEBUGLEVEL is no longer used and was ignored',
      'LM_USERAGENT is no longer used and was ignored',
    ]);
  });

  it.each([
    ['missing origin', { LM_API_TOKEN: 'tok' }, /LM_ORIGIN is required/],
    ['missing token', { LM_ORIGIN: 'https://x' }, /LM_API_TOKEN/],
    ['bad number', { ...base, LM_POLL_BASE: 'soon' }, /LM_POLL_BASE/],
    ['bad boolean', { ...base, LM_LOGFILE: 'maybe' }, /LM_LOGFILE/],
    ['bad level', { ...base, LM_LOGLEVEL: 'loud' }, /LM_LOGLEVEL/],
  ])('rejects %s', (_label, env, pattern) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(pattern);
  });

  it('ignores empty values and non-LM variables', () => {
    const { config } = loadConfig({ ...base, LM_POLL_BASE: '', PATH: '/bin', HOME: '' });
    expect(config.retry.pollBase).toBe(3);
  });

  it('isValidTimeZone', () => {
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
    expect(isValidTimeZone('Nowhere/Land')).toBe(false);
  });
});

describe('loadEnvFile', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('LM_T_')) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('fills process.env without overriding existing variables and tolerates a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, "LM_T_A=file\nLM_T_B='quoted # value'\n");
    process.env.LM_T_A = 'env';

    expect(loadEnvFile(file)).toBe(true);
    expect(process.env.LM_T_A).toBe('env');
    expect(process.env.LM_T_B).toBe('quoted # value');
    expect(loadEnvFile(join(dir, 'missing.env'))).toBe(false);
  });
});
