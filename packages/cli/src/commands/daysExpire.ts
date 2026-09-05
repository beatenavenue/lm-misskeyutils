import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type APIClient,
  type CoreDeps,
  type DaysExpireResult,
  type ExportedNote,
  ExportFormatError,
  parseExportedNotes,
  parseRules,
  runDaysExpire,
} from '@lm/core';

export const EXPORT_DIR = 'exported_files';

export interface DaysExpireCommandOptions {
  rulesPath: string;
  /** `auto` (latest `exported_files/notes-*.json`), `none`, or a file path. */
  exportSource: string;
  dryRun: boolean;
  printNotes: boolean;
  cwd: string;
  stdout: NodeJS.WritableStream;
}

/** Latest `notes-YYYY-MM-DD-HH-mm-SS.json` in `dir` by file name order, or `null`. */
export function findLatestExport(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = names.filter((name) => /^notes-.*\.json$/.test(name)).sort();
  const latest = candidates.at(-1);
  return latest === undefined ? null : join(dir, latest);
}

export function loadRulesFile(path: string) {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read delete rules ${path}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`delete rules ${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseRules(json);
}

function loadExport(path: string, deps: CoreDeps): ExportedNote[] | undefined {
  deps.logger.info(`step 2.2 will merge notes from json: ${path}`);
  try {
    return parseExportedNotes(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof ExportFormatError || error instanceof SyntaxError) {
      deps.logger.warn(`failed to read exported json ${path}, skipping merge: ${error.message}`);
      return undefined;
    }
    throw error;
  }
}

export async function daysExpireCommand(
  client: APIClient,
  deps: CoreDeps,
  opts: DaysExpireCommandOptions,
): Promise<DaysExpireResult> {
  const rules = loadRulesFile(opts.rulesPath);
  deps.logger.info(`delete rules: ${opts.rulesPath} (${rules.map((r) => r.day).join(', ')} days)`);

  let exportedNotes: ExportedNote[] | undefined;
  if (opts.exportSource === 'auto') {
    const latest = findLatestExport(join(opts.cwd, EXPORT_DIR));
    if (latest === null) deps.logger.info(`no exported notes json found in ${EXPORT_DIR}; skipping step2.2`);
    else exportedNotes = loadExport(latest, deps);
  } else if (opts.exportSource !== 'none') {
    exportedNotes = loadExport(opts.exportSource, deps);
  }

  const result = await runDaysExpire(client, {
    ...deps,
    rules,
    dryRun: opts.dryRun,
    ...(exportedNotes === undefined ? {} : { exportedNotes }),
    ...(opts.printNotes
      ? {
          onNotesListed: (notes: readonly unknown[]) => {
            opts.stdout.write(`${JSON.stringify(notes)}\n`);
          },
        }
      : {}),
  });

  if (opts.dryRun) {
    opts.stdout.write(`${result.deleteIds.length} notes would be deleted (dry-run)\n`);
    for (const id of result.deleteIds) opts.stdout.write(`${id}\n`);
  }
  return result;
}
