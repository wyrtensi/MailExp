import { beforeEach, describe, expect, it, vi } from 'vitest';

// The panel CLI's command line, help, output and exit codes, with the actions it calls mocked
// (what they do is covered against PGlite in mailexpert.*.pglite.test.js).

const actions = vi.hoisted(() => ({
  resolveCliActor: vi.fn(),
  adminDomainList: vi.fn(),
  restartDomain: vi.fn(),
  createNodeMailbox: vi.fn(),
  listNodeMailboxes: vi.fn(),
  findNodeMailbox: vi.fn(),
  requestMailboxDeletion: vi.fn(),
  syncDomainNow: vi.fn(),
  getTenantJob: vi.fn(),
  setPhishRelease: vi.fn(),
  listAliases: vi.fn(async () => []),
}));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn(), pool: { end: vi.fn(async () => {}) } }));
vi.mock('../services/actor.js', () => ({ resolveCliActor: actions.resolveCliActor }));
vi.mock('../services/accountAliases.js', async (importActual) => ({ ...(await importActual()), listAliases: actions.listAliases }));
vi.mock('../services/mailNode/domainActions.js', () => ({ adminDomainList: actions.adminDomainList, restartDomain: actions.restartDomain }));
vi.mock('../services/mailNode/mailboxActions.js', async (importActual) => ({
  ...(await importActual()),
  createNodeMailbox: actions.createNodeMailbox,
  listNodeMailboxes: actions.listNodeMailboxes,
  findNodeMailbox: actions.findNodeMailbox,
  requestMailboxDeletion: actions.requestMailboxDeletion,
}));
vi.mock('../services/tenant/tenantActions.js', async (importActual) => ({
  ...(await importActual()),
  syncDomainNow: actions.syncDomainNow,
  getTenantJob: actions.getTenantJob,
  setPhishRelease: actions.setPhishRelease,
}));

const { run, GROUPS } = await import('./mailexpert.js');
const { MailNodeError } = await import('../services/mailNode/mailcow.js');

const CLI_ACTOR = { userId: null, via: 'cli' };

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

// Runs the CLI with captured streams; answers { code, out, err }.
async function cli(argv, { interactive = false, answers = [] } = {}) {
  const stdout = sink();
  const stderr = sink();
  const asked = [];
  const code = await run(argv, {
    stdout, stderr, interactive,
    ask: vi.fn(async (question) => { asked.push(question); return answers.shift() ?? ''; }),
    sleep: async () => {}, now: () => clock.now, pollMs: 0,
  });
  return { code, out: stdout.text, err: stderr.text, asked };
}
const clock = { now: 0 };

const DOMAIN = {
  domain: 'example.com', onNode: true, active: true, state: 'dns_ok', nextStep: 'tenant_verified', steps: {},
  mailboxes: 2, maxMailboxes: 500, holdInternalRelay: true, tenantSync: null,
};
const ACCOUNT = { id: '11111111-1111-4111-8111-111111111111', email_address: 'anna@example.com', name: 'Anna', sender_name: 'Анна' };

