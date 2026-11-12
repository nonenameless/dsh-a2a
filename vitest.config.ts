import { defineConfig } from 'vitest/config'

/**
 * The Host logic is plain Node code, so the default node environment is enough.
 * Client component tests opt into jsdom with a per-file `@vitest-environment`
 * pragma, mirroring the DSH client suite convention.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
