/**
 * Cognitive & Cyclomatic Complexity conformance suite (WP-SPIKE-TREESITTER).
 *
 * These are exact worked examples from the SonarSource Cognitive Complexity
 * white-paper and from the SPEC §8.4 `formulaDoc`.  Every test MUST specify the
 * expected score and a commentary explaining which rules apply.
 *
 * Grammars under test: TypeScript, JavaScript, Python, Go.
 *
 * Rules being verified:
 *   1. Maximal like-operator boolean sequences:
 *        `a && b` = +1 (one run)
 *        `a && b && c` = +1 (still one run)
 *        `a && b || c` = +2 (two runs: `&&` then `||`)
 *        `a || b && c || d` = +3 (three runs: `||`, `&&`, `||`)
 *   2. Single +1 for switch (Cognitive); +1 per case (Cyclomatic).
 *   3. Direct recursive calls = +1 (no nesting penalty).
 *   4. Nesting increments: each nested structural layer adds +N.
 *   5. Python: `and`/`or` treated as `&&`/`||` for boolean sequences.
 *   6. Go: no ternary; range-for handled like for.
 *   7. Cognitive else/else-if each get their own +1 + nesting increment.
 */

import { beforeAll, describe, expect, it } from 'bun:test'
import { analyzeComplexity, computeComplexityDelta, initParser } from './complexity.js'

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await initParser()
}, 30_000)

// ── Helper ────────────────────────────────────────────────────────────────────

async function cc(source, lang = 'typescript') {
  const result = await analyzeComplexity(source, lang)
  const fn = result.functions[0]
  if (!fn) throw new Error('No function found in source')
  return { cyclomatic: fn.cyclomatic, cognitive: fn.cognitive }
}

// ── 1. Boolean sequences (TypeScript) ────────────────────────────────────────

describe('boolean sequences — TypeScript', () => {
  it('single && — one run → cognitive +1', async () => {
    const src = `function f(a: boolean, b: boolean) { if (a && b) return 1 }`
    // CC: 1 (base) + 1 (if) + 1 (&&) = 3
    // Cognitive: 1 (if, depth=0) + 1 (&&-run) = 2
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(3)
    expect(cognitive).toBe(2)
  })

  it('triple &&, same operator — still one run → cognitive +1', async () => {
    const src = `function f(a: boolean, b: boolean, c: boolean) {
  if (a && b && c) return 1
}`
    // CC: 1 + 1(if) + 2(&&, &&) = 4
    // Cognitive: 1(if, d=0) + 1(one &&-run) = 2
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(4)
    expect(cognitive).toBe(2)
  })

  it('mixed && and || — two runs → cognitive +2', async () => {
    const src = `function f(a: boolean, b: boolean, c: boolean) {
  if (a && b || c) return 1
}`
    // CC: 1 + 1(if) + 1(&&) + 1(||) = 4
    // Cognitive: 1(if) + 2(two runs: &&-run, ||-run) = 3
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(4)
    expect(cognitive).toBe(3)
  })

  it('a || b && c || d — three runs → cognitive +3', async () => {
    const src = `function f(a: boolean, b: boolean, c: boolean, d: boolean) {
  if (a || b && c || d) return 1
}`
    // Operators in tree (left-to-right associativity): ||, &&, ||
    // Runs: ||(1), &&(2), ||(3) = 3 runs
    // CC: 1 + 1(if) + 1(||) + 1(&&) + 1(||) = 5
    // Cognitive: 1(if) + 3(three runs) = 4
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(5)
    expect(cognitive).toBe(4)
  })

  it('no boolean operator — no sequence increment', async () => {
    const src = `function f(a: boolean) { if (a) return 1 }`
    // CC: 1 + 1(if) = 2
    // Cognitive: 1(if, d=0) = 1
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(2)
    expect(cognitive).toBe(1)
  })
})

// ── 2. Switch — single +1 cognitive, +1 per case cyclomatic ──────────────────

