/**
 * @lm/core — environment-independent logic for lm-misskeyutils.
 *
 * This package must not touch Node-only APIs, the environment, the console or
 * timers directly (REFACTORING_PLAN.md §3.2). Those come in through ports.
 */
export const CORE_PACKAGE_NAME = '@lm/core';
