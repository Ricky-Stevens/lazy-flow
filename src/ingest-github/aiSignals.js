/**
 * Repo-level AI-tooling maturity collection (GitHub).
 *
 * Two tool-agnostic, configurable signal families per repo, written to
 * `repo_ai_signals`:
 *   - assistant_config: presence of an AI-assistant config file in the repo tree
 *     (CLAUDE.md, AGENTS.md, GEMINI.md, .cursor*, copilot-instructions, …). This
 *     is the strongest deterministic "this repo has adopted AI tooling" signal and
 *     needs no commit markers. Fetched via the GraphQL object() probe.
 *   - agent_bot: an AI agent/bot account (Copilot, Codex, Devin, …) actually
 *     authored a PR or commit in the repo. Derived from already-ingested data.
 *
 * Marker and bot lists are defaults, fully overridable via options — nothing is
 * hardcoded to a single vendor or to one company's setup.
 */

import { DEFAULT_AI_BOT_LOGINS } from '../core/index.js'

/** Default AI-assistant config markers. `signal` is the stored key; a marker is
 * "present" if ANY of its candidate paths exists at HEAD. */
export const DEFAULT_AI_MARKERS = [
  { signal: 'claude', paths: ['CLAUDE.md', '.claude'] },
  { signal: 'agents', paths: ['AGENTS.md'] },
  { signal: 'gemini', paths: ['GEMINI.md', '.gemini'] },
  { signal: 'cursor', paths: ['.cursorrules', '.cursor'] },
  { signal: 'copilot', paths: ['.github/copilot-instructions.md'] },
  { signal: 'windsurf', paths: ['.windsurfrules'] },
  { signal: 'aider', paths: ['.aider.conf.yml'] },
  { signal: 'continue', paths: ['.continue'] },
  { signal: 'codeium', paths: ['.codeium'] },
  { signal: 'cline', paths: ['.clinerules'] },
  { signal: 'codex', paths: ['.codex', 'codex.md'] },
]

/**
 * Detect + persist repo-level AI signals for the given repos. Best-effort per
 * repo (a failed config probe for one repo doesn't abort the rest). Idempotent
 * (upsert), so iterative syncs simply refresh presence.
 */
export async function ingestRepoAiSignals(store, client, repos, options = {}) {
  const now = options.now ?? new Date().toISOString()
  const markers = options.markers ?? DEFAULT_AI_MARKERS
  const aiBotLogins = new Set(
    (options.aiBotLogins ?? DEFAULT_AI_BOT_LOGINS).map((s) => s.toLowerCase()),
  )

  // identity id → github login, for AI-agent-author detection.
  const loginOf = new Map()
  for (const i of await store.listAllIdentities()) {
    if (i.kind === 'github_login') loginOf.set(i.id, i.externalId.toLowerCase())
  }

  let signalsWritten = 0
  for (const repo of repos) {
    // (a) AI-assistant config files — needs a live client; best-effort.
    if (client && typeof client.fetchPathsPresent === 'function') {
      try {
        const allPaths = markers.flatMap((m) => m.paths)
        const present = await client.fetchPathsPresent(repo.owner, repo.name, allPaths)
        for (const m of markers) {
          const hit = m.paths.find((p) => present.has(p)) ?? null
          await store.upsertRepoAiSignal({
            repoId: repo.id,
            signal: `config:${m.signal}`,
            category: 'assistant_config',
            present: hit !== null,
            detail: hit,
            detectedAt: now,
          })
          signalsWritten++
        }
      } catch {
        // Config probe failed (permissions / empty repo) — skip, don't fail sync.
      }
    }

    // (b) AI agent/bot authorship — derived from already-ingested PRs/commits.
    const botsSeen = new Map() // login → where first seen
    for (const pr of await store.getPullRequestsByRepo(repo.id)) {
      const login = loginOf.get(pr.authorIdentityId)
      if (login && aiBotLogins.has(login)) botsSeen.set(login, 'pr_author')
    }
    for (const c of await store.getCommitsByRepo(repo.id)) {
      const login = loginOf.get(c.authorIdentityId)
      if (login && aiBotLogins.has(login) && !botsSeen.has(login))
        botsSeen.set(login, 'commit_author')
    }
    for (const [login, detail] of botsSeen) {
      await store.upsertRepoAiSignal({
        repoId: repo.id,
        signal: `bot:${login}`,
        category: 'agent_bot',
        present: true,
        detail,
        detectedAt: now,
      })
      signalsWritten++
    }
  }

  return { signalsWritten }
}
