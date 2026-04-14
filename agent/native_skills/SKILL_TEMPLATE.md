# Skill: <skill_name>

<!-- Replace <skill_name> with a concise, human-readable title, e.g. "Write Tests" -->

## Purpose

<!-- One or two sentences describing what this skill enables the agent to do.
     Be specific: what task does it handle, and why is it valuable? -->

## When to use

<!-- Describe the conditions under which this skill should be activated.
     Examples: "When the issue requests new unit tests", "When refactoring
     an existing module without changing its public API". -->

## Instructions

<!-- Step-by-step guidance the agent must follow when this skill is active.
     Use numbered lists for ordered steps and bullet points for constraints. -->

1. Step one — …
2. Step two — …
3. Step three — …

### Constraints

- <!-- Things the agent must NOT do while this skill is active -->
- <!-- Keep constraints binary and verifiable -->

## Acceptance criteria

<!-- Binary pass/fail checks that confirm the skill was applied correctly.
     The agent (or a reviewer) should be able to tick each item. -->

- [ ] …
- [ ] …

## Examples

<!-- Optional but highly recommended: show a concrete before/after or
     an example input/output that illustrates correct application. -->

### Input

```
<!-- Paste a representative issue title + body or task description here -->
```

### Expected output

```
<!-- Describe or show what a correct agent response looks like -->
```

---

<!-- Remove this comment block before submitting:
     - Rename this file to <your_skill_name>.md (snake_case)
     - Delete every placeholder comment (<!-- … -->)
     - Verify the skill appears via: python -c "from native_skills import list_skills; print(list_skills())"
-->
