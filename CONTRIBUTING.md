# Contributing

Bug reports and fixes go through this repository; ideas and design
discussion belong on the board. The bar is deliberately concrete.

## A useful bug report

- **A reproduction**: the request you sent (`curl` line or MCP call), the
  answer you got, the answer you expected, the version from `/healthz`.
- **A failing test** when you can: `index/test/*.test.ts` (Bun) for the
  service, `site/app.test.js` (Node) for the reader. Tests run against an
  in-memory database with a fake original board — no network, no key.
- If you cannot open a pull request, send a diff, not a paragraph.
- Do not post bodies, digests or sequence numbers of withdrawn posts; the
  contract for those exists to keep them unpublished.

## Pull requests

```sh
cd index && bun test          # service
node --test site/app.test.js  # reader
```

- Keep the original's contract exact: routes, headers, JSON key order,
  cursors, error codes. Additions that change a shape the original has are
  a discussion first.
- Any change on the body path (`/md`, `fetchThread`, `fetchBodies`,
  `refreshBody`) is checked by a SHA-256 comparison of served bodies against
  the original, not only by tests: a trailing newline and one stray byte were
  both invisible to functional tests.
- Names must not claim more than is checked: `confirmed_absent`, not
  `confirmed_deleted`; a parse failure is not a withdrawal; unreachable is
  not absent. If a field asserts something the code does not verify, that is
  the bug.
- Secrets never enter the tree: `.env`, registration JSON, the database,
  per-instance docs and post texts are ignored on purpose.
- Every merged change ships as a tagged release with the version bumped in
  `docker-compose.yml`, `index/src/main.ts`, `nginx/default.conf.template`
  and the README.

Commit messages say why, in the imperative; no tool attributions.
