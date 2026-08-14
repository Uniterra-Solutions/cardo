# Verification Audit Checklist

After generating or updating the `docs/` tree, run this audit to verify
completeness, correctness, and quality. Every failure must be flagged with
a concrete fix suggestion.

---

## 1. Coverage Audit

**Question:** Is every important part of the codebase documented?

### Checklist

- [ ] Every top-level source directory has a corresponding `docs/modules/<name>.md`
  - Exception: trivial directories (e.g., `types/` with only type definitions)
  - Verify: `ls src/` vs `ls docs/modules/`
- [ ] Every public API function/class has an entry in a module doc or API reference
  - Verify: spot-check 3 random source files for undocumented exports
- [ ] Every database model/entity appears in `docs/data-models.md`
  - Verify: `grep -r "class.*Model" src/` or `grep -r "Table\|Entity" src/` vs data-models.md entries
- [ ] Every HTTP endpoint appears in `docs/api-reference.md`
  - Verify: count route decorations vs api-reference entries
- [ ] Every external service/dependency appears in `docs/tech-stack.md` or `docs/architecture.md`
  - Verify: check `docker-compose.yml` services, env vars for external URLs
- [ ] Every non-trivial env var appears in `docs/setup.md`
  - Verify: compare `.env.example` entries vs setup.md env var table
- [ ] Root `README.md` links to `docs/README.md` and describes the current stack
  - Verify: README's install/run/test commands match `docs/setup.md`; description matches `docs/README.md`

### Coverage Report Format

```markdown
## Coverage Audit

**Result:** PASS / FAIL

| Area | Status | Detail |
|------|--------|--------|
| Modules | PASS | 5/5 modules documented |
| API Endpoints | FAIL | 3 undocumented: POST /webhook, GET /export, DELETE /cache |
| Data Models | PASS | 8/8 models documented |
| External Deps | PASS | All detected |
| Env Vars | FAIL | 2 missing: REDIS_URL, SENTRY_DSN |
```

---

## 2. Link Audit

**Question:** Do all cross-references resolve?

### Checklist

- [ ] Every relative link in `docs/` points to an existing file
  - Verify: `grep -rohE '\[.*\]\(\.\/[^)]+\)' docs/ | sort | uniq` — check each target exists
  - macOS note: BSD grep doesn't support `-P`; use `-E` for extended regex instead
- [ ] Every source code reference (`src/auth/index.ts:1`) points to a real file
  - Verify: spot-check file paths
- [ ] No broken internal anchors (e.g., `[Setup](setup.md#database)` but setup.md has no `#database` heading)
- [ ] The hub `README.md` index lists every file in `docs/`
  - Verify: `ls docs/` vs entries in README.md index
- [ ] Root `README.md`'s docs link resolves
  - Verify: the `[Documentation](docs/README.md)` link target exists
- [ ] Cross-references between docs are bidirectional where appropriate
  - e.g., module doc links to API reference → API reference links back

### Link Audit Report Format

```markdown
## Link Audit

**Result:** PASS / FAIL

Broken links:
- `docs/modules/auth.md:15` → `docs/setup.md#database` — heading `#database` not found (actual: `## Database Setup`)
- `docs/README.md:8` → `docs/modules/billing.md` — file does not exist
```

---

## 3. Freshness Audit

**Question:** Is any documentation stale (describing code that has changed)?

### Checklist

- [ ] No doc references a deleted file or function
  - Verify: `git log --diff-filter=D --name-only` for recently deleted files; grep docs for references
- [ ] No doc describes an API shape that has changed
  - Verify: spot-check 3 recently changed source files against their docs
- [ ] No doc lists a dependency version that doesn't match the lockfile
  - Verify: compare `tech-stack.md` versions vs `pyproject.toml` / `package.json` / `Cargo.toml`
- [ ] Architecture diagram matches the current directory structure and services
  - Verify: compare `docker-compose.yml` services vs architecture diagram nodes
- [ ] Setup commands still work
  - Verify: run the install + run commands from `setup.md` in a dry-run or check mode
- [ ] Test commands still work
  - Verify: run the test command from `testing.md`
- [ ] Root `README.md` doesn't contradict `docs/`
  - Verify: compare stack/commands/description in root README vs `docs/setup.md`, `docs/tech-stack.md`, `docs/README.md`

### Freshness Audit Report Format

```markdown
## Freshness Audit