beforeEach(() => {
  vi.clearAllMocks();
  clock.now = 0;
  actions.resolveCliActor.mockResolvedValue({ actor: CLI_ACTOR });
  actions.adminDomainList.mockResolvedValue({ domains: [DOMAIN], tenantDriverActive: true });
  actions.restartDomain.mockResolvedValue({ ok: true, domain: 'example.com', state: 'node_created' });
  actions.findNodeMailbox.mockResolvedValue({ account: ACCOUNT });
  actions.requestMailboxDeletion.mockResolvedValue({ account: { ...ACCOUNT, delete_after: '2026-10-09T10:00:00Z' } });
  actions.listAliases.mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('help and usage', () => {
  it('prints the groups on --help (exit 0) and on no arguments (exit 2, on stderr)', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    for (const group of GROUPS) expect(help.out).toContain(group.name);
    const none = await cli([]);
    expect(none.code).toBe(2);
    expect(none.err).toContain('Usage: mailexpert <group> <command>');
  });

  it('answers --help for every group and every command with exit 0', async () => {
    for (const group of GROUPS) {
      const groupHelp = await cli([group.name, '--help']);
      expect(groupHelp.code).toBe(0);
      for (const command of group.commands) {
        expect(groupHelp.out).toContain(command.name);
        const help = await cli([group.name, command.name, '--help']);
        expect(help.code, `${group.name} ${command.name}`).toBe(0);
        expect(help.out).toContain(`Usage: mailexpert ${group.name} ${command.name}`);
        expect(help.out).toContain('--json');
      }
    }
  });

  it('exits 2 on an unknown group, command or option and a missing argument, without acting', async () => {
    expect((await cli(['bogus'])).code).toBe(2);
    expect((await cli(['domain'])).code).toBe(2);
    expect((await cli(['domain', 'bogus'])).code).toBe(2);
    const flag = await cli(['domain', 'restart', 'example.com', '--bogus']);
    expect(flag.code).toBe(2);
    expect(flag.err).toContain('unknown option: --bogus');
    const missing = await cli(['domain', 'restart']);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('missing <domain>');
    expect(actions.restartDomain).not.toHaveBeenCalled();
  });

  it('exits 2 on an argument the command checks itself', async () => {
    expect((await cli(['domain', 'show', 'not a domain'])).code).toBe(2);
    expect((await cli(['mailbox', 'create', 'no-at-sign'])).code).toBe(2);
    expect((await cli(['jobs', 'list', '--status', 'bogus'])).code).toBe(2);
    expect((await cli(['jobs', 'list', '--limit', '0'])).code).toBe(2);
    expect((await cli(['mailbox', 'set-names', 'anna@example.com'])).code).toBe(2);
  });
});

describe('journal help', () => {
  it('says what each changing command journals, and that names are not journaled', async () => {
    expect((await cli(['mailbox', 'create', '--help'])).out).toContain('Journal: mailbox.added');
    expect((await cli(['mailbox', 'set-names', '--help'])).out).toContain('Journal: none');
    expect((await cli(['domain', 'list', '--help'])).out).not.toContain('Journal:');
  });
});

describe('output', () => {
  it('takes --json from the parsed flags, not from a flag\'s value', async () => {
    const result = await cli(['mailbox', 'delete', 'anna@example.com', '--reason', '--json', '--confirm-address', 'anna@example.com']);
    expect(result.code).toBe(0);
    expect(actions.requestMailboxDeletion).toHaveBeenCalledWith(
      { accountId: ACCOUNT.id, email: 'anna@example.com', reason: '--json' }, CLI_ACTOR,
    );
    expect(result.out).toContain('deletion of anna@example.com asked for');
    expect(() => JSON.parse(result.out)).toThrow();
  });

  it('prints a table for people and the action\'s answer with --json', async () => {
    const human = await cli(['domain', 'list']);
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/DOMAIN\s+STATE/);
    expect(human.out).toMatch(/example\.com\s+dns_ok/);
    const json = await cli(['domain', 'list', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual({ domains: [DOMAIN], tenantDriverActive: true });
  });

  it('shows one domain with its warnings', async () => {
    actions.adminDomainList.mockResolvedValue({
      domains: [{ ...DOMAIN, recreated: true, created: '2026-10-01 10:00:00', nodeCreated: '2026-09-01 10:00:00',
        tenantSync: { at: '2026-10-04T10:00:00Z', ok: false, graph: { ok: false, error: { code: 'tenant_throttled', message: 'slow down' } },
          mirror: { ok: true, heldAliasContacts: ['info@example.com'] } } }],
      tenantDriverActive: true,
    });
    const shown = await cli(['domain', 'show', 'Example.com']);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('another creation time');
    expect(shown.out).toContain('tenant graph: tenant_throttled');
    expect(shown.out).toContain('approve-alias-removal');
    const json = JSON.parse((await cli(['domain', 'show', 'example.com', '--json'])).out);
    expect(json.warnings).toHaveLength(3);
  });
});

describe('errors and exit codes', () => {
  it('prints the API\'s code and message for a refusal and exits 1', async () => {
    actions.restartDomain.mockResolvedValue({ error: 'domain_nothing_to_restart' });
    const human = await cli(['domain', 'restart', 'example.com', '--yes']);
    expect(human.code).toBe(1);
    expect(human.err).toContain('error: The domain is at the first step with nothing to clear (domain_nothing_to_restart)');
    const json = await cli(['domain', 'restart', 'example.com', '--yes', '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toEqual({ error: 'The domain is at the first step with nothing to clear', code: 'domain_nothing_to_restart' });
  });

  it('exits 3 when the refusal is a failure (5xx) or the mail node fails', async () => {
    actions.createNodeMailbox.mockResolvedValueOnce({ error: 'mailbox_create_failed' });
    expect((await cli(['mailbox', 'create', 'new@example.com'])).code).toBe(3);
    actions.createNodeMailbox.mockRejectedValueOnce(new MailNodeError('mail_node_unreachable', 'The mail node is unreachable (ECONNREFUSED)'));
    const node = await cli(['mailbox', 'create', 'new@example.com', '--json']);
    expect(node.code).toBe(3);
    expect(JSON.parse(node.out)).toEqual({ error: 'The mail node is unreachable (ECONNREFUSED)', code: 'mail_node_unreachable' });
  });

  it('exits 3 with internal_error on anything unexpected', async () => {
    actions.adminDomainList.mockRejectedValue(new Error('boom'));
    const result = await cli(['domain', 'list']);
    expect(result.code).toBe(3);
    expect(result.err).toContain('(internal_error)');
  });

  it('refuses --as for anyone but an enabled administrator before acting', async () => {
    actions.resolveCliActor.mockResolvedValue({ error: 'admin_not_found' });
    const result = await cli(['domain', 'restart', 'example.com', '--yes', '--as', 'someone@example.com']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('(admin_not_found)');
    expect(actions.resolveCliActor).toHaveBeenCalledWith('someone@example.com');
    expect(actions.restartDomain).not.toHaveBeenCalled();
  });

  it('passes the --as administrator to the action', async () => {
    const admin = { userId: 'admin-1', via: 'cli' };
    actions.resolveCliActor.mockResolvedValue({ actor: admin });
    await cli(['domain', 'restart', 'example.com', '--yes', '--as', 'admin@example.com']);
    expect(actions.restartDomain).toHaveBeenCalledWith('example.com', admin);
  });
});

describe('confirmation', () => {
  it('refuses an irreversible action without a terminal and without --yes (exit 2), never waiting', async () => {
    const result = await cli(['domain', 'restart', 'example.com']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('(confirmation_required)');
    expect(result.asked).toEqual([]);
    expect(actions.restartDomain).not.toHaveBeenCalled();
  });

  it('acts with --yes, or after "y" at the prompt; "n" cancels with exit 1', async () => {
    expect((await cli(['domain', 'restart', 'example.com', '-y'])).code).toBe(0);
    expect(actions.restartDomain).toHaveBeenCalledTimes(1);
    const yes = await cli(['domain', 'restart', 'example.com'], { interactive: true, answers: ['y'] });
    expect(yes.code).toBe(0);
    expect(yes.asked[0]).toContain('Restart the onboarding of example.com');
    expect(actions.restartDomain).toHaveBeenCalledTimes(2);
    const no = await cli(['domain', 'restart', 'example.com'], { interactive: true, answers: ['n'] });
    expect(no.code).toBe(1);
    expect(no.err).toContain('(cancelled)');
    expect(actions.restartDomain).toHaveBeenCalledTimes(2);
  });

  it('never prompts with --json, even in a terminal', async () => {
    const result = await cli(['domain', 'restart', 'example.com', '--json'], { interactive: true, answers: ['y'] });
    expect(result.code).toBe(2);
    expect(result.asked).toEqual([]);
  });

  it('mailbox delete needs a reason and the typed address; --yes does not replace the address', async () => {
    expect((await cli(['mailbox', 'delete', 'anna@example.com', '--yes'])).code).toBe(2);
    const noAddress = await cli(['mailbox', 'delete', 'anna@example.com', '--reason', 'left', '--yes']);
    expect(noAddress.code).toBe(2);
    expect(noAddress.err).toContain('--confirm-address');
    expect(actions.requestMailboxDeletion).not.toHaveBeenCalled();

    const typed = await cli(['mailbox', 'delete', 'anna@example.com', '--reason', 'left'], { interactive: true, answers: ['anna@example.com'] });
    expect(typed.code).toBe(0);
    expect(typed.asked[0]).toContain('Type its full address');
    expect(actions.requestMailboxDeletion).toHaveBeenCalledWith(
      { accountId: ACCOUNT.id, email: 'anna@example.com', reason: 'left' }, CLI_ACTOR,
    );
    await cli(['mailbox', 'delete', ACCOUNT.id, '--reason', 'left', '--confirm-address', 'ANNA@example.com']);
    expect(actions.requestMailboxDeletion).toHaveBeenLastCalledWith(
      { accountId: ACCOUNT.id, email: 'ANNA@example.com', reason: 'left' }, CLI_ACTOR,
    );
  });

  it('pausing the release asks; resuming does not', async () => {
    actions.setPhishRelease.mockResolvedValue({ enabled: true, changedAt: '2026-10-04T10:00:00Z' });
    expect((await cli(['quarantine', 'pause'])).code).toBe(2);
    expect((await cli(['quarantine', 'resume'])).code).toBe(0);
    expect(actions.setPhishRelease).toHaveBeenCalledWith(true, CLI_ACTOR);
  });
});

describe('--wait', () => {
  const queued = { id: '7', kind: 'tenant_domain_sync', status: 'queued', errorCode: null, error: null };

  it('answers at once without --wait', async () => {
    actions.syncDomainNow.mockResolvedValue({ job: queued, created: true });
    const result = await cli(['domain', 'sync', 'example.com']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('job 7 (tenant_domain_sync) queued');
    expect(actions.getTenantJob).not.toHaveBeenCalled();
  });

  it('follows the job until it is done (exit 0) or failed (exit 3 with its code)', async () => {
    actions.syncDomainNow.mockResolvedValue({ job: queued, created: true });
    actions.getTenantJob
      .mockResolvedValueOnce({ job: { ...queued, status: 'running' } })
      .mockResolvedValueOnce({ job: { ...queued, status: 'done' } });
    const done = await cli(['domain', 'sync', 'example.com', '--wait', '--json']);
    expect(done.code).toBe(0);
    expect(JSON.parse(done.out).job.status).toBe('done');

    actions.getTenantJob.mockResolvedValueOnce({ job: { ...queued, status: 'failed', errorCode: 'tenant_not_configured', error: 'The tenant is not configured' } });
    const failed = await cli(['domain', 'sync', 'example.com', '--wait']);
    expect(failed.code).toBe(3);
    expect(failed.err).toContain('(tenant_not_configured)');
  });

  it('gives up after --timeout seconds with exit 3', async () => {
    actions.syncDomainNow.mockResolvedValue({ job: queued, created: true });
    actions.getTenantJob.mockImplementation(async () => { clock.now += 1000; return { job: queued }; });
    const result = await cli(['domain', 'sync', 'example.com', '--wait', '--timeout', '3']);
    expect(result.code).toBe(3);
    expect(result.err).toContain('(wait_timeout)');
  });
});
