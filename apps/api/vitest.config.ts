import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclude type-only interfaces and the NestJS composition root. The module
      // wiring is exercised by AppModule runtime tests, while business logic and
      // provider implementations remain subject to coverage thresholds.
      exclude: ['src/firestore-port.ts', 'src/app.module.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