**Result:** FAIL

Stale sections:
- `docs/modules/billing.md:30` — references `BillingService.process()` which was renamed to `BillingService.handle()` in commit abc123
- `docs/tech-stack.md` — lists SQLAlchemy 1.4, but pyproject.toml requires >=2.0
```

---

## 4. Quality Audit

**Question:** Does the documentation follow agent-first writing conventions?

### Checklist

- [ ] No fluff phrases: search for "in this document", "we will explore", "it's important to note", "please remember", "as you can see", "needless to say"
  - Verify: `grep -rnE '(in this document|we will explore|it.s important to note|please remember|as you can see|needless to say|it is worth mentioning)' docs/`
- [ ] No emojis in doc files
  - Verify: `grep -rP '[\x{1F300}-\x{1F9FF}]' docs/` (rough emoji range check)
- [ ] Every doc file has a "How to Update" or "Find It Fast" section at the end
  - Exception: templates and the hub README may skip this
- [ ] No entry (paragraph without a table or list) exceeds 5 lines
  - Verify: scan visually for long prose blocks
- [ ] Every convention is falsifiable (can check against code)
  - Verify: for each convention, ask "Can an agent look at a file and determine if this is followed?"
- [ ] No duplicated facts across files
  - Verify: `grep -r "keyword" docs/` for suspected duplicates
- [ ] Tables are used for catalogs (APIs, modules, dependencies) rather than bullet lists
- [ ] Source code references include file paths (and line ranges where helpful)

### Quality Audit Report Format

```markdown
## Quality Audit

**Result:** FAIL

Violations:
- `docs/architecture.md:5` — "In this document, we will explore..." → remove fluff
- `docs/setup.md` — no "How to Update" section → add one
- `docs/modules/auth.md:12-20` — 9-line prose block → convert to table
```

---

## 5. Diagram Audit

**Question:** Do the Mermaid diagrams render and match reality?

### Checklist

- [ ] Every Mermaid code block has valid syntax
  - Verify (pick one): (a) check for common errors — unmatched brackets, missing arrows (`-->` or `->>`), unclosed quotes; (b) if `mmdc` CLI is available, run `mmdc -i <file> -o /dev/null`; (c) as last resort, visual scan for valid graph direction (`graph TD`/`LR`), balanced braces, and matching node references
- [ ] Every node/participant in diagrams corresponds to a real directory, service, or component
- [ ] Diagram direction (TD, LR, etc.) is appropriate for the content
- [ ] Entity names match the actual code (no outdated names)

### Diagram Audit Report Format

```markdown
## Diagram Audit

**Result:** PASS

Diagrams: 3/3 valid
- System Context (C4 L1): valid, 4 nodes match reality
- Container (C4 L2): valid, 5 containers match docker-compose.yml
- ER Diagram: valid, 8 entities match models/
```

---

## Composite Audit Report

After running all five audits, produce a composite report:

```markdown
## Documentation Audit Summary

| Audit | Result | Issues |
|-------|--------|--------|
| Coverage | FAIL | 5 undocumented items |
| Links | PASS | 0 broken links |
| Freshness | FAIL | 3 stale sections |
| Quality | PASS | 0 style violations |
| Diagrams | PASS | 3/3 valid |

**Verdict:** FAIL — 2/5 audits have issues.

### Recommended Fixes
1. Document missing API endpoints: POST /webhook, GET /export, DELETE /cache
2. Add missing env vars: REDIS_URL, SENTRY_DSN
3. Update stale sections: billing module, tech-stack versions, API shape
```

---

## Automation Notes

- **Link check** can be automated with `lychee --offline docs/` if the project uses lychee
- **Emoji check** can be automated with a simple grep
- **Coverage check** is semi-automatable: compare source tree vs doc tree
- **Freshness check** requires git diff awareness — best done by an agent, not a script
- **Quality check** needs human/agent judgement for writing style
