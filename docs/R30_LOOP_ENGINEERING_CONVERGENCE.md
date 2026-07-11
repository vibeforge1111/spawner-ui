# R30 Loop Engineering Convergence

This branch advances from the current default branch. It does not reset public team points, replay prior awards, or treat an installed tree as release authority.

## Authority boundaries

- A signed server or Telegram action may request an immediate schedule fire. The background timer cannot mint a human decision or replay stored authority.
- The Loop UI is inspect-first. It can stage private evidence, but a browser cannot mint Governor approval or execute a mutation.
- PRD trace repair adds explicit `missing_harness_authority` gap capsules when historical rows lack proof. It never upgrades a gap into positive evaluator evidence.
- The installed positive-proof seed script is intentionally not adopted. Owner-bound evaluator evidence must come from a real mission event, independent provider identities, and validated score packets.

## Trace maintenance

Both commands preview by default and avoid raw backups:

```sh
npm run trace:redact:prd -- --json
npm run trace:repair:prd-proof -- --json
```

Apply only after reviewing the preview:

```sh
npm run trace:redact:prd -- --apply
npm run trace:repair:prd-proof -- --apply
```

Use `--backup` with `--apply` only when an explicit mode-`0600` raw backup is required. Malformed JSONL is reported and left untouched.

## Release state

This convergence is local proof, not publication. A runtime smoke, visual QA, and user-confirmed live Spark/Telegram check are still required before any PR, push, merge, installer update, point append, or public release.
