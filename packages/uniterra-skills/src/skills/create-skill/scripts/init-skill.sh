#!/usr/bin/env bash
# Scaffold a new agent skill directory with SKILL.md template.
#
# Usage:
#   ./scripts/init-skill.sh my-skill-name
#
# Creates: skills/my-skill-name/
#     ├── SKILL.md
#     ├── scripts/       (optional: --with-scripts)
#     ├── references/    (optional: --with-references)
#     └── assets/        (optional: --with-assets)

set -euo pipefail

SKILL_DIR="skills"

usage() {
    cat <<EOF
Usage: $(basename "$0") <skill-name> [--with-scripts] [--with-references] [--with-assets] [--dir <path>]

Creates a new agent skill directory under <dir>/<skill-name>/.

Arguments:
  skill-name         Hyphenated lowercase name (e.g. 'analytics-report')
  --with-scripts     Include scripts/ subdirectory
  --with-references  Include references/ subdirectory
  --with-assets      Include assets/ subdirectory
  --dir <path>       Parent directory (default: ./skills/)

EOF
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

NAME=""
INCLUDE_SCRIPTS=false
INCLUDE_REFERENCES=false
INCLUDE_ASSETS=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --with-scripts) INCLUDE_SCRIPTS=true; shift ;;
        --with-references) INCLUDE_REFERENCES=true; shift ;;
        --with-assets) INCLUDE_ASSETS=true; shift ;;
        --dir) SKILL_DIR="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) NAME="$1"; shift ;;
    esac
done

# Validate name
if ! echo "$NAME" | grep -qE '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'; then
    echo "❌ Invalid name: '$NAME'"
    echo "   Must be lowercase, hyphens only, 1-64 chars, no consecutive hyphens."
    exit 1
fi

TARGET_DIR="${SKILL_DIR}/${NAME}"

if [[ -d "$TARGET_DIR" ]]; then
    echo "❌ Directory already exists: $TARGET_DIR"
    exit 1
fi

mkdir -p "$TARGET_DIR"

# Generate SKILL.md
cat > "${TARGET_DIR}/SKILL.md" <<SKILLMDEOF
---
name: ${NAME}
description: >
  TODO: Write a one-line description with concrete trigger phrases and
  negative triggers. See create-skill references for CSO rule guidance.
  Use when the user wants to ... Do NOT use for ...
---

# ${NAME}

## Goal

TODO: What does this skill produce? Who consumes the output?

## Workflow

### Phase 1: ...

Step-by-step instructions here.

## Gotchas

- Environment-specific facts that break model defaults go here.
- These are the highest-value content per token.

## References

-

## Scripts

-
SKILLMDEOF

# Optional subdirectories
if $INCLUDE_SCRIPTS; then
    mkdir -p "${TARGET_DIR}/scripts"
    cat > "${TARGET_DIR}/scripts/.gitkeep" <<< ""
fi

if $INCLUDE_REFERENCES; then
    mkdir -p "${TARGET_DIR}/references"
    cat > "${TARGET_DIR}/references/.gitkeep" <<< ""
fi

if $INCLUDE_ASSETS; then
    mkdir -p "${TARGET_DIR}/assets"
    cat > "${TARGET_DIR}/assets/.gitkeep" <<< ""
fi

# Remove .gitkeep if no subdirs were created (they won't exist anyway)
echo "✅ Created skill: ${TARGET_DIR}/"
echo "   ${TARGET_DIR}/SKILL.md"
$INCLUDE_SCRIPTS && echo "   ${TARGET_DIR}/scripts/"
$INCLUDE_REFERENCES && echo "   ${TARGET_DIR}/references/"
$INCLUDE_ASSETS && echo "   ${TARGET_DIR}/assets/"
true  # ensure clean exit regardless of flag evaluation
