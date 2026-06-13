/**
 * Cyclomatic and Cognitive Complexity via web-tree-sitter (SPEC §8.4, §8.6).
 *
 * ## Cyclomatic Complexity (per McCabe / SonarSource)
 *   CC = 1 + (number of decision points)
 *   Decision points: if / else-if / for / while / do-while / catch /
 *                    case (in switch) / conditional-expression (?:) /
 *                    logical binary operators in boolean expressions
 *
 * ## Cognitive Complexity (SonarSource white-paper, restated in SPEC §8.4)
 * Three fundamental rules:
 *
 *   A. **Structural increments** (+1 each, plus nesting increment):
 *      if / else-if / else / for / while / do / catch / switch /
 *      conditional expression (?:) / each else-if clause counts separately
 *
 *   B. **Flat increments** (+1, no nesting):
 *      - Each "maximal like-operator boolean sequence": a run of consecutive
 *        identical boolean operators (`&&` or `||`) in an expression counts
 *        as ONE increment, regardless of chain length.
 *        e.g. `a && b` = +1, `a && b && c` = +1, `a && b || c` = +2
 *        (two maximal runs: `a && b` and `|| c`)
 *      - Each recursive call (direct: call site whose callee name matches the
 *        enclosing function name).
 *      - `switch` itself gets a single +1 (not per-case).
 *
 *   C. **Nesting increments**: each structural element (A above) gets +N where
 *      N = current nesting depth.  Nesting is incremented by:
 *      if / else if / else / for / while / do / catch / switch /
 *      nested function / lambda / conditional expression
 *
 * ## Supported languages
 *  - TypeScript / JSX — full support
 *  - JavaScript / JSX — full support
 *  - Python           — full support (and/or as boolean sequences, conditional expression)
 *  - Go               — full support (range-for handled; no ternary in Go)
 *
 * ## WASM asset resolution (bundle-safe)
 *  Uses createRequire(import.meta.url) + require.resolve() so the module
 *  resolver finds grammar files in hoisted npm workspace node_modules — never
 *  cwd-relative.  Grammar files are read via Bun.file().arrayBuffer() so
 *  Language.load() receives a Uint8Array (supported by web-tree-sitter@0.20.x).
 *
 * ## Version pinning
 *  Uses web-tree-sitter@0.20.8 paired with tree-sitter-wasms@0.1.13.
 *  The 0.1.x grammars were compiled with tree-sitter-cli@0.20.x which targets
 *  the ABI accepted by web-tree-sitter@0.20.x.  Newer 0.26.x grammars would
 *  require a different grammar WASM source — tracked as a future upgrade.
 */

import { createRequire } from 'node:module'

// web-tree-sitter@0.20.x ships as CJS; import via createRequire.
// The TS types declare `Parser` as a class with a static `Language` nested class.
const _require = createRequire(import.meta.url)
const Parser = _require('web-tree-sitter')

// ── WASM paths (bundle-safe) ─────────────────────────────────────────────────

/**
 * Optional grammar directory override — used by the bundled MCP server to
 * redirect grammar resolution to dist/grammars/ (next to server.js)
 * via import.meta.url, rather than require.resolve() against node_modules
 * (which won't exist on a plugin host after bundling — SPEC §12.3, WP-E2E).
 *
 * Call setGrammarDir(new URL('./grammars/', import.meta.url).pathname)
 * early in the bundled server entry, before any analyzeComplexity() call.
 */
let grammarDirOverride = null

/**
 * Override the directory from which grammar .wasm files are loaded.
 * Must be called before the first analyzeComplexity() / getLanguage() call.
 * No-op if called after languages are cached.
 */
export function setGrammarDir(dir) {
  grammarDirOverride = dir
}

