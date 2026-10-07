import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeJob, agentConnection, agentSetupCommands, backupSummary, latestJob, MAILCOW_STATE_KEYS, mailcowName, mailcowState,
  nodeBusyJob, nodeUpdateActive, nodeUpdatePart, panelUrl, scriptsState, shortCommit,
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

describe('mailcowState', () => {
  const OLD = 'ca07d8d3331849ae294179aedce95c8126d3050f';
  const PIN = '81f6f7b002f2681b732aed74ae53179377def5e0';
  const NEWER = '0123456789abcdef0123456789abcdef01234567';
  const pinned = { tag: '2026-09a', commit: PIN };
  const status = (fields) => ({ mailcowPinCommit: PIN, mailcowUpstreamCommit: PIN, ...fields });

  it('matches when the node runs the version this release pins', () => {
    assert.equal(mailcowState(status({ mailcowCommit: PIN, mailcowRelation: 'match' }), pinned), 'matches');
    // Whatever the node compares it with: the panel's pin decides.
    assert.equal(mailcowState(status({ mailcowCommit: PIN, mailcowRelation: 'newer' }), pinned), 'matches');
  });

  it('waits for the next node update while mailcow is behind the pin', () => {
    assert.equal(mailcowState(status({ mailcowCommit: OLD, mailcowRelation: 'behind' }), pinned), 'pending');
    // The node's scripts pin an older version it already runs: their update brings the new pin.
    assert.equal(mailcowState(status({ mailcowCommit: OLD, mailcowRelation: 'match', mailcowPinCommit: OLD }), pinned), 'pending');
  });

  it('warns about a mailcow newer than the pin or off its history', () => {
    assert.equal(mailcowState(status({ mailcowCommit: NEWER, mailcowRelation: 'newer' }), pinned), 'untested');
    assert.equal(mailcowState(status({ mailcowCommit: NEWER, mailcowRelation: 'diverged' }), pinned), 'untested');
  });

  it('tells a newer mailcow release apart: the node waits for a MailExpert release', () => {
    assert.equal(mailcowState(status({ mailcowCommit: OLD, mailcowRelation: 'behind', mailcowUpstreamCommit: NEWER }), pinned), 'waitingRelease');
    // The node's own pin is older than the panel's: its next update brings the panel's pin first.
    assert.equal(
      mailcowState(status({ mailcowCommit: OLD, mailcowRelation: 'behind', mailcowPinCommit: OLD, mailcowUpstreamCommit: NEWER }), pinned),
      'pending',
    );
  });

  it('is unknown without a report or a commit', () => {
    assert.equal(mailcowState(null, pinned), 'unknown');
    assert.equal(mailcowState(status({ mailcowCommit: null, mailcowRelation: 'unknown' }), pinned), 'unknown');
    assert.equal(mailcowState(status({ mailcowCommit: OLD, mailcowRelation: 'unknown' }), pinned), 'unknown');
    for (const state of ['unknown', 'matches', 'pending', 'untested', 'waitingRelease']) assert.ok(MAILCOW_STATE_KEYS[state]);
  });

  it('names a version by its tag, or its short commit', () => {
    assert.equal(mailcowName('2026-09a', PIN), '2026-09a');
    assert.equal(mailcowName(null, PIN), PIN.slice(0, 12));
    assert.equal(mailcowName(null, null), null);
  });
});

describe('shortCommit', () => {
  it('shortens a full commit and keeps anything else', () => {
    assert.equal(shortCommit('0123456789abcdef0123456789abcdef01234567'), '0123456789ab');
    assert.equal(shortCommit('unknown'), 'unknown');
    assert.equal(shortCommit(null), null);
  });
});

describe('the node update', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);

  it('compares the node scripts with the panel commit', () => {
    assert.equal(scriptsState(A, A), 'current');
    assert.equal(scriptsState(A, B), 'behind');
    assert.equal(scriptsState('unknown', B), 'unknown');
    assert.equal(scriptsState(A, null), 'unknown');
    // The node refused the panel's commit as older than its own.
    const refused = { state: 'failed', error: 'not_newer', params: { sha: B } };
    assert.equal(scriptsState(A, B, refused), 'newer');
    assert.equal(scriptsState(A, B, { ...refused, params: { sha: A } }), 'behind');
    assert.equal(scriptsState(A, B, { ...refused, error: 'rolled_back' }), 'behind');
  });

  it('takes a backup or an update as the one job that runs', () => {
    const update = { kind: 'update', state: 'running' };
    const backup = { kind: 'backup', state: 'queued' };
    assert.equal(nodeBusyJob([backup]), backup);
    assert.equal(nodeBusyJob([{ kind: 'status', state: 'running' }, update]), update);
    assert.equal(nodeBusyJob([{ kind: 'update', state: 'failed' }]), null);
  });

  it('gives the node part of a panel update: none without an agent, the job, or the commits', () => {
    assert.equal(nodeUpdatePart(null), null);
    assert.equal(nodeUpdatePart({ configured: false }), null);
    const job = { state: 'failed', step: 'setup.sh failed', error: 'rolled_back', params: { sha: B }, finishedAt: '2026-10-07T10:00:00Z' };
    assert.deepEqual(nodeUpdatePart({ configured: true, job, scriptsCommit: A, panelCommit: B }), {
      state: 'failed', step: 'setup.sh failed', error: 'rolled_back', at: '2026-10-07T10:00:00Z', target: B,
    });
    assert.equal(nodeUpdatePart({ configured: true, job: null, scriptsCommit: A, panelCommit: A }).state, 'current');
    assert.equal(nodeUpdatePart({ configured: true, job: null, scriptsCommit: A, panelCommit: B }).state, 'behind');
    // A job to an earlier commit is not this update: the commits tell.
    const earlier = { state: 'succeeded', params: { sha: A }, finishedAt: '2026-10-01T10:00:00Z' };
    assert.equal(nodeUpdatePart({ configured: true, job: earlier, scriptsCommit: A, panelCommit: B }).state, 'behind');
    assert.equal(nodeUpdatePart({ configured: true, job: earlier, scriptsCommit: B, panelCommit: B }).state, 'current');
    assert.equal(nodeUpdateActive({ job: { state: 'queued' } }), true);
    assert.equal(nodeUpdateActive({ job: { state: 'succeeded' } }), false);
    assert.equal(nodeUpdateActive(null), false);
  });
});
