/**
 * Prompt registry — versioned prompts keyed by (insight, version).
 *
 * The active prompt_version is recorded with every verdict (SPEC §9.3).
 * Only the harness reads this; individual insight modules will register
 * their prompts here when built in subsequent waves.
 */

export interface PromptEntry {
  insight: string
  version: string
  systemPrompt: string
  userPromptTemplate: (featureVector: Record<string, unknown>) => string
}

const registry = new Map<string, PromptEntry>()

function registryKey(insight: string, version: string): string {
  return `${insight}@${version}`
}

/**
 * Register a versioned prompt.  Each insight module calls this once at module load.
 */
export function registerPrompt(entry: PromptEntry): void {
  registry.set(registryKey(entry.insight, entry.version), entry)
}

/**
 * Retrieve a prompt by (insight, version).  Throws if not found.
 */
export function getPrompt(insight: string, version: string): PromptEntry {
  const entry = registry.get(registryKey(insight, version))
  if (!entry) {
    throw new Error(`Prompt not found: ${insight}@${version}`)
  }
  return entry
}

/**
 * List all registered prompts (insight, version pairs).
 */
export function listPrompts(): Array<{ insight: string; version: string }> {
  return [...registry.values()].map((e) => ({ insight: e.insight, version: e.version }))
}
