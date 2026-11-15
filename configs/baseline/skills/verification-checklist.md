---
name: verification-checklist
description: Final verification checklist (spec coverage, build, tests, accessibility, design). Use it before finishing the task.
---

Before finishing, check each item:

- Every "must" statement in the specification under /spec is implemented, including edge cases (empty states, errors, boundaries).
- The project builds from a clean state with its own build command, without type errors.
- The existing tests still pass, and the logic you added has tests of its own.
- The UI uses the exact accessible names, roles and texts the specification gives.
- The result matches any reference design images in /spec (layout, colours, spacing, typography).
- No stray files are left in the repository (scratch scripts, logs, screenshots).
