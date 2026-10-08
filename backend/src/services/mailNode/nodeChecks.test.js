import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
const dns = vi.hoisted(() => ({ result: null, error: null }));
const alerts = vi.hoisted(() => ({ result: null, error: null }));
vi.mock('./dnsCheckJob.js', () => ({
  checkAllNow: vi.fn(async () => dns.result),
  lastCheckAllError: vi.fn(() => dns.error),
}));
vi.mock('./nodeAlerts.js', () => ({
  checkAlertsNow: vi.fn(async () => alerts.result),
  lastAlertCheckError: vi.fn(() => alerts.error),
}));
vi.mock('./outageActions.js', () => ({ traceOutagesNow: vi.fn(async () => ({})) }));
vi.mock('./mailcow.js', async (importActual) => ({ ...(await importActual()), getMailNodeConfig: vi.fn(async () => ({})) }));

const { runNodeCheck } = await import('./nodeChecks.js');

const job = (check) => ({ id: 7, kind: 'mail_node_check', created_by: null, payload: { check } });

// The failed check's job says why (jobs show, domain dns-check --wait), not only that it failed.
describe('a failed node check job', () => {
  beforeEach(() => {
    Object.assign(dns, { result: null, error: null });
    Object.assign(alerts, { result: null, error: null });
  });

  it('a DNS check names the reason the run failed with', async () => {
    dns.error = { code: 'mail_node_unreachable', message: 'The mail node did not answer' };
    await expect(runNodeCheck(job('dns'))).rejects.toMatchObject({
      code: 'dns_check_failed', jobOutcome: 'fail',
      message: 'The DNS check failed: mail_node_unreachable: The mail node did not answer',
    });
  });

  it('an alert check names the reason the run failed with', async () => {
    alerts.error = { code: null, message: 'getaddrinfo ENOTFOUND node.example' };
    await expect(runNodeCheck(job('alerts'))).rejects.toMatchObject({
      code: 'alert_check_failed', message: 'The alert check failed: getaddrinfo ENOTFOUND node.example',
    });
  });

  it('without a known reason it keeps the plain text', async () => {
    await expect(runNodeCheck(job('dns'))).rejects.toMatchObject({ message: 'The DNS check failed' });
  });

  it('a check that ran ends without an error', async () => {
    dns.result = { at: 'now' };
    await expect(runNodeCheck(job('dns'))).resolves.toBeUndefined();
  });
});
