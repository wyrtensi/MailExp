# Agent instructions

## Deploying and operating MailExpert

Installing, updating, checking or rolling back a MailExpert server goes through the scripts in
`scripts/deploy/` and follows the skill
[`.claude/skills/mailexpert-rollout/SKILL.md`](.claude/skills/mailexpert-rollout/SKILL.md). Agents
without skill support read that file as plain instructions.

- Start read-only: `scripts/deploy/status.sh [--target sha-<12>] --json` on the panel,
  `scripts/deploy/mail-node/setup.sh --dry-run` on the mail node.
- Show the human a written plan and wait for an explicit "yes" before any step that changes a
  server; ask again before each irreversible step (an update with new migrations, a database
  restore, a mailcow restart, a node restore).
- Never print or copy secret values (`.env` files, `node.env`, PFX and password files, the restic
  recovery key); secrets reach a server only through `configure.sh` on stdin or a `0600` file the
  human provides.
- Ask for host names, versions, admin emails and other inputs; never invent them. Docs and pull
  requests use placeholders (`<PANEL_HOST>`, `<APP_HOST>`, `<MAIL_HOST>`, `<PANEL_IP>`), never real
  hosts or addresses.
- Report what the commands printed (exit codes and post-check output), not that they ran.

The operator map is [docs/operations/README.md](docs/operations/README.md); modules, topologies and
version rules are in [docs/architecture/deployment-system.md](docs/architecture/deployment-system.md).
