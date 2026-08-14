# Skill Authoring Anti-Patterns

Common mistakes when writing skills. Reference this list during the Plan and
Validate phases to catch issues early.

## 1. Workflow Summary in Description (CSO Violation)

**Problem**: The description summarises steps ("First we ask, then we create...").
The agent reads the summary and skips the body.

**Fix**: Describe what the skill *is* and *when to use it*, not how it works.

## 2. Overly Vague Description

**Problem**: "Helps with React components."

**Fix**: Include trigger phrases and negative triggers:
"Creates and builds React components using Tailwind CSS. Use when the user
wants to update component styles or UI logic. Do NOT use for Vue, Svelte,
or vanilla CSS projects."

## 3. Missing Negative Triggers

**Problem**: The skill fires on unrelated tasks because the description
doesn't exclude them.

**Fix**: Add "Do NOT use for..." with concrete excluded scenarios.

## 4. SKILL.md Over 500 Lines

**Problem**: Context bloat. The body competes with conversation history,
system prompt, and other skills' metadata.

**Fix**: Split dense content into references/ files. Keep SKILL.md as the
index and behavioural guide.

## 5. Behavioural Content in Templates

**Problem**: Template files contain instructions like "Make sure to check
the status code" or "First validate the input, then..."

**Fix**: Templates show structure only — `{{placeholder}}` tokens and format
skeleton. Move behavioural guidance to SKILL.md.

## 6. Required Reading in References

**Problem**: References marked as "must read" bloat the context window
because the agent loads them unconditionally.

**Fix**: References are **look-up material**. Never mark them required.
Tell the agent "See X when you need Y" — conditional access only.

## 7. Name / Directory Mismatch

**Problem**: The `name` field in frontmatter differs from the parent
directory name.

**Fix**: Enforce `name == directory_name` at creation time.

## 8. Human Documentation Inside Skill

**Problem**: README.md, CHANGELOG.md, LICENSE inside the skill directory.

**Fix**: Skills are for agents, not humans. Delete these files.

## 9. Basic Concept Explanations

**Problem**: Explaining what HTTP is, how JSON works, or basic git commands.

**Fix**: Default assumption: the model is already very smart. Only add what's
non-obvious or project-specific.

## 10. First-Person or Second-Person Instructions

**Problem**: "I will extract the text..." or "You should verify the output..."

**Fix**: Third-person imperative: "Extract the text...", "Verify the output..."

## 11. Empty Subdirectories

**Problem**: `scripts/` directory exists but is empty.

**Fix**: Don't create subdirectories you don't use. Empty dirs confuse agents.

## 12. Nested Subdirectories

**Problem**: `references/db/v1/schema.md` — more than one level deep.

**Fix**: Keep references flat: `references/schema.md`.

## 13. No Gotchas Section

**Problem**: No section for environment-specific facts.

**Fix**: Every skill needs a `## Gotchas` section. It's the highest-value
content per token.

## 14. Degrees of Freedom Mismatch

**Problem**: Writing low-freedom scripts for an exploratory task, or
high-freedom guidance for a fragile operation.

**Fix**: Match instruction tightness to task fragility. See
`references/degrees-of-freedom.md`.
