/**
 * AI-authorship detection — tool-agnostic, trailer-independent.
 *
 * Co-authored-by trailers are opt-in and frequently disabled, so they are a poor
 * primary signal. This scores each commit / PR for AI-assistance likelihood from
 * signals that survive trailer-stripping and span every assistant (Claude, Codex,
 * Gemini, Copilot, Cursor, …):
 *
 *   - em_dash      — the message/title/body contains an em dash (—). LLMs emit
 *                    these constantly; humans rarely type them. Validated on real
 *                    data: present in ~69% of known-AI commits vs ~11% of others.
 *   - ai_marker    — an explicit "Generated with …", "Claude Code", or an AI
 *                    co-author trailer is still present (a floor, not relied upon).
 *   - ai_bot_author— the change was authored by a known AI agent/bot account.
 *
 * Each fired signal contributes a weight; the score is their noisy-OR (0..1). We
 * store BOTH the score AND which signals fired (signals_json) so downstream KPIs
 * choose their own threshold/policy (strict: marker/bot only; loose: include
 * em_dash). The probabilistic LLM classifier (ai_verdicts) is a separate, deeper
 * layer that consumes these as features.
 *
 * Nothing here is hardcoded to one vendor — the bot list and weights are options.
 */

/** Known AI agent / assistant bot logins (overridable via options.aiBotLogins). */
import { safeJsonParse } from '../json.js'

export const DEFAULT_AI_BOT_LOGINS = [
  'copilot',
  'github-copilot[bot]',
  'copilot-swe-agent[bot]',
  'codex',
  'chatgpt-codex-connector[bot]',
  'devin-ai-integration[bot]',
  'sweep-ai[bot]',
  'cursoragent',
  'claude[bot]',
  'gemini-code-assist[bot]',
]

/** Explicit AI authorship markers (vendor-spanning). Case-insensitive. */
const AI_MARKER_RE =
  /generated with (?:claude|chatgpt|gpt|copilot|gemini|cursor)|claude code|🤖 generated|co-authored-by:[^\n]*(?:claude|copilot|anthropic|openai|cursor|gemini|codex)/i

/**
 * Signal weights, combined via noisy-OR. STRONG signals (≥0.5) flag a change on
 * their own; WEAK ones only push past the 0.5 "assisted" line in combination.
 * Calibrated against real data where ~all reviewed PRs were AI-authored: the
 * markdown-template structure (## Summary / ## Test plan + checklists) and
 * substantive explanatory prose are the dominant tells the em-dash signal missed.
 * These are STYLE patterns, not literal strings — they generalise across tools
 * and companies (nothing is hardcoded to one repo's content).
 */
const DEFAULT_WEIGHTS = {
  ai_bot_author: 1.0, // authored by a known AI agent (Copilot/Codex/…)
  ai_marker: 0.85, // explicit "Generated with …" / AI co-author trailer
  md_header: 0.6, // markdown section headers (## Summary / ## Test plan)
  task_checklist: 0.5, // - [ ] / - [x] task lists (AI "Test plan" sections)
  em_dash: 0.5, // — : LLMs emit these, humans rarely type them
  smart_punct: 0.4, // ' ' " " … curly punctuation / ellipsis
  prose_body: 0.4, // long, multi-line, structured explanatory body
  bullets: 0.3, // ≥2 markdown bullet points
  bold: 0.25, // **bold** markdown
  conventional_commit: 0.2, // type(scope): subject
}

const EM_DASH = '—'
const SMART_PUNCT_RE = /[‘’“”…]/
const MD_HEADER_RE = /(?:^|\n)#{1,6}\s/
const CHECKLIST_RE = /(?:^|\n)\s*[-*]\s\[[ xX]\]/
const BULLET_RE = /(?:^|\n)\s*[-*]\s+\S/g
const BOLD_RE = /\*\*[^*\n]+\*\*/
const CONVENTIONAL_RE = /^[a-z]+(?:\([a-z0-9_.\-/]+\))?!?:\s/

/**
 * Score authored text for AI-assistance likelihood. Pure + deterministic.
 * `opts.firstLine` (commit subject / PR title) is used for the conventional-commit
 * tell. `opts.isAutomationBot` short-circuits to a non-AI 'automation_bot' verdict
 * (e.g. dependabot — templated, not human-AI; excluded from AI-adoption rates).
 * Returns { score: 0..1, signals: string[] }.
 */
