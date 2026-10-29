import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'backend/tests/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false
  }
})