function grammarPath(name) {
  if (grammarDirOverride !== null) {
    // Bundle path: grammars sit next to the server.js in dist/grammars/
    return `${grammarDirOverride}/tree-sitter-${name}.wasm`
  }
  return _require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`)
}

// ── Language type & supported set ────────────────────────────────────────────

const GRAMMAR_NAMES = {
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  go: 'go',
}

// ── Parser singleton ─────────────────────────────────────────────────────────

let parserReady = false
let parserInstance = null
const languageCache = new Map()

/**
 * Initialise the WASM parser (idempotent; safe to call multiple times).
 * Must be awaited before any parse operations.
 */
export async function initParser() {
  if (parserReady) return
  await Parser.init()
  parserReady = true
}

async function getLanguage(lang) {
  const cached = languageCache.get(lang)
  if (cached) return cached
  const wasm = new Uint8Array(await Bun.file(grammarPath(GRAMMAR_NAMES[lang])).arrayBuffer())
  const language = await Parser.Language.load(wasm)
  languageCache.set(lang, language)
  return language
}

async function getParser(lang) {
  await initParser()
  if (!parserInstance) parserInstance = new Parser()
  const language = await getLanguage(lang)
  parserInstance.setLanguage(language)
  return parserInstance
}

// ── Node type alias (web-tree-sitter@0.20.x SyntaxNode shape) ────────────────

// ── Node-type sets ────────────────────────────────────────────────────────────

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function',
  'generator_function_declaration',
  'function_definition', // Python
  'method_declaration', // Go
  'func_literal', // Go
])

/**
 * Cognitive structural increment types (A-type: +1 + nesting).
 * Note: switch_statement gets ONE +1 total (not per-case).
 * Note: else_clause / elif_clause / catch_clause / except_clause are structural
 *       but do NOT further increment nesting for their siblings.
 */
const COGNITIVE_STRUCTURAL_TYPES = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'catch_clause',
  'except_clause',
  'ternary_expression',
  'conditional_expression',
])

/**
 * CC decision-point types.
 * switch_statement itself does NOT count (only its cases do).
 * else_clause does NOT count (not a branching decision point).
 */
const CC_DECISION_TYPES = new Set([
  'if_statement',
  'elif_clause',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'catch_clause',
  'except_clause',
  'ternary_expression',
  'conditional_expression',
])

/** CC adds +1 per case label. */
const CASE_LABEL_TYPES = new Set(['switch_case', 'case_clause', 'when_clause'])

/** Node types that bump the nesting counter for Cognitive. */
const NESTING_TYPES = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'catch_clause',
  'except_clause',
  'ternary_expression',
  'conditional_expression',
  // Nested functions
  'function_expression',
  'arrow_function',
  'generator_function',
  'generator_function_declaration',
  'function_definition',
  'func_literal',
  // Python comprehensions
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
])

/** Boolean operator tokens (as node .type strings in tree-sitter grammars). */
const BOOL_OPS = new Set(['&&', '||', 'and', 'or'])

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBoolChainNode(node) {
  // binary_expression: JS/TS/Go
  // boolean_operator: Python (and/or expressions use this node type)
  return (
    node.type === 'binary_expression' ||
    node.type === 'boolean_operation' ||
    node.type === 'boolean_operator'
  )
}

function getFunctionBody(funcNode) {
  const body = funcNode.childForFieldName('body')
  if (body) return body
  for (const child of funcNode.namedChildren) {
    if (child.type === 'block' || child.type === 'statement_block') return child
  }
  return null
}

function getFunctionName(node) {
  const nameField = node.childForFieldName('name')
  if (nameField) return nameField.text
  if (node.type === 'method_definition' && node.firstNamedChild) {
    return node.firstNamedChild.text
  }
  return '<anonymous>'
}

function isRecursiveCall(callNode, funcName) {
  if (!funcName || funcName === '<anonymous>') return false
  const callee =
    callNode.childForFieldName('function') ??
    callNode.childForFieldName('name') ??
    callNode.firstNamedChild
  if (!callee) return false
  return callee.text.trim() === funcName
}

// ── Boolean sequence counting ─────────────────────────────────────────────────

/**
 * Count maximal like-operator boolean sequences starting from `root`.
 * Only processes the chain rooted here (caller must ensure this is the root).
 * Returns number of distinct runs (e.g. `a && b || c` → 2).
 */
function countChainRuns(chainRoot) {
  const ops = []

  function collect(node) {
    for (const child of node.children) {
      if (BOOL_OPS.has(child.type)) {
        ops.push(child.type)
      } else if (isBoolChainNode(child)) {
        collect(child)
      }
    }
  }

  collect(chainRoot)
  if (ops.length === 0) return 0

  let runs = 1
  let prev = ops[0]
  for (let i = 1; i < ops.length; i++) {
    const op = ops[i]
    if (op !== prev) {
      runs++
      prev = op
    }
  }
  return runs
}

// ── Cyclomatic Complexity ─────────────────────────────────────────────────────

function computeCyclomatic(funcNode) {
  let score = 1

  function walk(node) {
    const t = node.type

    if (CC_DECISION_TYPES.has(t)) {
      score++
    }
    if (CASE_LABEL_TYPES.has(t)) {
      score++
    }

    // Count each boolean operator in binary/boolean/boolean_operator chains
    if (isBoolChainNode(node)) {
      for (const child of node.children) {
        if (BOOL_OPS.has(child.type)) score++
      }
    }

    for (const child of node.namedChildren) {
      if (!FUNCTION_NODE_TYPES.has(child.type)) {
        walk(child)
      }
    }
  }

  const body = getFunctionBody(funcNode)
  if (body) walk(body)
  return score
}

// ── Cognitive Complexity ──────────────────────────────────────────────────────

/**
 * else_clause / elif_clause / catch_clause / except_clause are "flat siblings":
 * they add a cognitive increment but do NOT increase nesting depth.
 */
const FLAT_SIBLINGS = new Set(['else_clause', 'elif_clause', 'catch_clause', 'except_clause'])

function computeCognitive(funcNode, funcName) {
  let score = 0

  /**
   * @param node - current node
   * @param depth - current nesting depth
   * @param insideElseClause - true when this node is the direct if_statement
   *   inside an else_clause ("else if" pattern); in that case the if_statement
   *   itself should NOT get a structural increment (the parent else_clause
   *   already counted for it) but we DO still walk its children.
   */
  function walk(node, depth, insideElseClause = false) {
    const t = node.type

    // A. Structural increments (+ nesting penalty)
    if (COGNITIVE_STRUCTURAL_TYPES.has(t)) {
      const isFlatSibling = FLAT_SIBLINGS.has(t)

      if (!insideElseClause) {
        // Normal structural increment
        score += 1 + depth
      }
      // If insideElseClause=true: this is the "else if" if_statement.
      // The else_clause already counted +1+depth for us; don't count again.

      const childDepth = isFlatSibling
        ? depth // else_clause does not bump nesting
        : depth + 1 // other structural nodes bump nesting

      for (const child of node.namedChildren) {
        if (FUNCTION_NODE_TYPES.has(child.type)) {
          walk(child, childDepth + 1)
        } else if (FLAT_SIBLINGS.has(child.type)) {
          // else_clause / elif_clause walk at the original depth (same as the if)
          walk(child, depth)
        } else if (isFlatSibling && child.type === 'if_statement') {
          // The if_statement directly inside an else_clause is the "else if" body.
          // It should NOT get its own structural increment.
          walk(child, childDepth, true)
        } else {
          walk(child, childDepth)
        }
      }
      return
    }

    // B-flat: boolean sequences (only at chain root, no depth penalty)
    if (isBoolChainNode(node)) {
      const parent = node.parent
      const isRoot = !parent || !isBoolChainNode(parent)
      if (isRoot) {
        const runs = countChainRuns(node)
        if (runs > 0) score += runs
        // Descend only into non-chain children for further structural scoring
        for (const child of node.namedChildren) {
          if (!isBoolChainNode(child)) {
            walk(child, depth)
          }
        }
        return
      }
    }

    // B-flat: recursive calls (+1, no depth penalty)
    if (t === 'call_expression' || t === 'call') {
      if (isRecursiveCall(node, funcName)) score++
    }

    // Default descent
    const childDepth = NESTING_TYPES.has(t) ? depth + 1 : depth
    for (const child of node.namedChildren) {
      if (FUNCTION_NODE_TYPES.has(child.type)) {
        walk(child, childDepth + 1)
      } else if (FLAT_SIBLINGS.has(child.type)) {
        walk(child, depth)
      } else {
        walk(child, childDepth)
      }
    }
  }

  const body = getFunctionBody(funcNode)
  if (body) walk(body, 0)
  return score
}

// ── Function extraction ───────────────────────────────────────────────────────

function extractFunctions(root) {
  const results = []

  function walk(node, insideFunction) {
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      results.push({ node, name: getFunctionName(node), topLevel: !insideFunction })
      for (const child of node.namedChildren) {
        walk(child, true)
      }
      return
    }
    for (const child of node.namedChildren) {
      walk(child, insideFunction)
    }
  }

  walk(root, false)
  return results
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute per-function Cyclomatic and Cognitive complexity for source code.
 *
 * @param source - The source code text.
 * @param language - Language to parse as.
 * @returns {@link FileComplexity} with per-function metrics and totals.
 */
export async function analyzeComplexity(source, language) {
  const parser = await getParser(language)
  const tree = parser.parse(source)
  if (!tree) throw new Error(`Failed to parse source as ${language}`)

  const allFunctions = extractFunctions(tree.rootNode)
  const functions = allFunctions.map(({ node, name }) => ({
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    cyclomatic: computeCyclomatic(node),
    cognitive: computeCognitive(node, name),
  }))

  // totalCyclomatic: computeCyclomatic does NOT descend into nested functions,
  // so summing every function's own score counts each exactly once.
  // totalCognitive: computeCognitive DOES descend into nested functions (with a
  // nesting penalty, per SonarSource), so a nested function's score is already
  // inside its parent's. Summing only top-level functions avoids double-counting
  // (the nested functions still appear individually in `functions` for deltas).
  let totalCognitive = 0
  for (let i = 0; i < functions.length; i++) {
    if (allFunctions[i]?.topLevel) {
      totalCognitive += functions[i]?.cognitive ?? 0
    }
  }

  return {
    language,
    functions,
    totalCyclomatic: functions.reduce((s, f) => s + f.cyclomatic, 0),
    totalCognitive,
  }
}

/**
 * Compute the complexity delta between base and head versions of a file.
 *
 * @param baseSource - Source text at base SHA.
 * @param headSource - Source text at head SHA.
 * @param language - Language to parse as.
 * @returns {@link FileDelta} with per-function and total deltas.
 */
export async function computeComplexityDelta(baseSource, headSource, language) {
  const [base, head] = await Promise.all([
    analyzeComplexity(baseSource, language),
    analyzeComplexity(headSource, language),
  ])

  // Match by name, but names are frequently non-unique — every anonymous
  // function is '<anonymous>', and two methods can share a name across classes.
  // A plain Map<name, fn> let the last same-named base function overwrite the
  // others, so every head function with that name was diffed against one
  // arbitrary base entry (spurious deltas on unchanged files). Instead, group
  // base functions by name in source order and consume them positionally: the
  // i-th head occurrence of name N matches the i-th base occurrence of N.
  const baseByName = new Map()
  for (const f of base.functions) {
    const arr = baseByName.get(f.name)
    if (arr) arr.push(f)
    else baseByName.set(f.name, [f])
  }
  const consumed = new Map()

  const deltas = head.functions.map((hf) => {
    const candidates = baseByName.get(hf.name)
    let bf
    if (candidates) {
      const idx = consumed.get(hf.name) ?? 0
      bf = candidates[idx]
      consumed.set(hf.name, idx + 1)
    }
    return {
      name: hf.name,
      startLine: hf.startLine,
      baseCyclomatic: bf?.cyclomatic ?? null,
      headCyclomatic: hf.cyclomatic,
      baseCognitive: bf?.cognitive ?? null,
      headCognitive: hf.cognitive,
      cyclomaticDelta: hf.cyclomatic - (bf?.cyclomatic ?? 0),
      cognitiveDelta: hf.cognitive - (bf?.cognitive ?? 0),
    }
  })

  return {
    totalCyclomaticDelta: head.totalCyclomatic - base.totalCyclomatic,
    totalCognitiveDelta: head.totalCognitive - base.totalCognitive,
    functions: deltas,
  }
}
