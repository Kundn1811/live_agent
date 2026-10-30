---
name: pr
description: Raise a pull request from the current branch into master. Checks the branch, pushes it, writes the title and description from the commits, and opens the PR. Use when the user types /pr or asks to raise or open a PR.
disable-model-invocation: true
---

# Raise a PR

Base branch is `master`. It is protected: changes only land through a PR. Keep replies short.

## Steps

1. **Check state** (one Bash call):
   - `git branch --show-current` — if it is `master`, stop and ask for a branch name; never push to `master`.
   - `git status --short` — if there are uncommitted changes, list them and ask whether to commit first. Do not commit unless the user says so.
   - `git fetch origin master` then `git log --oneline origin/master..HEAD` and `git diff --stat origin/master...HEAD`. If there are no commits ahead, say so and stop.

2. **Read the change.** Skim `git diff origin/master...HEAD` for what changed and why. Do not paste the diff into the PR.

3. **Draft the PR.**
   - Title: under 70 chars, imperative, same style as recent commits (`fix: ...`, `feat: ...`, `chore: ...`).
   - Body, in this shape:
     ```
     ## What
     <1-3 bullets: what changed>

     ## Why
     <1-2 sentences>

     ## Test plan
     - [ ] <what to check before/after merge, e.g. one real call on the live site>

     ## Deploy notes
     <only if relevant: secrets, env vars, redeploy order. Else omit the section>

     🤖 Generated with [Claude Code](https://claude.com/claude-code)
     ```
   - Never put secrets, keys, codes, or the contents of `docs/local/` in the body.

4. **Confirm before sending.** Show the title, body and the commit list. Pushing and opening a PR are outward-facing: wait for a yes. An earlier yes does not cover a new PR.

5. **Push and open.**
   - `git push -u origin <branch>` (plain push; never `--force` unless the user asks for it by name).
   - If `gh` is installed (`gh --version` works): `gh pr create --base master --title "<title>" --body "<body>"` (use a heredoc for the body). Print the PR URL.
   - If `gh` is missing: print the compare link instead and give the title and body to paste:
     `https://github.com/Kundn1811/live_agent/compare/master...<branch>?expand=1`

6. **Report** in two lines: the PR URL (or compare link) and anything the user must do next (merge, then the deploy workflow runs for the files it watches; test one live call).

## Rules
- One PR per branch. If one is already open (`gh pr view` works), push the new commits and say the PR was updated.
- Do not merge the PR. Merging is the user's step.
- If the diff touches `agent/` or the deploy workflows, add a "Deploy notes" line naming which workflow will run on merge (`deploy-agent.yml` or `deploy-token-server.yml`).
