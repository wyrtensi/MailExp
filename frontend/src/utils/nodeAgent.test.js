import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeJob, agentConnection, agentSetupCommands, backupSummary, latestJob, panelUrl, shortCommit,
} from './nodeAgent.js';

describe('agentSetupCommands', () => {
  it('saves the token to a 0600 file, never on the command line, and names the panel the admin has open', () => {
    const [save, setup, cleanup] = agentSetupCommands('https://panel.example.com/');
    assert.equal(save, "sudo sh -c 'umask 077 && cat > /root/mailexpert-agent-token'");
    assert.equal(setup, 'sudo scripts/deploy/mail-node/setup.sh --panel-url https://panel.example.com --agent-token-file /root/mailexpert-agent-token');
    assert.equal(cleanup, 'sudo rm /root/mailexpert-agent-token');
  });

  it('falls back to a placeholder for an origin that is not a plain URL', () => {
    assert.equal(panelUrl('about:blank'), 'https://<PANEL_HOST>');
    assert.equal(panelUrl(undefined), 'https://<PANEL_HOST>');
    assert.equal(panelUrl('https://panel.example.com:8443'), 'https://panel.example.com:8443');
  });
});

describe('agentConnection', () => {
  it('tells apart no token, a token without the agent, and a connected agent', () => {
    assert.equal(agentConnection(null), 'not_set_up');
    assert.equal(agentConnection({ configured: false, connected: false }), 'not_set_up');
    assert.equal(agentConnection({ configured: true, connected: false }), 'waiting');
    assert.equal(agentConnection({ configured: true, connected: true }), 'connected');
  });
});

describe('jobs', () => {
  const jobs = [
    { id: '3', kind: 'status', state: 'running' },
    { id: '2', kind: 'backup', state: 'failed' },
    { id: '1', kind: 'backup', state: 'succeeded' },
  ];
  it('finds the active job of a kind and the newest one', () => {
    assert.equal(activeJob(jobs, 'backup'), null);
    assert.equal(activeJob(jobs, 'status').id, '3');
    assert.equal(activeJob([{ id: '4', kind: 'backup', state: 'queued' }, ...jobs], 'backup').id, '4');
    assert.equal(latestJob(jobs, 'backup').id, '2');
    assert.equal(latestJob(undefined, 'backup'), null);
  });
});

describe('backupSummary', () => {
  const last = { finishedAt: '2026-10-05T02:41:00.000Z', processedBytes: 1024 };
  it('reads the node backup out of the status report', () => {
    assert.equal(backupSummary(null), null);
    assert.equal(backupSummary({ backup: { configured: false, ok: false, problem: null, last: null } }).state, 'off');
    assert.equal(backupSummary({ backup: { configured: true, ok: true, problem: null, last: null } }).state, 'none');
    assert.deepEqual(backupSummary({ backup: { configured: true, ok: true, problem: null, last } }), { state: 'ok', last, problem: null });
    assert.deepEqual(backupSummary({ backup: { configured: true, ok: false, problem: 'too old', last } }), { state: 'old', last, problem: 'too old' });
  });
});

describe('shortCommit', () => {
  it('shortens a full commit and keeps anything else', () => {
    assert.equal(shortCommit('0123456789abcdef0123456789abcdef01234567'), '0123456789ab');
    assert.equal(shortCommit('unknown'), 'unknown');
    assert.equal(shortCommit(null), null);
  });
});