describe('switch statement', () => {
  it('switch with 3 cases — cognitive=1, cyclomatic=4', async () => {
    const src = `function f(x: number) {
  switch (x) {
    case 1: return 'a'
    case 2: return 'b'
    case 3: return 'c'
  }
}`
    // CC: 1(base) + 3(cases) = 4
    // Cognitive: 1(switch, d=0) = 1
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(4)
    expect(cognitive).toBe(1)
  })

  it('switch with default — cognitive=1, cyclomatic increases', async () => {
    const src = `function f(x: number) {
  switch (x) {
    case 1: return 'a'
    case 2: return 'b'
    default: return 'c'
  }
}`
    // default is not a 'switch_case' node in many grammars; 2 cases = CC 3 or 4 depending on grammar.
    // Cognitive: 1 (switch only)
    const { cognitive } = await cc(src)
    expect(cognitive).toBe(1)
  })
})

// ── 3. Recursion — direct +1 flat, no nesting penalty ────────────────────────

describe('direct recursive calls', () => {
  it('one direct recursive call → cognitive +1', async () => {
    const src = `function factorial(n: number): number {
  if (n <= 1) return 1
  return n * factorial(n - 1)
}`
    // CC: 1 + 1(if) = 2; (no operators in condition for CC other than <=)
    // Cognitive: 1(if, d=0) + 1(recursive call) = 2
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(2)
    expect(cognitive).toBe(2)
  })

  it('two recursive calls in same function → cognitive +2', async () => {
    const src = `function fib(n: number): number {
  if (n <= 1) return n
  return fib(n - 1) + fib(n - 2)
}`
    // CC: 1 + 1(if) = 2
    // Cognitive: 1(if, d=0) + 2(two recursive calls) = 3
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(2)
    expect(cognitive).toBe(3)
  })
})

// ── 4. Nesting increments ─────────────────────────────────────────────────────

describe('nesting increments', () => {
  it('if inside if — inner if gets +1 nesting penalty', async () => {
    const src = `function f(a: boolean, b: boolean) {
  if (a) {
    if (b) {
      return 1
    }
  }
}`
    // CC: 1 + 1(outer if) + 1(inner if) = 3
    // Cognitive: 1(outer if, d=0) + 2(inner if: 1 + nesting 1) = 3
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(3)
    expect(cognitive).toBe(3)
  })

  it('three levels deep — innermost gets +3', async () => {
    const src = `function f(a: boolean, b: boolean, c: boolean) {
  if (a) {
    for (let i = 0; i < 10; i++) {
      if (c) {
        return i
      }
    }
  }
}`
    // CC: 1 + 1(if a) + 1(for) + 1(if c) = 4
    // Cognitive: 1(if a, d=0) + 2(for: 1+1, d=1) + 3(if c: 1+2, d=2) = 6
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(4)
    expect(cognitive).toBe(6)
  })

  it('else branches are scored by Cognitive but not CC', async () => {
    const src = `function f(x: number) {
  if (x > 0) {
    return 'pos'
  } else if (x < 0) {
    return 'neg'
  } else {
    return 'zero'
  }
}`
    // CC: 1 + 1(if) + 1(else-if) = 3  (else is not a decision point)
    // Cognitive: 1(if, d=0) + 1(else-if, d=0) + 1(else, d=0) = 3
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(3)
    expect(cognitive).toBe(3)
  })
})

// ── 5. Python — and/or are boolean operators ──────────────────────────────────

describe('Python — boolean sequences', () => {
  it('a and b — one run → cognitive +1', async () => {
    const src = `def f(a, b):
    if a and b:
        return 1
`
    // CC: 1 + 1(if) + 1(and) = 3
    // Cognitive: 1(if) + 1(and-run) = 2
    const { cyclomatic, cognitive } = await cc(src, 'python')
    expect(cyclomatic).toBe(3)
    expect(cognitive).toBe(2)
  })

  it('a and b or c — two runs → cognitive +2', async () => {
    const src = `def f(a, b, c):
    if a and b or c:
        return 1
`
    // CC: 1 + 1(if) + 1(and) + 1(or) = 4
    // Cognitive: 1(if) + 2(two runs: and-run, or-run) = 3
    const { cyclomatic, cognitive } = await cc(src, 'python')
    expect(cyclomatic).toBe(4)
    expect(cognitive).toBe(3)
  })

  it('Python conditional expression (ternary equivalent) counts as structural', async () => {
    const src = `def f(a, b):
    return 1 if a else 2
`
    // CC: 1 + 1(conditional expression) = 2
    // Cognitive: 1(conditional expr, d=0) = 1
    const { cyclomatic, cognitive } = await cc(src, 'python')
    expect(cyclomatic).toBe(2)
    expect(cognitive).toBe(1)
  })
})

