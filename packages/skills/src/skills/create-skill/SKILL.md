---
name: create-skill
description: >
  Guides the agent through creating a new Agent Skill from scratch.
  Use when the user wants to build a skill, create a new skill,
  scaffold a skill directory, or author a SKILL.md.
  Do NOT use for optimising or rewriting existing skills — use
  'optimise-skill' for that.
  Do NOT use for editing files that are already part of a skill.
  Do NOT use for creating non-skill content like documentation, scripts,
  or project files.
---

# Create Skill

6-phase workflow: **Discover → Design → Plan → Build → Validate → Deliver**.

## Core Principles

### Skill Anatomy

```
skill-name/
├── SKILL.md         # Behavioural guidance (how to think, what to check)
├── scripts/         # Deterministic, fragile operations (tested code)
├── references/      # Look-up material, loaded on demand
└── assets/          # Output templates, structure only
```

### Three-Layer Separation

Every piece of content belongs in exactly one layer:
- **Behavioural** (SKILL.md) — how to think, what to check, what principles
- **Format** (assets/) — what the output structure looks like
- **Tool** (references/) — CLI flags, API params, external commands

No mixing layers is the most common new-skill mistake.

### Degrees of Freedom

Match instruction tightness to task fragility:
- **High (text guidance)** — exploratory, context-dependent decisions
- **Medium (pseudocode/script with params)** — preferred pattern, some variation OK
- **Low (specific script, few params)** — fragile, consistency critical

See `references/degrees-of-freedom.md` for the full decision tree.

### CSO Rule for Descriptions

The `description` field is the **only metadata the agent sees** to decide
whether to load a skill. Never summarise the workflow — describe *what* the
skill does and *when to use it*, not *how it works*.

See `references/anti-patterns.md` for bad/good examples.

---

## Workflow

### Phase 1: DISCOVER — Understand the Skill's Purpose

Collect answers before writing anything.

**1a — Five Core Questions**

Ask the user:
1. **One-liner**: What does this skill do in one sentence?
2. **Inputs**: What does it read or receive?
3. **Outputs**: What does it produce?
4. **Consumer**: Who or what consumes the output?
5. **Pitfalls**: Known gotchas or environment-specific facts?

**1b — Degrees of Freedom**

For each operation, determine instruction tightness by asking:
- Flexibility or exact sequence?
- Fragile or exploratory?
- One right way or many valid approaches?

Use `references/degrees-of-freedom.md` for the decision tree.

---

### Phase 2: DESIGN — Preview the Expected Interaction

Before building anything, show the user what the skill will look like.

**2a — Mock Dialogue**

Construct a 3–4 turn dialogue: user triggers the skill → agent responds,
including one edge case (missing input, failure recovery). Format:

```
User: <realistic trigger request>
Agent: <expected response>

User: <follow-up or edge case>
Agent: <handling or final output>
```

Present to the user: "Is this the interaction you expect?"
- YES → proceed.
- NO → revise and reconfirm.

---

### Phase 3: PLAN — Map Content to Files

**3a — Classify Every Element**

