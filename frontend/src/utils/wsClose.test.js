import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WS_CLOSE_ACTIONS, wsCloseAction } from './wsClose.js';

describe('wsCloseAction', () => {
  it('shows the lock screen at once when the server closes a locked session', () => {
    assert.equal(wsCloseAction({ code: 1008, reason: 'Locked' }), WS_CLOSE_ACTIONS.LOCKED);
  });

  it('does not reconnect a session that ended or was never authorized', () => {
    assert.equal(wsCloseAction({ code: 1008, reason: 'Session ended' }), WS_CLOSE_ACTIONS.SIGNED_OUT);
    assert.equal(wsCloseAction({ code: 1008, reason: 'Unauthorized' }), WS_CLOSE_ACTIONS.SIGNED_OUT);
  });

  it('stops on the auth close codes', () => {
    assert.equal(wsCloseAction({ code: 4001, reason: '' }), WS_CLOSE_ACTIONS.STOP);
    assert.equal(wsCloseAction({ code: 4003, reason: '' }), WS_CLOSE_ACTIONS.STOP);
  });

  it('reconnects after anything else, including a refused origin and a store outage', () => {
    assert.equal(wsCloseAction({ code: 1006, reason: '' }), WS_CLOSE_ACTIONS.RECONNECT);
    assert.equal(wsCloseAction({ code: 1011, reason: 'Session unavailable' }), WS_CLOSE_ACTIONS.RECONNECT);
    assert.equal(wsCloseAction({ code: 1008, reason: 'Forbidden' }), WS_CLOSE_ACTIONS.RECONNECT);
    assert.equal(wsCloseAction(undefined), WS_CLOSE_ACTIONS.RECONNECT);
  });
});
