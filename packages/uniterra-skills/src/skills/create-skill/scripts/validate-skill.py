#!/usr/bin/env python3
"""Validate a skill directory against the agentskills.io standard.

Usage:
    python validate-skill.py path/to/skill-directory

Exits with 0 if all checks pass, non-zero otherwise.
Prints a report of all checks.
"""

import argparse
import re
import sys
from pathlib import Path

# ── helpers ──────────────────────────────────────────────────────────────────


def _extract_frontmatter_field(frontmatter: str, field: str) -> str | None:
    """Extract a YAML field value, supporting folded ('>') and literal ('|') blocks.

    Tries block syntax (>, |) first, then falls back to single-line value.
    """
    # Try folded block (>): continuation lines start with spaces
    folded = re.search(
        rf"^{field}:\s*>\s*\n((?:  .*(?:\n|$))+)",
        frontmatter,
        re.MULTILINE,
    )
    if folded:
        lines = folded.group(1).splitlines()
        parts = [line[2:] if line.startswith("  ") else line for line in lines]
        return " ".join(p.strip() for p in parts if p.strip())

    # Try literal block (|): continuation lines start with spaces
    literal = re.search(
        rf"^{field}:\s*\|\s*\n((?:  .*(?:\n|$))+)",
        frontmatter,
        re.MULTILINE,
    )
    if literal:
        lines = literal.group(1).splitlines()
        parts = [line[2:] if line.startswith("  ") else line for line in lines]
        return "\n".join(p.rstrip() for p in parts)

    # Try single-line: field: value  (not followed by indented lines)
    single = re.search(rf"^{field}:\s*(\S.*?)\s*$", frontmatter, re.MULTILINE)
    if single:
        return single.group(1).strip()

    return None


# ── checks ───────────────────────────────────────────────────────────────────


