# Contributing to MailExpert

MailExpert is developed by its maintainer as a fork of [MailFlow](https://github.com/maathimself/mailflow).
Terms for external contributions are not defined yet, so pull requests from outside the
project are not accepted for now. Bug reports and feature requests are welcome in the
[issue tracker](https://github.com/wyrtensi/MailExpert/issues).

The rest of this document describes how changes are made inside the project.

## Workflow

1. Create a branch from `main`: `feat/…`, `fix/…`, `refactor/…`, `docs/…`, `chore/…`, or `sync/upstream-YYYY-MM-DD` for upstream ports.
2. Keep one fix or feature per branch; no unrelated cleanup in the same pull request.
3. Open a pull request against `main`. It is merged only when CI is green.
4. A release is its own pull request `chore(release): x.y.z` that only bumps the version with
   `scripts/ci/release-version.sh bump`; the owner promotes it, which creates the tag `v<x.y.z>`
   and the GitHub release (see "Versions and releases" in [AGENTS.md](AGENTS.md)).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `fix: …`, `feat: …`,
`refactor: …`, `docs: …`, `chore: …`, `test: …`. Imperative mood, subject under 72
characters, no trailing period. Explain the reason for the change in the body when it
is not obvious.

## Code rules

- Match the style of the surrounding code.
- Frontend styling uses the hand-written classes in `frontend/src/index.css` and inline style objects. Tailwind is installed, but components do not use its utility classes; do not introduce them into a component that has none.
- Code comments are written in English, and only when the reason behind the code would surprise a reader.
- Write the failing test first, then the implementation.
- Do not weaken, skip or delete existing tests to make a change pass.
- No monkey-patching of dependencies, `patch-package` or shims around library internals; adapt MailExpert code instead.
- OAuth codes, access and refresh tokens, client secrets and mail passwords must never reach logs, URLs, API responses or error messages.
- Keep TLS verification enabled.
- Do not add dependencies without a clear need; never use `npm audit fix --force`.

## Checks before a pull request

Runtime: Node.js 24+ (see `backend/package.json`), PostgreSQL 16+, Redis 7+.

```bash
cd backend
npm ci
npm test
npm run lint
npm run lint:plugins

cd ../frontend
npm ci
npm test
npm run lint
npm run build
```

CI runs the same steps on Node.js 24 together with `npm audit --omit=dev --audit-level=high`.

## Porting changes from upstream MailFlow

- Fetch upstream without its tags (`git config remote.upstream.tagOpt --no-tags`): MailFlow's `v*` tags collide with MailExpert's release tags.
- Cherry-pick with `git cherry-pick -x` so the original author and upstream commit stay recorded.
- Resolve conflicts in favour of MailExpert names: containers, storage keys, `mailexpert:` window events.
- Do not port changes MailExpert already implements differently (for example Google OAuth); record the decision in [docs/architecture/upstream-pr-assessment.md](docs/architecture/upstream-pr-assessment.md).
- Run the full checks after the port.

## Reporting security issues

Do not open a public issue for a vulnerability. Contact the maintainer privately through
the GitHub profile of the repository owner.
