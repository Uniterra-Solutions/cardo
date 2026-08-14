---
name: manage-git-repo
description: >-
  Git repository management: commit changes, bump versions, create
  semantic-version releases with changelogs and annotated tags, push
  to remotes, create semantic branches, batch-commit, open pull
  requests, and create stacked PRs for multi-commit changes. Use
  when the user asks to commit, push, tag, release, bump a version,
  write a changelog, manage a git repository, create a branch from
  changes, open a PR (提交, 發布, 推送, 版本, 標籤, 合併, PR, git).
  NOT for: single-file quick commits, CI/CD pipeline setup, or
  non-git releases (npm publish, PyPI, Docker).
  
---

# Manage Git Repo

## Goal

Four independent workflows for git housekeeping:

- **Workflow A — Commit:** Group working-tree changes by category and commit
  them in logical order (docs → refactor → feat/fix → test). Every commit
  passes pre-commit hooks and uses conventional commit format.

- **Workflow B — Version Release:** Determine the semantic version bump from
  commit history, update every version reference across the project, maintain
  the changelog, create an annotated `v`-prefixed tag, and push if the user
  confirms push access.

- **Workflow C — Branch + Batch Commit + PR:** Create a semantic branch from
  current changes, batch-commit them using Workflow A's categorization, push
  the branch, and open a single pull request. Use when the user says "create a
  PR," "開 PR," "提交 PR," or asks to branch/commit/PR in one flow — and the
  change fits in one reviewable PR (typically ≤ 3 commits).

- **Workflow D — Stacked PR:** Create a stack of dependent pull requests where
  each layer is one focused commit, using GitHub's native Stacked PRs feature
  (`gh stack`). Use when the user asks to create a PR AND the change involves
  **multiple commits** (4+ commits, or 2–3 commits that each represent a
  distinct logical layer). Each commit becomes its own reviewable PR; the
  whole stack merges in one click.

Workflows are independent — commit without releasing, release an
already-committed state, branch+PR without releasing, or stack a multi-commit
change.

## Core Principles

**Commit ordering is a dependency chain.** Documentation and chores go first
because they describe the current state; refactors come next because features
and fixes build on clean code; tests go last because they validate the
features/fixes above them. Chronological order is irrelevant — only logical
dependency matters.

**Cumulative semver — highest applicable bump wins.** A release containing five
`feat:` commits and three `fix:` commits is a MINOR bump (feat dominates fix).
A single BREAKING CHANGE forces MAJOR regardless of everything else.

**Push is opt-in.** Never push without explicit confirmation. A remote URL
proves the remote exists — it does not prove the user wants to push to it.
The remote could be a fork, a read-only mirror, or intentionally local work.

**Version references are declarations only.** Replace version strings in
structured fields (`pyproject.toml`, `package.json`, `plugin.yaml`,
`__version__`). Never touch historical prose like "v0.6.0 rewrote the
architecture" — those are historical facts, not version declarations.

## Workflow A: Commit

### A.1 — Check for changes

Abort if the working tree has no changes. Report what's staged vs unstaged.

### A.2 — Update documentation first

Before committing code, review and update:
- `AGENTS.md` / `CLAUDE.md` — build/test commands still accurate?
- `docs/` — any references to behaviour that changed?
- `README.md` — outdated information?

Apply fixes. This becomes the first commit — documentation describes what
exists, so it must be current before any code changes land.

### A.3 — Categorize remaining changes

Classify each changed file by its *primary purpose*:

| Category  | Prefix     | When to use                                    |
|-----------|------------|------------------------------------------------|
| docs      | `docs:`    | Documentation, docstrings, comments            |
| feat      | `feat:`    | New feature, endpoint, or capability           |
| fix       | `fix:`     | Bug fix, error handling, edge case             |
| refactor  | `refactor:`| Restructure, rename, simplify (no behaviour change) |
| chore     | `chore:`   | Dependencies, config, CI, tooling              |
| test      | `test:`    | Test additions or updates only                 |

### A.4 — Commit in dependency order

1. `chore:` / `docs:` — foundation
2. `refactor:` — clean structure
3. `feat:` / `fix:` — substance
4. `test:` — validation

For each group: stage the files, write a conventional commit message with
optional scope (`feat(auth): add OAuth2 login`), and verify pre-commit hooks
pass. Fix and amend if hooks fail — never skip with `--no-verify` unless the
user explicitly requests it.

### A.5 — Final check

Review the new commits and confirm the working tree is clean.

---

## Workflow B: Version Release

### B.1 — Determine bump type

Read commits since the last tag. Classify the bump:

