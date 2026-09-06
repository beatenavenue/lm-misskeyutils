/**
 * @lm/core — environment-independent logic for lm-misskeyutils.
 *
 * This package must not touch Node-only APIs, the environment, the console or
 * timers directly (REFACTORING_PLAN.md §3.2). Those come in through ports.
 */
export type { APIClient } from 'misskey-js/api.js';
export { type CreateClientOptions, createClient, type NormalizedOrigin, normalizeOrigin } from './client.js';
export { createDefaultDeps, defaultSleep, noopLogger, systemClock } from './defaults.js';
export {
  type APIError,
  describeError,
  getHttpStatus,
  isAbortError,
  isApiError,
  OperationAbortedError,
  RetryExhaustedError,
  throwIfAborted,
} from './errors.js';
export {
  type ExportedNote,
  ExportFormatError,
  type MergeResult,
  mergeNotes,
  parseExportedNotes,
} from './export/index.js';
export * from './notes/index.js';
export type { Clock, CoreDeps, Logger, LogLevel, Progress, ProgressEvent, Sleep, WaitReason } from './ports.js';
export * from './retry/index.js';
export * from './rules/index.js';
export {
  formatUserRef,
  parseUserList,
  parseUserRef,
  type ResolvedUser,
  resolveUserIds,
  runUserAction,
  type UserAction,
  type UserActionOptions,
  type UserActionResult,
  type UserRef,
} from './users/index.js';
