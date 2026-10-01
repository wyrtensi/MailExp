import { defineConfig } from 'vitest/config';

// The PGlite tests (*.pglite.test.js) build the real schema from every migration in their
// beforeAll, and a few tests read the whole source tree; with every test file running in parallel on
// a busy machine that takes longer than vitest's defaults (10 s for a hook, 5 s for a test). The
// limits only bound how long a slow step may take: no assertion changes.
export default defineConfig({
  test: {
    hookTimeout: 60000,
    testTimeout: 30000,
  },
});
