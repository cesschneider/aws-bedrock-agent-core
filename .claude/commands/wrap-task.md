---
description: Close out the current task, persist a compact state summary using a subagent, and prep for context compact/clear.
argument-hint: [label for log entry]
---

Close out the current unit of work and save state so the user can safely run `/compact` or `/clear` without losing context.

1. **Delegate state-gathering to a subagent.** Launch a `general-purpose` Agent (foreground, `run_in_background: false`) with this prompt:
   > Run `git status`, `git log --oneline -5`, and (if on a feature branch) `gh pr list --head $(git branch --show-current)` and `gh run list --branch $(git branch --show-current) --limit 5` in the aws-bedrock-agent-core repo. Return a compact bullet summary under 150 words: what shipped, what's open, what needs the user next. Note any uncommitted changes or unpushed commits.

   Do NOT re-run these checks yourself — the subagent handles it so the main context stays clean.

2. **Append the subagent's summary** to `.claude/session-log.md` (create if missing) under `## <ISO datetime> — $ARGUMENTS`. This is local scratch — don't polish into documentation.

3. **If the subagent flagged uncommitted work or unpushed commits**, surface that to the user directly. Do not compact past uncommitted work.

4. **Report back in 1-2 sentences**: what was closed out, where the log entry lives, and that it's now safe to `/compact`.
