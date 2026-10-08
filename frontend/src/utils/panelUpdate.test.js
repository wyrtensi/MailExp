import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canCheck, installPrefix, isActiveResult, isRestartingError, isRolledBack, isTerminalState, logTail, migrationsInfo,
  needsAutoCheck, needsPolling, needsRunbook, requestErrorKey, rollbackCommand, rollbackInfo, safeGithubUrl,
  shouldOfferReload, stateInfo, updateBlockReason, updateStatus, updateTarget,
} from './panelUpdate.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const LATEST = { version: 'sha-bbbbbbbbbbbb', sha: 'b'.repeat(40), checkedAt: ago(1000) };
const base = (extra = {}) => ({
  current: { sha: 'a'.repeat(40), version: 'sha-aaaaaaaaaaaa' },
  latest: LATEST,
  compare: { status: 'ahead', aheadBy: 3, url: 'https://github.com/wyrtensi/MailExpert/compare/a...b' },
  updateAvailable: true, disabled: false, checkError: null,
  updater: { spool: true, installed: true, version: 'sha-aaaaaaaaaaaa' },
  busy: false, pending: null, check: null, run: null,
  links: {},
  ...extra,
});

describe('states', () => {
  it('knows which states are final', () => {
    for (const s of ['ready', 'blocked', 'refused', 'error', 'succeeded', 'failed', 'rolled_back', 'rollback_failed']) assert.equal(isTerminalState(s), true, s);
    for (const s of ['queued', 'checking', 'updating', 'rolling_back']) assert.equal(isTerminalState(s), false, s);
  });

  it('gives each state a key and a tone, and a fallback for an unknown one', () => {
    assert.deepEqual(stateInfo('succeeded'), { key: 'admin.panelUpdate.stateSucceeded', tone: 'good' });
    assert.equal(stateInfo('rollback_failed').tone, 'bad');
    assert.equal(stateInfo('rolled_back').tone, 'warn');
    assert.equal(stateInfo('from_the_future').key, 'admin.panelUpdate.stateUnknown');
  });
});

describe('updateStatus', () => {
  it('reads the headline from the answer', () => {
    assert.equal(updateStatus(null), 'unknown');
    assert.equal(updateStatus(base()), 'ahead');
    assert.equal(updateStatus(base({ updateAvailable: false, compare: { status: 'identical' } })), 'current');
    assert.equal(updateStatus(base({ updateAvailable: false, compare: { status: 'behind' } })), 'current');
    assert.equal(updateStatus(base({ updateAvailable: false, compare: { status: 'diverged' } })), 'diverged');
    assert.equal(updateStatus(base({ disabled: true })), 'disabled');
    assert.equal(updateStatus(base({ checkError: 'rate_limited', updateAvailable: false })), 'error');
    assert.equal(updateStatus(base({ latest: null, updateAvailable: false, compare: { status: null } })), 'unknown');
  });

  it('takes the same version for current when GitHub gave no comparison', () => {
    const same = base({ updateAvailable: false, compare: { status: null }, current: { sha: null, version: LATEST.version } });
    assert.equal(updateStatus(same), 'current');
  });
});

describe('target and checks', () => {
  it('takes only a well-formed promoted version as the target', () => {
    assert.equal(updateTarget(base()), 'sha-bbbbbbbbbbbb');
    assert.equal(updateTarget(base({ latest: { version: 'latest' } })), null);
    assert.equal(updateTarget(base({ latest: null })), null);
  });

  it('wants an automatic check only when an update is available, installable and not checked yet', () => {
    assert.equal(needsAutoCheck(base()), true);
    assert.equal(needsAutoCheck(base({ check: { state: 'ready' } })), false);
    assert.equal(needsAutoCheck(base({ updater: { installed: false } })), false);
    assert.equal(needsAutoCheck(base({ updateAvailable: false })), false);
    assert.equal(needsAutoCheck(base({ busy: true })), false);
    assert.equal(needsAutoCheck(base({ pending: { id: 'x', action: 'check' } })), false);
    assert.equal(needsAutoCheck(base({ disabled: true })), false);
    assert.equal(needsAutoCheck(base({ checkError: 'unavailable' })), false);
  });

  it('can check by hand when the update is possible and nothing runs', () => {
    assert.equal(canCheck(base()), true);
    assert.equal(canCheck(base(), { starting: true }), false);
    assert.equal(canCheck(base({ busy: true })), false);
    assert.equal(canCheck(base({ updater: { installed: false } })), false);
    assert.equal(canCheck(null), false);
  });
});

