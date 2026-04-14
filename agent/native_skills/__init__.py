"""
native_skills — reusable, composable agent capabilities.

Each skill is a single Markdown file (.md) in this directory.
The public API lets callers discover and load skills without knowing
the underlying file paths.

Usage::

    from native_skills import list_skills, load_skill

    for skill in list_skills():
        print(skill["name"])   # e.g. "write_tests"

    content = load_skill("write_tests")   # returns the Markdown text
"""

from pathlib import Path

_SKILLS_DIR = Path(__file__).parent

# Files that live in this directory but are not skills themselves.
_META_FILES = {"README.md", "SKILL_TEMPLATE.md"}


def list_skills() -> list[dict]:
    """Return metadata for every available skill, sorted alphabetically by name.

    Each entry is a dict with:
      - ``name``     (str) — the skill identifier (filename stem, no ``.md``)
      - ``filename`` (str) — the bare filename, e.g. ``write_tests.md``
      - ``path``     (str) — absolute path to the Markdown file
    """
    skills = []
    for path in sorted(_SKILLS_DIR.glob("*.md")):
        if path.name not in _META_FILES:
            skills.append(
                {
                    "name": path.stem,
                    "filename": path.name,
                    "path": str(path),
                }
            )
    return skills


def load_skill(name: str) -> str:
    """Return the Markdown content of a skill identified by *name* (the stem, without ``.md``).

    Raises:
        FileNotFoundError: if no skill with that name exists, or if *name*
            matches a reserved meta-file (``README``, ``SKILL_TEMPLATE``).
    """
    candidate = _SKILLS_DIR / f"{name}.md"
    if candidate.name in _META_FILES or not candidate.exists():
        raise FileNotFoundError(f"Skill {name!r} not found in {_SKILLS_DIR}")
    return candidate.read_text(encoding="utf-8")