| Bucket       | When to use                                    |
|--------------|------------------------------------------------|
| **SKILL.md** | Behavioural guidance (principles, steps, checks) |
| **scripts/** | Deterministic, fragile operations              |
| **references/** | Look-up material (schemas, CLI flags, API docs) |
| **assets/**  | Output templates, structure only                |

One item → one bucket. No mixing.

**3b — Design Directory**

```
proposed-name/
├── SKILL.md
├── scripts/      # only if Step 3a produced script items
├── references/   # only if Step 3a produced reference items
└── assets/       # only if Step 3a produced asset items
```

Minimal viable skill: just `SKILL.md`.

---

### Phase 4: BUILD — Create the Files

**4a — Scaffold**

```bash
mkdir -p skills/<skill-name>/{scripts,references,assets}
rmdir <empty-dirs>
```

Or use `scripts/init-skill.sh <skill-name>` with optional `--with-*` flags.

**4b — Write SKILL.md**

Use `assets/skill-template.md` for structure. Rules:
- `name` matches directory name (lowercase + hyphens, < 64 chars)
- `description` follows CSO Rule — concrete triggers + negative triggers
- Third-person imperative: "Verify..." not "You should verify..."
- Under 500 lines. Split dense content into references/
- Include `## Gotchas` section with environment-specific facts
- Reference files explicitly: "See `references/schema.md` for structure"

**4c — Write Supporting Files**

- **scripts/**: Tested executables. Accept CLI args/stdin, output to stdout,
  descriptive error messages so the agent can self-correct. Run before finalising.
- **references/**: One topic per file. ToC if >100 lines. No behavioural guidance.
- **assets/**: Structure only — `{{placeholder}}` tokens. No instructions or rules.

---

### Phase 5: VALIDATE — Ensure Quality

Run these checks in order. Fix failures before proceeding.

**5a — Discovery Validation**

Present the frontmatter to yourself: *"Based on this name + description,
generate 3 prompts that SHOULD trigger this skill and 3 that should NOT.
Critique the description and propose revisions if needed."*

Fix the description if it produces false positives/negatives.

**5b — Simulated Execution**

Walk through the SKILL.md step-by-step as an agent running it. Flag any
line where you'd have to guess or hallucinate. Clarify those instructions.

**5c — Edge Case Attack**

Ask: *"What if a referenced file is missing? Input violates assumptions?
Script fails mid-execution?"* Fix gaps found.

**5d — Structural Checks**

Run `python scripts/validate-skill.py skills/<skill-name>` if available.

Manually verify:
- [ ] Same inputs → same outputs (core deliverable preserved)
- [ ] Description includes negative triggers
- [ ] No behavioural guidance in templates — structure only
- [ ] No references marked as required reading
- [ ] SKILL.md under 500 lines
- [ ] No duplicate or overlapping steps
- [ ] All cross-references valid
- [ ] Gotchas section present with concrete facts
- [ ] No instructions the model would follow correctly without being told
- [ ] No README, CHANGELOG, or human docs in skill directory

---

### Phase 6: DELIVER — Present the Result

Show the user:
1. Directory structure of the new skill
2. Summary of each file's purpose
3. Key decisions (script vs inline, reference extracted, etc.)
4. Point to `optimise-skill` for a token-efficiency pass

```
✅ Skill created: skills/<name>/

<name>/
├── SKILL.md          — <N> lines, core workflow + gotchas
├── scripts/          — <what scripts do>
├── references/       — <what references cover>
└── assets/           — <what templates provide>
```

Example: *"The script was extracted because JSON parsing is fragile when
written from scratch. Reference material was split out to keep SKILL.md
under 200 lines."*

---

## Gotchas

- **Empty subdirectories confuse agents.** Only create `scripts/`,
  `references/`, or `assets/` when they have actual files.
- **All routing metadata goes in the `description` frontmatter field.**
  Don't add a "When to Use" section in the body.
- **`name` must match the directory name** (lowercase, hyphens, < 64 chars).
  If they diverge, some agents won't load the skill.
- **No human-facing docs** (README, CHANGELOG, LICENSE) inside a skill
  directory. Skills are for agents, not humans.
- **Default assumption: the model is already smart.** Don't explain basic
  concepts (HTTP, JSON, git). Add only what's project-specific, non-obvious,
  or where the default behaviour would be wrong.
- **Mock dialogues are design tools, not part of the output.** Delete before
  delivering.

## References

- `references/spec.md` — agentskills.io spec summary
- `references/anti-patterns.md` — common skill-writing mistakes with fixes
- `references/degrees-of-freedom.md` — decision tree for instruction tightness
- `assets/skill-template.md` — structure template for the generated SKILL.md

## Scripts

- `scripts/validate-skill.py` — structural validation for generated skills
- `scripts/init-skill.sh` — scaffold an empty skill directory