describe('updateBlockReason', () => {
  it('is null when the update may start', () => {
    assert.equal(updateBlockReason(base()), null);
    assert.equal(updateBlockReason(base({ check: { state: 'ready' } })), null);
  });

  it('says why the button is off', () => {
    assert.equal(updateBlockReason(null), 'loading');
    assert.equal(updateBlockReason(base(), { starting: true }), 'busy');
    assert.equal(updateBlockReason(base({ busy: true })), 'busy');
    assert.equal(updateBlockReason(base({ pending: { id: 'x', action: 'update' } })), 'busy');
    assert.equal(updateBlockReason(base({ updater: { installed: false } })), 'not_installed');
    assert.equal(updateBlockReason(base({ updateAvailable: false })), 'no_update');
    assert.equal(updateBlockReason(base({ check: { state: 'blocked' } })), 'blocked');
    assert.equal(updateBlockReason(base({ check: { state: 'refused' } })), 'blocked');
  });
});

describe('rolled back latest', () => {
  const rolled = (extra = {}) => base({ updater: { spool: true, installed: true, version: 'sha-aaaaaaaaaaaa', rolledBack: 'sha-bbbbbbbbbbbb' }, ...extra });

  it('is true only when the latest version is the rolled back one', () => {
    assert.equal(isRolledBack(rolled()), true);
    assert.equal(isRolledBack(base()), false);
    assert.equal(isRolledBack(base({ updater: { installed: true, rolledBack: 'sha-cccccccccccc' } })), false);
    assert.equal(isRolledBack(base({ updater: { installed: true, rolledBack: null }, latest: { version: null } })), false);
    assert.equal(isRolledBack(null), false);
  });

  it('blocks the update, the check and the automatic check', () => {
    assert.equal(updateBlockReason(rolled()), 'rolled_back');
    assert.equal(canCheck(rolled()), false);
    assert.equal(needsAutoCheck(rolled()), false);
  });

  it('names the rolled_back refusal', () => {
    assert.equal(requestErrorKey(new Error('rolled_back')), 'admin.panelUpdate.errorRolledBack');
    assert.equal(requestErrorKey(new Error('spool_not_writable')), 'admin.panelUpdate.errorSpoolNotWritable');
  });

  it('reads the code first and knows every refusal of the update routes', () => {
    const coded = (code) => Object.assign(new Error('Request failed'), { code });
    assert.equal(requestErrorKey(coded('invalid_target')), 'admin.panelUpdate.errorInvalidTarget');
    assert.equal(requestErrorKey(coded('confirm_mismatch')), 'admin.panelUpdate.errorConfirmMismatch');
    assert.equal(requestErrorKey(coded('not_found')), 'admin.panelUpdate.errorNotFound');
    assert.equal(requestErrorKey(coded('busy')), 'admin.panelUpdate.errorBusy');
    // An older backend put the token in `error` only.
    assert.equal(requestErrorKey(new Error('invalid_target')), 'admin.panelUpdate.errorInvalidTarget');
    assert.equal(requestErrorKey(coded('toString')), null);
    assert.equal(requestErrorKey(new Error('toString')), null);
  });
});

describe('migrations and rollback', () => {
  it('treats pendingMigrations null as unknown, present for the update', () => {
    assert.deepEqual(migrationsInfo(null), { kind: 'unknown', list: [] });
    assert.deepEqual(migrationsInfo({ pendingMigrations: null }), { kind: 'unknown', list: [] });
    assert.deepEqual(migrationsInfo({ pendingMigrations: [] }), { kind: 'none', list: [] });
    assert.deepEqual(migrationsInfo({ pendingMigrations: ['0042_x.sql'] }), { kind: 'pending', list: ['0042_x.sql'] });
  });

  it('allows an automatic rollback only with the schema read, nothing pending and the host agreeing', () => {
    assert.equal(rollbackInfo(null), 'unknown');
    assert.equal(rollbackInfo({ preflight: { pendingMigrations: [] }, autoRollback: true }), 'auto');
    assert.equal(rollbackInfo({ preflight: { pendingMigrations: [] }, autoRollback: false }), 'manual');
    assert.equal(rollbackInfo({ preflight: { pendingMigrations: ['m'] }, autoRollback: true }), 'manual');
    assert.equal(rollbackInfo({ preflight: { pendingMigrations: null }, autoRollback: true }), 'manual');
  });
});