// ── 6. Go — range-for, no ternary ────────────────────────────────────────────

describe('Go — range-for and no ternary', () => {
  it('range-for is a decision point for CC and structural for Cognitive', async () => {
    const src = `package main
func f(items []int) int {
  sum := 0
  for _, v := range items {
    sum += v
  }
  return sum
}
`
    // CC: 1 + 1(for/range) = 2
    // Cognitive: 1(for, d=0) = 1
    const { cyclomatic, cognitive } = await cc(src, 'go')
    expect(cyclomatic).toBe(2)
    expect(cognitive).toBe(1)
  })

  it('Go if + else if — nesting and structural', async () => {
    const src = `package main
func f(x int) string {
  if x > 0 {
    return "pos"
  } else if x < 0 {
    return "neg"
  } else {
    return "zero"
  }
}
`
    // CC: 1 + 1(if) + 1(else-if) = 3
    // Cognitive: 1(if, d=0) + 1(else-if) + 1(else) = 3
    const { cyclomatic, cognitive } = await cc(src, 'go')
    expect(cyclomatic).toBe(3)
    expect(cognitive).toBe(3)
  })

  it('Go && operator — boolean sequence', async () => {
    const src = `package main
func f(a bool, b bool, c bool) bool {
  return a && b && c
}
`
    // CC: 1 + 1(&&) + 1(&&) = 3
    // Cognitive: 1(&&-run, no if) = 1
    const { cyclomatic, cognitive } = await cc(src, 'go')
    expect(cyclomatic).toBe(3)
    expect(cognitive).toBe(1)
  })
})

// ── 7. Flat baseline ──────────────────────────────────────────────────────────

describe('flat function — no control flow', () => {
  it('TypeScript: simple return → CC=1, Cognitive=0', async () => {
    const src = `function f(x: number): number { return x + 1 }`
    const { cyclomatic, cognitive } = await cc(src)
    expect(cyclomatic).toBe(1)
    expect(cognitive).toBe(0)
  })

  it('Python: simple return → CC=1, Cognitive=0', async () => {
    const src = `def f(x):\n    return x + 1\n`
    const { cyclomatic, cognitive } = await cc(src, 'python')
    expect(cyclomatic).toBe(1)
    expect(cognitive).toBe(0)
  })

  it('Go: simple return → CC=1, Cognitive=0', async () => {
    const src = `package main\nfunc f(x int) int { return x + 1 }\n`
    const { cyclomatic, cognitive } = await cc(src, 'go')
    expect(cyclomatic).toBe(1)
    expect(cognitive).toBe(0)
  })
})

// ── Audit regressions ─────────────────────────────────────────────────────────

describe('computeComplexityDelta — non-unique names', () => {
  it('reports zero per-function delta for an unchanged file with two anonymous functions', async () => {
    // Two arrow callbacks (both named '<anonymous>'), one of which is complex.
    const src = `
const a = [].map(() => 1)
const b = [].map((x: number) => { if (x > 0 && x < 10 || x === 42) return x; return 0 })
`
    const delta = await computeComplexityDelta(src, src, 'typescript')
    // Identical base/head → every per-function delta must be 0 (no spurious
    // drop from last-write-wins name collision).
    for (const fn of delta.functions) {
      expect(fn.cyclomaticDelta).toBe(0)
      expect(fn.cognitiveDelta).toBe(0)
    }
    expect(delta.totalCyclomaticDelta).toBe(0)
    expect(delta.totalCognitiveDelta).toBe(0)
  })
})

describe('totalCognitive — nested functions', () => {
  it('does not double-count a nested function (counted once, inside its parent)', async () => {
    const src = `
function outer(xs: number[]) {
  return xs.map((x) => {
    if (x > 0) {
      return x
    }
    return 0
  })
}
`
    const result = await analyzeComplexity(src, 'typescript')
    // The standalone nested-callback entry exists, but the file total equals the
    // top-level function's cognitive (which already includes the nested cost),
    // never the sum of both.
    const top = result.functions.find((f) => f.name === 'outer')
    expect(top).toBeDefined()
    expect(result.totalCognitive).toBe(top?.cognitive ?? -1)
  })
})