| Commits contain...                   | Bump  |
|--------------------------------------|-------|
| BREAKING CHANGE, major API removal   | MAJOR |
| At least one `feat:`                 | MINOR |
| Only `fix:`, `docs:`, `chore:`, etc. | PATCH |

Semver is strict: MAJOR for breaking changes; MINOR for any new feature;
PATCH for fixes, docs, deps, and internal-only changes. When uncertain,
present the commits and ask the user.

### B.2 — Find all version references

Use a two-pronged search:

1. **Literal string** — search the current version number across the project.
   Catches inline references in README, docs, and config.
2. **Structured fields** — search for `version =` in TOML/JSON, `__version__`
   in Python, `version:` in YAML. Catches declarations that differ from the
   literal string format.

For each match, classify: **declaration** (must update) vs **historical
reference** (must NOT touch). Present the list before editing.

### B.3 — Update version + changelog

1. **Bump version files** — replace the old version only in declarations.
2. **Update CHANGELOG** — prepend an entry derived from `git log`:

   ```markdown
   ## v<NEW> — <YYYY-MM-DD>
   ### Added
   - <features from feat: commits>
   ### Changed
   - <behavioural changes>
   ### Fixed
   - <fixes from fix: commits>
   ```

   Include a full-changelog comparison link if the project has a GitHub URL.
   Never delete old entries — the changelog is the complete release record.

### B.4 — Commit and tag

Commit the version bump as `chore(release): bump version to v<NEW>`.
Create an annotated tag: `v<NEW>` — always `v`-prefixed.

### B.5 — Push (conditional)

Confirm push access with the user, then push branch + tag. If push is denied
or uncertain, complete all local operations and report what would be pushed.

### B.6 — Summary

Report: bump type + reason, commit count, files updated, tag name, push status.

---

## Workflow C: Branch + Batch Commit + PR

### C.1 — Pre-flight checks

1. **Auth check** — verify GitHub authentication (see `github-auth` skill):
   ```bash
   if command -v gh &>/dev/null && gh auth status &>/dev/null; then
     AUTH="gh"
   elif [ -n "$GITHUB_TOKEN" ]; then
     AUTH="curl"
   elif _hermes_env="${HERMES_HOME:-$HOME/.hermes}/.env"; [ -f "$_hermes_env" ] && grep -q "^GITHUB_TOKEN=" "$_hermes_env"; then
     export GITHUB_TOKEN=$(grep "^GITHUB_TOKEN=" "$_hermes_env" | head -1 | cut -d= -f2 | tr -d '\n\r')
     AUTH="curl"
   else
     echo "ABORT: no GitHub auth found. Run github-auth skill first."
     exit 1
   fi
   ```

2. **Clean index check** — if there are staged changes, ask the user whether to
   include them or unstage first. Uncommitted work is the payload for this
   workflow — it should not be mixed with pre-existing staged changes unless
   intended.

3. **Working tree check** — abort if the working tree has no changes.
   Report what's staged vs unstaged.

4. **Base branch** — identify the default branch (`main` or `master`) and
   ensure it's up to date:
   ```bash
   DEFAULT_BRANCH=$(git remote show origin 2>/dev/null | grep "HEAD branch" | awk '{print $NF}' || echo "main")
   git fetch origin
   ```

### C.2 — Determine branch name from changes

Analyze the changed files to determine the dominant change category and
construct a semantic branch name:

1. **Classify** each changed file using the same categories as Workflow A
   (docs, feat, fix, refactor, chore, test). Count occurrences.

2. **Determine the prefix** — the highest-priority category wins:
   `feat` > `fix` > `refactor` > `docs` > `chore` > `test`

3. **Derive a slug** from the change content:
   - Read changed files to extract the primary subject (e.g., a module name,
     feature name, or the bug being fixed)
   - Convert to lowercase, replace spaces/special chars with hyphens
   - Keep it short (2–4 words max)

4. **Assemble** the branch name: `<prefix>/<slug>`
   - Examples: `feat/oauth2-login`, `fix/redirect-loop`, `refactor/auth-module`,
     `docs/api-reference`

5. **Present** the proposed branch name to the user for confirmation before
   creating it. If the user rejects, ask for their preferred name.

### C.3 — Create and switch to branch

```bash
git checkout -b <branch-name>
```

Branch from the current HEAD (which should be the up-to-date default branch
from C.1). If the branch name already exists locally, append a numeric suffix
(e.g., `feat/oauth2-login-2`). If it exists on the remote, abort and ask.

### C.4 — Batch-commit changes (Workflow A)

Now apply Workflow A in full on the new branch:

1. **Update documentation first** (A.2) — review AGENTS.md, docs/, README.md
   for accuracy against the current changes. Commit as `docs:` or `chore:`.

2. **Categorize remaining changes** (A.3) — classify every changed file.

