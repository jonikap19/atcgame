import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: the whole game ships as one HTML file, which makes it
// trivial to host anywhere (or publish as a Claude artifact).
export default defineConfig({
  plugins: [viteSingleFile()],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
