# Community Practices — Research Bibliography

Key sources behind the rules in SKILL.md. Load for deeper context on why
specific checks exist.

## Primary Sources

### 1. agents.md (official spec)
- https://agents.md/ | https://github.com/agentsmd/agents.md (22K+ stars)
- Stewarded by Agentic AI Foundation (Linux Foundation) since Dec 2025
- 60,000+ repos, 30+ compatible tools
- Plain Markdown, no required schema, root-of-repo convention

### 2. GitHub Blog: analysis of 2,500+ agents.md files (Nov 2025)
- https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/
- Six core areas, three-tier boundaries, commands-first principle
- "Never commit secrets" = most common helpful constraint

### 3. AgentPatterns.ai: "AGENTS.md as Table of Contents"
- https://agentpatterns.ai/standards/agents-md/
- ~100-line target, pointers-not-encyclopedia, three-layer separation
- Distinction: AGENTS.md = project context; Agent Skills = task knowledge

### 4. ETH Zurich Study (arXiv:2602.11988)
- https://arxiv.org/html/2602.11988v1
- 138 repos, 5,694 PRs
- LLM-generated context: -3% success, +20% cost
- Human-curated: +4% gain, same token overhead
- Conclusion: minimal requirements only

### 5. agentconfig.ing — tool behavior differences
- https://agentconfig.ing/files/agents-md/
- Codex: concatenates root-to-CWD; Copilot: nearest-ancestor-only
- `AGENTS.override.md` for personal overrides (Codex only)
- 64KB max (configurable), no @import, no frontmatter

## Key Statistics

| Stat | Value | Source |
|------|-------|--------|
| Repos with AGENTS.md | 96,600+ (Jun 2026) | GitHub code search |
| Compatible tools | 30+ | agents.md |
| Optimal length | ~100 lines | AgentPatterns.ai |
| Codex hard cap | 64KB (configurable) | Codex docs |
| LLM-generated context delta | -3% success, +20% cost | ETH Zurich |
| Human-curated context delta | +4% success | ETH Zurich |
| OpenAI internal AGENTS.md files | 88 | agents.md FAQ |

## Anti-Pattern Catalog

| Anti-pattern | Why it fails | Fix |
|-------------|-------------|-----|
| "Write clean code" | Not falsifiable | Replace with specific checkable rule |
| Duplicating config files | Agent already reads them — wasted tokens | Remove; keep only non-obvious rules |
| 500-line AGENTS.md | Crowds out task context | Move deep content to docs/, keep pointers |
| @import syntax | Claude-only, breaks in Codex/Cursor | Remove; all content inline |
| Missing "Never" rules | No guardrails | Add at minimum one hard boundary |
| Stale commands | Agent runs failing commands | Run every command during audit |
| "We use React" | Too vague | "React 18 + TypeScript, Vite, Tailwind CSS" |
| No test instructions | Agent can't validate work | Add exact test command + coverage expectations |
| File listing without purpose | Agents can `ls` | Map dir→responsibility instead |
| Marketing copy | Wastes tokens | Delete |

## AGENTS.md vs CLAUDE.md

- AGENTS.md = cross-tool (Codex, Cursor, Copilot, Aider, Gemini CLI, ~20 more)
- CLAUDE.md = Claude Code only (@import, CLAUDE.local.md, managed policies)
- Claude Code does NOT read AGENTS.md natively → `CLAUDE.md` with `@AGENTS.md`
- Rule: cross-tool rules → AGENTS.md; Claude-specific behavior → CLAUDE.md

## Monorepo Patterns

- Root AGENTS.md: repo-wide conventions, shared tooling
- Package AGENTS.md: package-specific commands (self-contained for Copilot)
- Copilot: nearest-ancestor-only; Codex: root-to-CWD concatenation