3. **Commit in dependency order** (A.4):
   1. `chore:` / `docs:` — foundation
   2. `refactor:` — clean structure
   3. `feat:` / `fix:` — substance
   4. `test:` — validation

   Each commit must pass pre-commit hooks. Fix and amend if hooks fail — never
   skip with `--no-verify` unless the user explicitly requests it.

4. **Final check** (A.5) — confirm the working tree is clean and review the
   commit log.

### C.5 — Push the branch

```bash
git push -u origin HEAD
```

If push is denied (permission, protected branch), report the error and stop.
Do not force-push unless the user explicitly requests it.

### C.6 — Create the pull request

**Determine base branch** — use the default branch from C.1 unless the user
specified a different target.

**Build the PR body** from the commit history on the branch:

```bash
# Generate a summary from commits since branching point
git log --oneline $DEFAULT_BRANCH..HEAD
```

The PR body should include:
- **Summary** — one-paragraph description of what this PR does
- **Changes** — bullet list derived from commit messages
- **Test plan** — how to verify the changes (derive from test commits or ask
  the user)

**With gh:**

```bash
gh pr create \
  --title "<type>: <short description>" \
  --body "<PR body>" \
  --base "$DEFAULT_BRANCH"
```

Add `--draft` if the user wants a draft PR. Add `--reviewer <user1>,<user2>`
if reviewers are specified. Add `--label "<label>"` for labels.

**With git + curl:**

Extract owner/repo from the remote:
```bash
REMOTE_URL=$(git remote get-url origin)
OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's|.*github\\.com[:/]||; s|\\.git$||')
BRANCH=$(git branch --show-current)
```

Then:
```bash
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/$OWNER_REPO/pulls" \
  -d "{
    \"title\": \"<type>: <short description>\",
    \"body\": \"<PR body>\",
    \"head\": \"$BRANCH\",
    \"base\": \"$DEFAULT_BRANCH\"
  }"
```

Save the PR URL from the response and report it to the user.

### C.7 — Summary

Report:
- Branch name created
- Number of commits and their types
- PR URL (or PR number if gh)
- Whether the PR is a draft
- Base branch targeted

---

## Workflow D: Stacked PR

Stacked PRs (GitHub public preview, July 2026) break a multi-commit change
into a chain of small, dependent pull requests. Each layer is one focused
commit — reviewers see only that layer's diff. The whole stack merges in one
click via `gh stack merge`.

**Trigger:** User asks to create a PR AND there are multiple commits (4+, or
2–3 commits that each represent a distinct logical layer — e.g., refactor
then feature then test).

**Prerequisite:** The `gh stack` CLI extension must be installed. It requires
`gh` ≥ 2.90.0 and Git ≥ 2.20.

### D.1 — Pre-flight checks

Same as C.1, plus verify the `gh stack` extension:

```bash
# Check gh version
gh --version | head -1

# Install the extension if missing
if ! gh extension list 2>/dev/null | grep -q 'github/gh-stack'; then
  gh extension install github/gh-stack
fi

# Verify installation
gh stack --help &>/dev/null || { echo "ABORT: gh stack extension failed to install"; exit 9; }
```

Exit code 9 means "Stacked pull requests are not enabled for this repository"
— the feature is in public preview and may not yet be available.

### D.2 — Classify commits into stack layers

Run Workflow A (A.2–A.4) first to categorize and commit all changes. Then
inspect the resulting commits:

```bash
git log --oneline $DEFAULT_BRANCH..HEAD
```

Each commit becomes one layer in the stack. If a commit is trivial (e.g., a
one-line lint fix), fold it into the layer below with `git rebase -i` before
proceeding. Each layer should be a meaningful, reviewable unit.

**Layer ordering** — same dependency order as Workflow A:
1. `chore:` / `docs:` (bottom of stack, closest to trunk)
2. `refactor:`
3. `feat:` / `fix:`
4. `test:` (top of stack)

### D.3 — Initialize the stack

```bash
# Create the first layer (bottom of stack, closest to trunk)
gh stack init <first-layer-branch>
```

The first layer branch name follows the same semantic naming as C.2:
`<prefix>/<slug>`. Examples: `chore/update-docs`, `refactor/auth-module`,
`feat/oauth2-login`.

`gh stack init` enables `git rerere` automatically for conflict resolution
across rebases.

### D.4 — Cherry-pick each subsequent commit onto its own layer

For each remaining commit (in order from bottom to top):

```bash
# Create the next layer branch
gh stack add <layer-branch>

# Cherry-pick the commit onto this layer
git cherry-pick <commit-hash>

# If the cherry-pick has conflicts, resolve them, then:
# git add <resolved-files>
# git cherry-pick --continue
```

