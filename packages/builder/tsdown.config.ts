import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': './src/index.ts',
    'cpu-worker': './src/worker/cpu-worker.ts',
  },
  outDir: './dist',
  format: 'esm',
  clean: true,
  dts: true,
})