describe('polling', () => {
  it('keeps polling while something runs, waits for the host or reports a live non-final state', () => {
    assert.equal(needsPolling(null, NOW), false);
    assert.equal(needsPolling(base(), NOW), false);
    assert.equal(needsPolling(base({ busy: true }), NOW), true);
    assert.equal(needsPolling(base({ pending: { id: 'x', action: 'check' } }), NOW), true);
    assert.equal(needsPolling(base({ run: { state: 'updating', terminal: false, updatedAt: ago(5000) } }), NOW), true);
    assert.equal(needsPolling(base({ run: { state: 'succeeded', terminal: true, updatedAt: ago(5000) } }), NOW), false);
    // The node's part after the panel's: followed while the agent's update job waits or runs.
    assert.equal(needsPolling(base({ node: { configured: true, job: { state: 'running' } } }), NOW), true);
    assert.equal(needsPolling(base({ node: { configured: true, job: { state: 'failed' } } }), NOW), false);
  });

  it('stops for a run the host abandoned (not touched for 30 minutes)', () => {
    const stale = { state: 'updating', terminal: false, updatedAt: ago(31 * 60 * 1000) };
    assert.equal(isActiveResult(stale, NOW), false);
    assert.equal(needsPolling(base({ run: stale }), NOW), false);
    assert.equal(isActiveResult({ state: 'queued', terminal: false }, NOW), true);
  });

  it('reads a gone backend as a restart, a real refusal as an error', () => {
    assert.equal(isRestartingError(Object.assign(new Error('x'), { status: 502 })), true);
    assert.equal(isRestartingError(Object.assign(new Error('x'), { status: 503 })), true);
    assert.equal(isRestartingError(Object.assign(new Error('x'), { status: 504 })), true);
    assert.equal(isRestartingError(new TypeError('Failed to fetch')), true);
    assert.equal(isRestartingError(Object.assign(new Error('Forbidden'), { status: 403 })), false);
    assert.equal(isRestartingError(Object.assign(new Error('x'), { status: 500 })), false);
    assert.equal(isRestartingError(null), false);
  });
});

describe('request errors', () => {
  it('names the refusals of the server', () => {
    assert.equal(requestErrorKey(new Error('busy')), 'admin.panelUpdate.errorBusy');
    assert.equal(requestErrorKey(new Error('not_latest')), 'admin.panelUpdate.errorNotLatest');
    assert.equal(requestErrorKey(new Error('no_update')), 'admin.panelUpdate.errorNoUpdate');
    assert.equal(requestErrorKey(new Error('updater_not_installed')), 'admin.panelUpdate.errorNotInstalled');
    assert.equal(requestErrorKey(new Error('Request failed')), null);
  });
});

describe('rollback command', () => {
  const run = { logFile: '/opt/mailexpert/state/updater/3f2c.log', from: 'sha-aaaaaaaaaaaa' };

  it('takes the install prefix from the log path', () => {
    assert.equal(installPrefix('/opt/mailexpert/state/updater/3f2c.log'), '/opt/mailexpert');
    assert.equal(installPrefix('/srv/mail express/state/updater/x.log'), null);
    assert.equal(installPrefix('/state/updater/x.log'), null);
    assert.equal(installPrefix('relative/state/updater/x.log'), null);
    assert.equal(installPrefix(null), null);
  });

  it('builds the manual rollback to the version the update started from', () => {
    assert.equal(rollbackCommand(run), 'sudo /opt/mailexpert/app/scripts/deploy/rollback.sh --to sha-aaaaaaaaaaaa');
    assert.equal(rollbackCommand({ ...run, from: null }), null);
    assert.equal(rollbackCommand({ ...run, from: 'sha-x; rm -rf /' }), null);
    assert.equal(rollbackCommand({ ...run, logFile: '$(evil)/state/updater/x.log' }), null);
    assert.equal(rollbackCommand(null), null);
  });

  it('points to the runbook only after a failed update', () => {
    assert.equal(needsRunbook({ state: 'failed' }), true);
    assert.equal(needsRunbook({ state: 'rollback_failed' }), true);
    assert.equal(needsRunbook({ state: 'rolled_back' }), false);
    assert.equal(needsRunbook({ state: 'succeeded' }), false);
    assert.equal(needsRunbook(null), false);
  });
});

describe('reload offer, log and links', () => {
  it('offers the reload for a recent success only', () => {
    assert.equal(shouldOfferReload({ state: 'succeeded', finishedAt: ago(60 * 1000) }, NOW), true);
    assert.equal(shouldOfferReload({ state: 'succeeded', finishedAt: ago(2 * 3600 * 1000) }, NOW), false);
    assert.equal(shouldOfferReload({ state: 'failed', finishedAt: ago(1000) }, NOW), false);
    assert.equal(shouldOfferReload(null, NOW), false);
  });

  it('keeps the last non-empty log lines', () => {
    assert.deepEqual(logTail(['a', '', '  ', 'b', 'c'], 2), ['b', 'c']);
    assert.deepEqual(logTail(null), []);
    assert.equal(logTail(Array.from({ length: 40 }, (_, i) => `l${i}`)).length, 25);
  });

  it('links only to https github.com', () => {
    assert.equal(safeGithubUrl('https://github.com/wyrtensi/MailExpert/compare/a...b'), 'https://github.com/wyrtensi/MailExpert/compare/a...b');
    assert.equal(safeGithubUrl('javascript:alert(1)'), null);
    assert.equal(safeGithubUrl('https://evil.example/x'), null);
    assert.equal(safeGithubUrl('http://github.com/x'), null);
    assert.equal(safeGithubUrl(null), null);
  });
});
