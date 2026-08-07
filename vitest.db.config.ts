import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    // The fixture seeds and deletes rows in one shared table under one sentinel repo_source;
    // parallel files would race each other's teardown.
    fileParallelism: false,
  },
});
