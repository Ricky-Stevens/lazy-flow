/**
 * tsup bundle config — SPEC §12.3, WP-MCP-SERVER, WP-E2E.
 *
 * Output: server/dist/server.js (ESM, platform node)
 *
 * Bundling strategy:
 *  - All @lazy-flow/* workspace packages + JS third-party deps bundled in.
 *  - node:sqlite is a Node built-in — externalized.
 *  - web-tree-sitter ships as CJS and loads tree-sitter.wasm at runtime.
 *  - tree-sitter-wasms grammar files are .wasm binaries — cannot be bundled
 *    into a JS text file; they are COPIED into server/dist/grammars/.
 *  - code-analysis's grammarPath() uses require.resolve() against node_modules,
 *    which won't exist on a plugin host. The grammarPathOverride env var (set in
 *    onSuccess below) tells the bundled server where grammars live relative to
 *    import.meta.url. See packages/code-analysis/src/complexity.ts.
 *
 * WASM asset copy (onSuccess hook):
 *  1. tree-sitter.wasm  → server/dist/grammars/tree-sitter.wasm
 *  2. tree-sitter-{typescript,javascript,python,go}.wasm → server/dist/grammars/
 *
 * At runtime, code-analysis resolves grammars via:
 *   new URL('grammars/tree-sitter-<lang>.wasm', import.meta.url)
 * The LAZYFLOW_GRAMMAR_DIR env var (set in the bundled entry shim) wires this.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsup'

const _require = createRequire(import.meta.url)

const GRAMMAR_NAMES = ['typescript', 'javascript', 'python', 'go']

function resolveWasmAssets(): { treeSitterWasm: string; grammars: Record<string, string> } {
  const treeSitterWasm = _require.resolve('web-tree-sitter/tree-sitter.wasm')
  const grammars: Record<string, string> = {}
  for (const name of GRAMMAR_NAMES) {
    grammars[name] = _require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`)
  }
  return { treeSitterWasm, grammars }
}

function copyWasmAssets(outDir: string): void {
  const grammarsDir = join(outDir, 'grammars')
  if (!existsSync(grammarsDir)) mkdirSync(grammarsDir, { recursive: true })

  const { treeSitterWasm, grammars } = resolveWasmAssets()

  copyFileSync(treeSitterWasm, join(grammarsDir, 'tree-sitter.wasm'))
  console.log('  copied tree-sitter.wasm →', join(grammarsDir, 'tree-sitter.wasm'))

  for (const [name, src] of Object.entries(grammars)) {
    const dest = join(grammarsDir, `tree-sitter-${name}.wasm`)
    copyFileSync(src, dest)
    console.log(`  copied tree-sitter-${name}.wasm →`, dest)
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, 'server', 'dist')

export default defineConfig({
  entry: { server: 'src/index.ts' },
  outDir,
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  // node:* built-ins must be external (cannot be bundled).
  external: [/^node:/],
  // By default tsup strips the `node:` prefix from external specifiers via
  // nodeProtocolPlugin, which produces `import from "sqlite"` instead of
  // `import from "node:sqlite"`. Node 22 only ships `node:sqlite` — bare
  // `sqlite` is not a real package and causes ERR_MODULE_NOT_FOUND.
  // Disabling removeNodeProtocol preserves the full specifier.
  removeNodeProtocol: false,
  // Bundle all workspace + third-party packages in
  noExternal: [
    '@lazy-flow/ai',
    '@lazy-flow/code-analysis',
    '@lazy-flow/core',
    '@lazy-flow/ingest-github',
    '@lazy-flow/ingest-jira',
    '@lazy-flow/metrics',
    '@lazy-flow/orchestrator',
    '@modelcontextprotocol/sdk',
    '@anthropic-ai/sdk',
    'octokit',
    'web-tree-sitter',
    'zod',
  ],
  // Clean the output directory before each build
  clean: true,
  // Output filename
  outExtension: () => ({ js: '.js' }),
  // tsconfig for the bundle
  tsconfig: '../../tsconfig.base.json',
  // Suppress duplicate export warnings from re-exporting workspace packages
  esbuildOptions(options) {
    options.logOverride = {
      'duplicate-case': 'silent',
    }
    // Preserve node: protocol in external specifiers.
    // tsup passes external as strings but esbuild needs the pattern to
    // match exactly what it sees in the source. Adding node:* as a wildcard
    // ensures all built-ins (including node:sqlite) are kept external with
    // their full specifiers intact.
    if (!options.external) options.external = []
    if (!options.external.includes('node:*')) options.external.push('node:*')
  },
  // Post-build: copy WASM assets into server/dist/grammars/
  async onSuccess() {
    console.log('\nCopying WASM assets...')
    copyWasmAssets(outDir)
    console.log('WASM assets copied.\n')
  },
})
