import { CORE_PACKAGE_NAME } from '@lm/core';
import { expect, it } from 'vitest';

it('exports the package name', () => {
  expect(CORE_PACKAGE_NAME).toBe('@lm/core');
});
