# Degrees of Freedom Decision Tree

Use this reference when deciding how tightly to specify instructions in a new
skill. The goal is to match instruction tightness to task fragility — not to
default to one extreme.

## The Principle

Think of the agent as exploring a path:
- **Narrow bridge with cliffs** → specific guardrails (low freedom)
- **Open field with many routes** → guidance only (high freedom)

## Decision Tree

Start here for each operation the skill performs:

```
Is the operation fragile or error-prone?
├── YES → Is consistency critical?
│   ├── YES → LOW FREEDOM (specific script with few params)
│   │   Example: PDF rotation, git merge, API call with auth
│   │   What to create: scripts/rotate.py with tested code
│   │
│   └── NO → MEDIUM FREEDOM (pseudocode or script with params)
│       Example: Data transformation with configurable options
│       What to create: scripts/transform.py with CLI args
│
└── NO → Are there multiple valid approaches?
    ├── YES → HIGH FREEDOM (text guidance only)
    │   Example: Code review criteria, research methodology
    │   What to create: inline text in SKILL.md only
    │
    └── NO → MEDIUM FREEDOM (preferred pattern)
        Example: Standard workflow with some variation
        What to create: Pseudocode steps in SKILL.md
```

## By Content Type

| Content type                  | Freedom | Why                              |
| ----------------------------- | ------- | -------------------------------- |
| Business logic, heuristics    | High    | Context-dependent decisions      |
| Code review criteria          | High    | Multiple valid approaches        |
| Standard workflow steps       | Medium  | Preferred pattern exists         |
| API usage with auth           | Medium  | Params vary per call             |
| Complex data parsing          | Low     | Fragile, error-prone             |
| File operations (delete/move) | Low     | Irreversible, must be exact      |
| Git operations                | Low     | Consistency critical             |
| CLI invocation with flags     | Low     | Exact syntax required            |

## Implementation Guidance

| Freedom  | How to express in the skill |
|----------|----------------------------|
| **High** | Principles, questions to consider, outcomes to achieve. No concrete code. |
| **Medium** | Pseudocode, script skeleton with placeholders, expected patterns. |
| **Low** | Full tested script in `scripts/` with CLI interface. SKILL.md just says "Run `scripts/x.py --input file`". |
