import { api } from 'misskey-js';

export type APIError = api.APIError;

export class OperationAbortedError extends Error {
  override readonly name = 'OperationAbortedError';

  constructor(message = 'operation aborted') {
    super(message);
  }
}

/** Thrown when a request keeps failing with 5xx / network errors beyond `maxNetErrorRetries`. */
export class RetryExhaustedError extends Error {
  override readonly name = 'RetryExhaustedError';

  constructor(
    readonly endpoint: string,
    readonly attempts: number,
    readonly lastStatus: number | undefined,
    options?: { cause?: unknown },
  ) {
    super(
      lastStatus === undefined
        ? `${endpoint}: giving up after ${attempts} attempts (network errors)`
        : `${endpoint}: giving up after ${attempts} attempts (last HTTP status ${lastStatus})`,
      options,
    );
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new OperationAbortedError();
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof OperationAbortedError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError')
  );
}

/** `true` for the error objects misskey-js `APIClient.request()` rejects with. */
export function isApiError(error: unknown): error is APIError {
  return typeof error === 'object' && error !== null && api.isAPIError(error as Record<PropertyKey, unknown>);
}

/**
 * HTTP status of an API error. misskey-js drops the status; the retry fetch
 * wrapper re-attaches it as `httpStatus` on the error body (see `withRetry`).
 */
export function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { httpStatus?: unknown }).httpStatus;
  return typeof status === 'number' ? status : undefined;
}

export function describeError(error: unknown): string {
  if (isApiError(error)) {
    const status = getHttpStatus(error);
    const prefix = status === undefined ? 'API error' : `HTTP ${status}`;
    return `${prefix} ${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
