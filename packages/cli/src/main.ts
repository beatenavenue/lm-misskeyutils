#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  createClient,
  createDefaultDeps,
  describeError,
  ExportFormatError,
  isAbortError,
  isApiError,
  type RawFetch,
  RetryExhaustedError,
  RuleConfigError,
  type UserAction,
} from '@lm/core';
import { daysExpireCommand } from './commands/daysExpire.js';
import { usersFromListCommand } from './commands/usersFromList.js';
import { type Config, ConfigError, type EnvSource, loadConfig, loadEnvFile } from './config.js';
import { createLogger } from './logger.js';
import { createProgressReporter } from './progress.js';
import { USER_AGENT, VERSION } from './version.js';

export const USAGE = `Usage: lm <command> [options]

Commands:
  days-expire        delete old notes according to the delete rule file
  mute-from-list     mute every account listed in a text file (default mute.txt)
  block-from-list    block every account listed in a text file (default block.txt)

Options:
  -n, --dry-run          report what would be done, never call write APIs
      --dotenv <path>    .env file to load (default: .env; environment wins)
      --log-level <lvl>  debug | info | warn | error (overrides LM_LOGLEVEL)
      --rules <path>     days-expire: delete rule file (overrides LM_DELETERULE)
      --export <src>     days-expire: auto | none | <path> to a Misskey notes export (default: auto)
      --print-notes      days-expire: print all fetched notes as JSON to stdout (LM_DELETE_STEP2PRINT)
      --no-progress      do not draw the wait countdown
  -h, --help             show this help
  -V, --version          show the version

Examples:
  lm days-expire --dry-run
  lm mute-from-list mute.txt
`;

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | {
      kind: 'days-expire';
      dryRun: boolean;
      envFile: string;
      logLevel?: string;
      rules?: string;
      exportSource: string;
      printNotes: boolean;
      progress: boolean;
    }
  | {
      kind: 'users-from-list';
      action: UserAction;
      listPath: string;
      dryRun: boolean;
      envFile: string;
      logLevel?: string;
      progress: boolean;
    };

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  const options = {
    'dry-run': { type: 'boolean', short: 'n', default: false },
    dotenv: { type: 'string', default: '.env' },
    'log-level': { type: 'string' },
    rules: { type: 'string' },
    export: { type: 'string', default: 'auto' },
    'print-notes': { type: 'boolean', default: false },
    'no-progress': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'V', default: false },
  } as const;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  const [command, ...rest] = positionals;
  if (command === undefined) throw new UsageError('missing command');
  const common = {
    dryRun: values['dry-run'],
    envFile: values.dotenv,
    ...(values['log-level'] === undefined ? {} : { logLevel: values['log-level'] }),
    progress: !values['no-progress'],
  };

  switch (command) {
    case 'days-expire':
      if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
      return {
        kind: 'days-expire',
        ...common,
        ...(values.rules === undefined ? {} : { rules: values.rules }),
        exportSource: values.export,
        printNotes: values['print-notes'],
      };
    case 'mute-from-list':
    case 'block-from-list': {
      if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
      const action: UserAction = command === 'mute-from-list' ? 'mute' : 'block';
      return { kind: 'users-from-list', action, listPath: rest[0] ?? `${action}.txt`, ...common };
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

export interface CliIo {
  env: EnvSource;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  cwd: string;
  /** Override the HTTP fetch (tests). */
  fetch?: RawFetch;
  /** Aborts the run (Ctrl-C). */
  signal?: AbortSignal;
}

function applyLogLevel(config: Config, level: string | undefined): Config {
  if (level === undefined) return config;
  const normalized = level.toLowerCase();
  if (normalized !== 'debug' && normalized !== 'info' && normalized !== 'warn' && normalized !== 'error') {
    throw new UsageError(`invalid --log-level: ${level}`);
  }
  return { ...config, logLevel: normalized };
}

/** Run the CLI; returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    io.stderr.write(`lm: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (command.kind === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }
  if (command.kind === 'version') {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  loadEnvFile(command.envFile);
  let config: Config;
  let warnings: string[];
  try {
    ({ config, warnings } = loadConfig(io.env));
    config = applyLogLevel(config, command.logLevel);
  } catch (error) {
    io.stderr.write(`lm: ${(error as Error).message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }

  const reporter = createProgressReporter(io.stderr, command.progress);
  const logger = createLogger({
    level: config.logLevel,
    timeZone: config.logTimeZone,
    filePath: config.logFile,
    stream: io.stderr,
    beforeConsoleWrite: reporter.clear,
  });
  for (const warning of warnings) logger.warn(warning);
  logger.debug(`lm ${VERSION} origin=${config.origin} dry-run=${command.dryRun}`);

  const deps = createDefaultDeps({ logger, progress: reporter.progress, ...(io.signal ? { signal: io.signal } : {}) });
  const client = createClient({
    origin: config.origin,
    token: config.token,
    retry: config.retry,
    headers: { 'User-Agent': USER_AGENT },
    ...(io.fetch ? { fetch: io.fetch } : {}),
    deps,
  });

  try {
    if (command.kind === 'days-expire') {
      const result = await daysExpireCommand(client, deps, {
        rulesPath: command.rules ?? config.deleteRule,
        exportSource: command.exportSource,
        dryRun: command.dryRun,
        printNotes: command.printNotes || config.printNotes,
        cwd: io.cwd,
        stdout: io.stdout,
      });
      if (!result.dryRun) {
        logger.info(`done: deleted ${result.deleted} of ${result.deleteIds.length} targets (${result.failed} failed)`);
      }
      return 0;
    }
    const result = await usersFromListCommand(client, deps, {
      action: command.action,
      listPath: command.listPath,
      dryRun: command.dryRun,
    });
    logger.info(
      `done: ${result.dryRun ? 'would ' : ''}${result.action} ${result.done} of ${result.total} accounts ` +
        `(${result.skipped} already done, ${result.unresolved} not found)`,
    );
    return 0;
  } catch (error) {
    reporter.clear();
    if (isAbortError(error)) {
      logger.error('aborted');
      return 130;
    }
    if (
      error instanceof RuleConfigError ||
      error instanceof ExportFormatError ||
      error instanceof RetryExhaustedError ||
      isApiError(error)
    ) {
      logger.error(describeError(error));
      return 1;
    }
    if (error instanceof Error && !(error instanceof ConfigError)) {
      logger.error(error.message);
      return 1;
    }
    throw error;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === new URL(`file://${entry}`).href;
}

if (isMain()) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runCli(process.argv.slice(2), {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    signal: controller.signal,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
