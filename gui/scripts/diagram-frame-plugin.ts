import path from 'node:path';
import { build, parseAst, type Plugin } from 'vite';

/** One self-contained classic script: opaque frames need neither module CORS nor a looser script policy. */
export function diagramFramePlugin(root: string): Plugin {
  const entry = path.join(root, 'src/diagram-frame.ts');
  const safety = path.join(root, 'src/lib/diagramSafety.ts');
  let command: 'serve' | 'build' = 'build';
  let compiled: Promise<string> | null = null;
  const bundle = () => compiled ??= (async () => {
    const result = await build({
      configFile: false, envDir: false, root, publicDir: false, logLevel: 'warn',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        write: false, minify: true, reportCompressedSize: false,
        lib: { entry, name: 'ContextSpaceDiagramFrame', formats: ['iife'], fileName: () => 'diagram-frame.js' },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    });
    const results = Array.isArray(result) ? result : [result];
    if (results.length !== 1 || !('output' in results[0])) throw new Error('Expected one diagram frame bundle.');
    const chunks = results[0].output;
    if (chunks.length !== 1 || chunks[0].type !== 'chunk' || chunks[0].imports.length || chunks[0].dynamicImports.some((name) => name !== chunks[0].fileName)) {
      throw new Error('Diagram frame must be a self-contained classic script.');
    }
    // Rolldown can retain a self-reference in dynamicImports metadata even after inlining.
    // Validate the emitted syntax too: a classic script must contain no live import expression.
    const hasImport = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.some(hasImport);
      const node = value as Record<string, unknown>;
      return node.type === 'ImportExpression' || node.type === 'ImportDeclaration' || Object.values(node).some(hasImport);
    };
    if (hasImport(parseAst(chunks[0].code))) throw new Error('Diagram frame contains an unbundled import.');
    return chunks[0].code;
  })();
  return {
    name: 'isolated-diagram-frame',
    configResolved(config) { command = config.command; },
    async buildStart() {
      if (command !== 'build') return;
      this.addWatchFile(entry);
      this.addWatchFile(safety);
      this.emitFile({ type: 'asset', fileName: 'diagram-frame.js', source: await bundle() });
    },
    async configureServer(server) {
      // Compile before listening, so the first diagram test does not pay a cold compiler startup.
      await bundle();
      server.watcher.on('change', (file) => {
        if (file === entry || file === safety) { compiled = null; server.ws.send({ type: 'full-reload' }); }
      });
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/diagram-frame.js') return next();
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
        try {
          const code = await bundle();
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.end(req.method === 'HEAD' ? undefined : code);
        } catch { res.statusCode = 500; res.end('Diagram renderer could not build.'); }
      });
    },
  };
}
