---
description: Review and update lazy-flow configuration — repos, Jira projects, visibility mode, churn window, model settings. Use /lazy-flow:config to inspect current settings or guide configuration.
---

# /lazy-flow:config

Call `doctor` to retrieve the current configuration state and health. Show the user what is configured, what is missing, and what actions to take.

Render the tool output faithfully:

- Show each `check` with its `name`, `status` (ok / warn / error), and `message`.
- Show the `overall` health status (healthy / degraded / unhealthy).
- Show `as_of` and `engine_version` from the response envelope.

After showing the doctor output, guide the user on configuration:

- **Secrets** (`github_token`, `jira_oauth_token`, `anthropic_api_key`): set via Claude Code plugin config prompts — these go to the OS keychain. Never log or display secret values.
- **Shared config** (`repos`, `jira_projects`, `visibility`, `churn_window_days`): set in the consuming repo's `.claude/settings.json` under `pluginConfigs.lazy-flow.options`, or via the `userConfig` prompt on install.
- **DB location**: controlled by `LAZYFLOW_DB_PATH` (defaults to `${CLAUDE_PLUGIN_DATA}/lazy-flow.db`).

Do not display or echo secret values. Do not suggest storing secrets in files or environment scripts. If a check is `error`, surface the actionable remediation message from the tool output.
