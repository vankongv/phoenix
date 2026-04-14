# native_skills

Reusable, composable capabilities that agents can discover and attach at
runtime. Each skill is a self-contained Markdown file that describes **what**
the agent should do and **how** it should behave when the skill is active.

---

## Directory layout

```
agent/native_skills/
├── __init__.py          ← public API (list_skills, load_skill)
├── README.md            ← this file
├── SKILL_TEMPLATE.md    ← copy this to create a new skill
└── <skill_name>.md      ← one file per skill
```

The directory is intentionally **flat**: every skill lives directly here with
no sub-folders. Extensibility (namespacing, versioning, etc.) can be added
later without breaking the existing public API.

---

## Conventions

| Rule | Detail |
|------|--------|
| **One file per skill** | Each `.md` file is exactly one skill. |
| **Filename = skill name** | The file stem (without `.md`) is the identifier used in `load_skill()`. Use `snake_case`. |
| **Reserved filenames** | `README.md` and `SKILL_TEMPLATE.md` are excluded from enumeration; do not use these stems for real skills. |
| **Self-contained** | A skill file must be meaningful on its own — no imports, no external references. |
| **Markdown only** | No JSON, YAML, or other schema formats are required at this stage. |

---

## Public API

```python
from native_skills import list_skills, load_skill

# Discover all skills
for skill in list_skills():
    print(skill["name"])      # "write_tests"
    print(skill["filename"])  # "write_tests.md"
    print(skill["path"])      # "/absolute/path/to/write_tests.md"

# Load a skill's Markdown content
content = load_skill("write_tests")
```

`list_skills()` returns skills sorted alphabetically. `load_skill(name)` raises
`FileNotFoundError` for unknown or reserved names.

---

## Adding a new skill

1. Copy `SKILL_TEMPLATE.md` to `<your_skill_name>.md` in this directory.
2. Fill in every section of the template (purpose, instructions, examples).
3. Verify it appears in `list_skills()`:

   ```python
   python -c "from native_skills import list_skills; print(list_skills())"
   ```

4. Open a PR — no other files need to be changed.

---

## Coexistence with existing tooling

Native skills **do not replace** the OpenHands SDK tools (`FileEditorTool`,
`TerminalTool`, MCP servers, etc.) registered in `agent.py`. They are
supplementary textual capabilities — think of them as reusable prompt
fragments that shape agent behaviour for a specific task type, loaded
alongside the standard tool set.
