import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 1430,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4430,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 2, maxSize: 450_000 },
            { name: 'vue', test: /node_modules[\\/](?:@vue|vue)[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});
