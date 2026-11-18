import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { diagramFramePlugin } from './scripts/diagram-frame-plugin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function monacoSubpathPlugin(): Plugin {
  return {
    name: 'monaco-subpath-resolver',
    resolveId(source) {
      if (source.startsWith('monaco-editor/esm/vs/editor/editor.api')) {
        return path.resolve(__dirname, 'node_modules/monaco-editor/esm/vs/editor/editor.api.js');
      }
      if (source.includes('basic-languages/json/json.contribution')) {
        return path.resolve(__dirname, 'src/features/changes/adapters/json.contribution.ts');
      }
      const match = source.match(/^monaco-editor\/esm\/vs\/basic-languages\/([^/]+)\/\1\.contribution/);
      if (match) {
        const lang = match[1];
        return path.resolve(__dirname, `node_modules/monaco-editor/esm/vs/languages/definitions/${lang}/register.js`);
      }
      if (source.startsWith('monaco-editor/esm/vs/')) {
        return path.resolve(__dirname, 'node_modules', source);
      }
      return null;
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), monacoSubpathPlugin(), diagramFramePlugin(__dirname)],
  server: {
    proxy: {
      '/api/terminals': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/ws/terminal': { target: 'http://127.0.0.1:3000', changeOrigin: false, ws: true },
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../dist/gui',
    // The output folder is outside the project root, so Vite only empties it when told to.
    // Left alone, every build adds new hashed chunks beside the old ones, and `dist` ships in the npm package.
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('monaco-editor')) {
            return 'monaco';
          }
        },
      },
    },
  },
});