**Important:** Cherry-pick commits one at a time, in the exact order they
appear in the original branch. Each `gh stack add` creates a branch whose
parent is the previous layer — this is what forms the dependency chain.

If `gh stack add` fails because the current branch is not the top of the
stack, run `gh stack top` to jump there first.

### D.5 — Verify the stack

```bash
gh stack view
```

Confirm:
- Every layer has exactly one commit
- Layer ordering is correct (docs/chore → refactor → feat/fix → test)
- Each commit message is conventional and descriptive (it becomes the PR title
  in `gh stack submit --auto` mode)

### D.6 — Push and submit

```bash
# Push all stack branches to the remote
gh stack push

# Create pull requests for every layer and link them as a stack on GitHub
gh stack submit
```

`gh stack submit` opens an interactive editor to review and edit PR titles
and descriptions. In non-interactive mode or with `--auto`, it generates
titles from commit messages automatically.

Flags:
- `--auto` — skip the editor, auto-generate PR titles from commit messages
- `--open` — create PRs as ready for review (default is draft mode)
- `--draft` is the default — each PR opens as a draft. Use `--open` to flip.

### D.7 — Report the stack

After `gh stack submit`, report:
- Stack number (shown in the submit output and on github.com)
- Number of layers (branches/PRs)
- Each layer: branch name → commit summary → PR URL
- Merge command: `gh stack merge` (or `gh stack merge <stack-number>`)

### D.8 — Merging the stack

When the user is ready to merge, or when all reviews are approved:

```bash
# Interactive — pick which layers to merge
gh stack merge

# Non-interactive — merge the entire stack
gh stack merge --yes --squash
```

The merge is all-or-nothing: if any PR fails checks, none are merged. Stacked
PRs work with merge queues — use `gh stack merge` (not `gh pr merge`) to
preserve the atomic merge.

## Gotchas

- **Cumulative semver is absolute.** A single `feat:` anywhere in the commit
  range forces MINOR — even if every other commit is a fix.
- **Historical version references must survive.** "v0.6.0 introduced X" in
  docs stays forever. Update only structured version declarations.
- **`v`-prefix is mandatory.** Tags are `v1.2.3`, never `1.2.3`.
- **Empty state is an error, not a no-op.** If Workflow A finds no changes,
  stop and report it. If Workflow B finds no commits since the last tag, ask
  whether the user intended to release.
- **Secrets check before every commit.** Verify `.env`, `.env.local`,
  `credentials.json` are in `.gitignore`. If a secret file is accidentally
  staged, unstage it and fix `.gitignore` — never proceed with secrets in the
  index.
- **Pre-commit hooks are blocking.** Never skip hooks with `--no-verify`
  unless the user explicitly requests it with justification.
- **Workflow C — branch naming must be semantic.** The branch prefix reflects
  the dominant change category, not the user's mood or a ticket number alone.
  `feat/`, `fix/`, `refactor/`, `docs/`, `chore/` are the only valid prefixes.
- **Workflow C — branch from clean default.** Always branch from an up-to-date
  default branch. Branching from a stale main or a feature branch produces
  merge conflicts and confusing diffs.
- **Workflow C — PR body is derived from commits.** The commit messages are
  the canonical change log for the PR. If the commits don't tell a clear story,
  rebase and reword them before opening the PR — don't paper over messy commits
  with a hand-written PR body.
- **Workflow C — push is always opt-in for the PR step.** Pushing the branch
  (C.5) is automatic because the user asked to create a PR. But the PR creation
  itself (C.6) should confirm the title and base branch before firing.
- **Workflow D — `gh stack` extension is required.** The extension
  (`github/gh-stack`) must be installed and the repository must have Stacked
  PRs enabled (public preview, rolling out to all repositories). If the
  repository does not support stacked PRs yet, fall back to Workflow C.
- **Workflow D — one commit per layer.** Stacked PRs are most effective when
  each layer is a single, focused commit. If a layer accumulates multiple
  commits during development, squash them before submitting. Use
  `gh stack modify` to restructure layers if needed.
- **Workflow D — cherry-pick, don't rebase onto.** When distributing existing
  commits across stack layers, use `git cherry-pick` to copy each commit onto
  its layer branch. Do not rebase the original branch onto the stack — that
  rewrites history unpredictably across multiple branches.
- **Workflow D — merge with `gh stack merge`, not `gh pr merge`.** Standard
  `gh pr merge` does not understand stack dependencies. Always use
  `gh stack merge` to preserve the atomic merge guarantee.
- **Workflow D — stack must be linear.** No merge commits in the stack.
  `gh stack modify` enforces linear history; if it rejects your stack, rebase
  to remove merge commits before proceeding.