def check_directory_exists(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    if not skill_dir.is_dir():
        errors.append(f"Directory does not exist: {skill_dir}")
    return errors


def check_skillmd_exists(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    skillmd = skill_dir / "SKILL.md"
    if not skillmd.is_file():
        errors.append(f"SKILL.md not found at {skillmd}")
    return errors


def check_frontmatter(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    skillmd = skill_dir / "SKILL.md"
    if not skillmd.is_file():
        return errors

    content = skillmd.read_text(encoding="utf-8")

    if not content.startswith("---\n"):
        errors.append("SKILL.md must start with '---\\n' (YAML frontmatter)")
        return errors

    second_delim = content.find("\n---\n", 4)
    if second_delim == -1:
        errors.append("SKILL.md missing closing '---' for YAML frontmatter")
        return errors

    frontmatter = content[4:second_delim]

    # Extract name
    name_match = re.search(r"^name:\s*(\S+)", frontmatter, re.MULTILINE)
    if not name_match:
        errors.append("Frontmatter missing 'name' field")
    else:
        name = name_match.group(1)
        if not re.match(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$", name):
            errors.append(
                f"Invalid name '{name}': must be lowercase, hyphens, "
                f"1-64 chars, no consecutive hyphens"
            )
        if name != skill_dir.name:
            errors.append(f"Name '{name}' does not match directory name '{skill_dir.name}'")

    # Extract description
    desc = _extract_frontmatter_field(frontmatter, "description")
    if desc is None:
        errors.append("Frontmatter missing 'description' field")
    else:
        if len(desc) > 1024:
            errors.append(f"Description too long ({len(desc)} chars, max 1024)")
        if "Do NOT use" not in desc and "Do not use" not in desc:
            errors.append("Description should include negative triggers ('Do NOT use for...')")
        workflow_words = {"first", "then", "next", "finally", "step", "phase"}
        desc_lower = desc.lower()
        workflow_hits = [w for w in workflow_words if w in desc_lower]
        if len(workflow_hits) >= 2:
            errors.append(
                f"Possible CSO violation: description contains workflow words "
                f"({', '.join(workflow_hits)}). Don't summarise the workflow — "
                f"describe what the skill does and when to use it."
            )

    return errors


def check_skillmd_length(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    skillmd = skill_dir / "SKILL.md"
    if not skillmd.is_file():
        return errors

    lines = skillmd.read_text(encoding="utf-8").splitlines()
    if len(lines) > 500:
        errors.append(f"SKILL.md too long: {len(lines)} lines (max 500)")
    return errors


def check_no_human_docs(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    forbidden = {
        "README.md",
        "CHANGELOG.md",
        "LICENSE",
        "INSTALLATION_GUIDE.md",
        "QUICK_REFERENCE.md",
    }
    for f in forbidden:
        if (skill_dir / f).is_file():
            errors.append(f"Forbidden file in skill directory: {f}")
    return errors


def check_no_behavioural_in_assets(skill_dir: Path) -> list[str]:
    """Check that template files don't contain behavioural instructions."""
    errors: list[str] = []
    assets_dir = skill_dir / "assets"
    if not assets_dir.is_dir():
        return errors

    behavioural_indicators = [
        "you should",
        "you must",
        "make sure",
        "ensure that",
        "do not",
        "don't",
        "always",
        "never",
        "remember to",
        "first",
        "then",
        "step",
    ]

    for fpath in sorted(assets_dir.rglob("*")):
        if not fpath.is_file():
            continue
        try:
            content = fpath.read_text(encoding="utf-8").lower()
        except Exception:
            continue

        # Filter out structural lines: YAML frontmatter, TODO, placeholders
        lines = content.splitlines()
        in_frontmatter = False
        relevant_lines: list[str] = []
        for raw_line in lines:
            stripped = raw_line.strip()
            if stripped == "---":
                in_frontmatter = not in_frontmatter
                continue
            if in_frontmatter:
                continue
            if stripped.startswith("todo:"):
                continue
            if "{{" in raw_line:
                continue
            if stripped == "":
                continue
            relevant_lines.append(raw_line)

        relevant_content = "\n".join(relevant_lines)
        hits = [ind for ind in behavioural_indicators if ind in relevant_content]
        if hits and len(hits) >= 2:
            errors.append(
                f"Asset '{fpath.relative_to(skill_dir)}' may contain behavioural "
                f"guidance (matches: {', '.join(hits)}). Templates should show "
                f"structure only."
            )
    return errors


def check_scripts_produce_output(skill_dir: Path) -> list[str]:
    """Basic sanity check on script files — are they runnable?."""
    errors: list[str] = []
    scripts_dir = skill_dir / "scripts"
    if not scripts_dir.is_dir():
        return errors

    for fpath in sorted(scripts_dir.iterdir()):
        if not fpath.is_file():
            continue
        if fpath.suffix == ".py":
            content = fpath.read_text(encoding="utf-8")
            if "print" not in content and "return" not in content:
                errors.append(
                    f"Script '{fpath.name}' appears to have no output "
                    f"(no print/return). Agent relies on stdout."
                )
    return errors


def check_subdirs_one_level_deep(skill_dir: Path) -> list[str]:
    """Ensure references/scripts/assets are flat — no nested subdirs."""
    errors: list[str] = []
    for sub in ["references", "scripts", "assets"]:
        subdir = skill_dir / sub
        if not subdir.is_dir():
            continue
        for child in subdir.iterdir():
            if child.is_dir():
                errors.append(
                    f"Nested directory '{child.relative_to(skill_dir)}' — "
                    f"keep all files one level deep in {sub}/"
                )
    return errors


def check_no_empty_subdirs(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    for sub in ["references", "scripts", "assets"]:
        subdir = skill_dir / sub
        if subdir.is_dir():
            if not any(subdir.iterdir()):
                errors.append(f"Empty subdirectory '{sub}/' — remove it")
    return errors


def check_gotchas_section(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    skillmd = skill_dir / "SKILL.md"
    if not skillmd.is_file():
        return errors
    content = skillmd.read_text(encoding="utf-8")
    if "## Gotchas" not in content:
        errors.append("SKILL.md missing '## Gotchas' section for environment-specific facts")
    return errors


def check_cross_references(skill_dir: Path) -> list[str]:
    """Verify that references to local files in SKILL.md point to existing files."""
    errors: list[str] = []
    skillmd = skill_dir / "SKILL.md"
    if not skillmd.is_file():
        return errors

    content = skillmd.read_text(encoding="utf-8")
    refs = re.findall(r"`([^`]+)`", content)
    local_refs = [r for r in refs if r.startswith(("scripts/", "references/", "assets/"))]

    for ref in local_refs:
        target = skill_dir / ref
        if not target.exists():
            errors.append(f"Cross-reference '{ref}' points to non-existent file")
    return errors


# ── main ────────────────────────────────────────────────────────────────────

CHECKS = [
    ("Directory exists", check_directory_exists),
    ("SKILL.md exists", check_skillmd_exists),
    ("Frontmatter: name + description", check_frontmatter),
    ("SKILL.md length ≤ 500 lines", check_skillmd_length),
    ("No human docs (README, CHANGELOG, etc.)", check_no_human_docs),
    ("No behavioural content in assets", check_no_behavioural_in_assets),
    ("Scripts produce output", check_scripts_produce_output),
    ("No nested subdirectories", check_subdirs_one_level_deep),
    ("No empty subdirectories", check_no_empty_subdirs),
    ("Gotchas section present", check_gotchas_section),
    ("Cross-references valid", check_cross_references),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate an agent skill directory")
    parser.add_argument("path", help="Path to skill directory")
    args = parser.parse_args()

    skill_dir = Path(args.path).resolve()
    all_errors: list[str] = []
    results: list[tuple[str, str]] = []

    for name, check_fn in CHECKS:
        try:
            errors = check_fn(skill_dir)
        except Exception as e:
            errors = [f"Check raised exception: {e}"]

        if errors:
            all_errors.extend(errors)
            results.append((name, "FAIL"))
        else:
            results.append((name, "PASS"))

    max_name_len = max(len(n) for n, _ in CHECKS)
    report_width = max_name_len + 10

    print(f"Validation report for: {skill_dir}")
    print(f"{'─' * report_width}")
    for name, status in results:
        icon = "✅" if status == "PASS" else "❌"
        print(f"  {icon} {name:<{max_name_len + 2}} {status}")

    if all_errors:
        print(f"\n{'─' * report_width}")
        print(f"❌ {len(all_errors)} error(s):\n")
        for err in all_errors:
            print(f"   • {err}")

    print(f"\n{'─' * report_width}")
    passes = sum(1 for _, s in results if s == "PASS")
    total = len(results)
    print(f"  {passes}/{total} checks passed")
    return 0 if passes == total else 1


if __name__ == "__main__":
    sys.exit(main())