export function scoreAiText(text, opts = {}) {
  if (opts.isAutomationBot) return { score: 0, signals: ['automation_bot'] }
  const weights = opts.weights ?? DEFAULT_WEIGHTS
  const t = typeof text === 'string' ? text : ''
  const firstLine = (opts.firstLine ?? t.split('\n', 1)[0] ?? '').trim()
  const signals = []
  if (opts.isAiBotAuthor) signals.push('ai_bot_author')
  if (AI_MARKER_RE.test(t)) signals.push('ai_marker')
  if (MD_HEADER_RE.test(t)) signals.push('md_header')
  if (CHECKLIST_RE.test(t)) signals.push('task_checklist')
  if (t.includes(EM_DASH)) signals.push('em_dash')
  if (SMART_PUNCT_RE.test(t)) signals.push('smart_punct')
  if (t.length > 280 && t.includes('\n')) signals.push('prose_body')
  if ((t.match(BULLET_RE) ?? []).length >= 2) signals.push('bullets')
  if (BOLD_RE.test(t)) signals.push('bold')
  if (CONVENTIONAL_RE.test(firstLine)) signals.push('conventional_commit')
  // Noisy-OR: independent signals combine so multiple weak tells reinforce.
  const score = 1 - signals.reduce((p, s) => p * (1 - (weights[s] ?? 0)), 1)
  return { score, signals }
}

function parse(raw) {
  return safeJsonParse(raw, {})
}

function commitMessage(raw) {
  const p = parse(raw)
  return p.commit?.message ?? p.message ?? ''
}

function prText(raw) {
  const p = parse(raw)
  return `${p.title ?? ''}\n${p.body ?? ''}`
}

/**
 * Score every commit and PR for AI-authorship and persist to `ai_authorship`.
 * INCREMENTAL: entities already scored are skipped, so iterative syncs only
 * score new changes. Tool-agnostic + configurable (options.aiBotLogins/weights).
 */
export async function detectAiAuthorship(store, options = {}) {
  const now = options.now ?? new Date().toISOString()
  const aiBotLogins = new Set(
    (options.aiBotLogins ?? DEFAULT_AI_BOT_LOGINS).map((s) => s.toLowerCase()),
  )
  const weights = options.weights

  // Classify each author identity: AI agent (Copilot/Codex → definitive AI),
  // automation bot (dependabot/renovate → templated, NOT human-AI), or human
  // (apply stylometry). isBot comes from the identity layer's bot detection.
  const loginOf = new Map()
  const isBotOf = new Map()
  for (const i of await store.listAllIdentities()) {
    if (i.kind === 'github_login') {
      loginOf.set(i.id, i.externalId.toLowerCase())
      isBotOf.set(i.id, i.isBot === true)
    }
  }
  const isAiBotAuthor = (identityId) => {
    const login = identityId ? loginOf.get(identityId) : null
    return login ? aiBotLogins.has(login) : false
  }
  // An automation bot is a bot account that is NOT a known AI coding agent.
  const isAutomationBot = (identityId) =>
    (isBotOf.get(identityId) ?? false) && !isAiBotAuthor(identityId)

  const already = new Set(
    (await store.getAiAuthorshipKeys()).map((k) => `${k.entityType}:${k.entityId}`),
  )

  const rows = []
  for (const c of await store.getAllCommits()) {
    if (!c.sha) continue
    const entityId = `${c.repoId}:${c.sha}`
    if (already.has(`commit:${entityId}`)) continue
    const { score, signals } = scoreAiText(commitMessage(c.raw), {
      isAiBotAuthor: isAiBotAuthor(c.authorIdentityId),
      isAutomationBot: isAutomationBot(c.authorIdentityId),
      weights,
    })
    rows.push({
      entityType: 'commit',
      entityId,
      repoId: c.repoId,
      authorIdentityId: c.authorIdentityId ?? null,
      authoredAt: c.authoredAt ?? null,
      aiScore: score,
      signalsJson: JSON.stringify(signals),
      computedAt: now,
    })
  }
  for (const pr of await store.getAllPullRequests()) {
    if (already.has(`pull_request:${pr.id}`)) continue
    const { score, signals } = scoreAiText(prText(pr.raw), {
      isAiBotAuthor: isAiBotAuthor(pr.authorIdentityId),
      isAutomationBot: isAutomationBot(pr.authorIdentityId),
      weights,
    })
    rows.push({
      entityType: 'pull_request',
      entityId: pr.id,
      repoId: pr.repoId,
      authorIdentityId: pr.authorIdentityId ?? null,
      authoredAt: pr.createdAt ?? null,
      aiScore: score,
      signalsJson: JSON.stringify(signals),
      computedAt: now,
    })
  }

  let scored = 0
  if (rows.length > 0) {
    await store.transaction(async () => {
      for (const r of rows) {
        await store.upsertAiAuthorship(r)
        scored++
      }
    })
  }
  return { scored }
}
