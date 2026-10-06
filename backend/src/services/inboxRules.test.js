import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(),
  isAllMailFolder: vi.fn(),
  resolveTrashFolder: vi.fn(),
  resolveAllTrashPaths: vi.fn(),
  getDeleteStrategy: vi.fn(),
  adjustFolderCounts: vi.fn(),
}));
vi.mock('./ruleForwarder.js', () => ({ forwardRuleMessage: vi.fn() }));

const { query } = await import('./db.js');
const {
  resolveArchiveFolder,
  isAllMailFolder,
  resolveTrashFolder,
  resolveAllTrashPaths,
  getDeleteStrategy,
  adjustFolderCounts,
} = await import('../utils/mailUtils.js');
const { forwardRuleMessage } = await import('./ruleForwarder.js');
import { applyInboxRules, applyBlockList } from './inboxRules.js';

const account = { id: 'acc-1', folder_mappings: {} };

const mkMsg = (overrides = {}) => ({
  id: 'msg-1', uid: 100, folder: 'INBOX', account_id: 'acc-1',
  fromEmail: 'sender@example.com', fromName: 'Sender',
  to: [], subject: 'Test', is_read: false, hasAttachments: false,
  parsedHeaders: {},
  ...overrides,
});

const mkRule = (actions, overrides = {}) => ({
  id: 'rule-1', account_id: 'acc-1', enabled: true,
  stop_processing: false, condition_logic: 'AND',
  conditions: [{ field: 'from', operator: 'contains', value: 'sender@' }],
  actions,
  ...overrides,
});

const mockImap = {
  bulkMoveMessages: vi.fn(),
  setFlag: vi.fn(),
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyInboxRules — forwarding', () => {
  it('forwards before moving and still removes the moved source from remaining', async () => {
    const rule = mkRule([
      { type: 'move', value: 'INBOX/Processed' },
      { type: 'forward', value: 'recipient@example.com' },
    ]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    forwardRuleMessage.mockResolvedValue('sent');
    mockImap.bulkMoveMessages.mockResolvedValue({
      failed: [],
      uidMap: new Map([[100, 200]]),
    });

    const message = mkMsg();
    const result = await applyInboxRules([message], account, mockImap);

    expect(forwardRuleMessage).toHaveBeenCalledWith({
      ruleId: rule.id,
      message,
      account,
      imapManager: mockImap,
      recipient: 'recipient@example.com',
    });
    expect(forwardRuleMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mockImap.bulkMoveMessages.mock.invocationCallOrder[0]);
    expect(result.remaining).toHaveLength(0);
  });

  it('suppresses destination actions across rules after forwarding fails', async () => {
    const rules = [
      mkRule([
        { type: 'forward', value: 'recipient@example.com' },
        { type: 'delete', value: '' },
      ], { id: 'rule-1' }),
      mkRule([
        { type: 'move', value: 'INBOX/Processed' },
        { type: 'mark_read', value: '' },
      ], { id: 'rule-2' }),
    ];
    query
      .mockResolvedValueOnce({ rows: rules })
      .mockResolvedValueOnce({ rows: [] });
    forwardRuleMessage.mockRejectedValue(
      new Error('SMTP rejected recipient@example.com with original body')
    );
    mockImap.setFlag.mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await applyInboxRules([mkMsg()], account, mockImap);

      expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
      expect(result.remaining).toHaveLength(1);
      expect(mockImap.setFlag).toHaveBeenCalledWith(
        account,
        100,
        'INBOX',
        '\\Seen',
        true,
        { failFastWhenHeld: true }
      );
      expect(consoleError).toHaveBeenCalledWith(
        'inboxRules: forward action failed; destination actions suppressed'
      );
      const consoleOutput = consoleError.mock.calls
        .flat()
        .map(value => String(value))
        .join(' ');
      expect(consoleOutput).not.toContain('recipient@example.com');
      expect(consoleOutput).not.toContain('original body');
      expect(consoleOutput).not.toContain('SMTP rejected');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('preserves the source when another run still owns the pending forward', async () => {
    const rule = mkRule([
      { type: 'move', value: 'INBOX/Processed' },
      { type: 'forward', value: 'recipient@example.com' },
    ]);
    query.mockResolvedValueOnce({ rows: [rule] });
    forwardRuleMessage.mockRejectedValue(new Error('Forward delivery pending'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await applyInboxRules([mkMsg()], account, mockImap);

      expect(forwardRuleMessage).toHaveBeenCalledTimes(1);
      expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
      expect(result.remaining).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledWith(
        'inboxRules: forward action failed; destination actions suppressed'
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    ['move', { type: 'move', value: 'INBOX/Processed' }],
    ['archive', { type: 'archive', value: '' }],
    ['delete', { type: 'delete', value: '' }],
  ])(
    'runs a later failing forward before an earlier %s rule',
    async (_destinationType, destinationAction) => {
      const rules = [
        mkRule([destinationAction], { id: 'rule-destination' }),
        mkRule([
          { type: 'forward', value: 'recipient@example.com' },
        ], { id: 'rule-forward' }),
      ];
      query
        .mockResolvedValueOnce({ rows: rules })
        .mockResolvedValue({ rows: [] });
      forwardRuleMessage.mockRejectedValue(new Error('Forward delivery failed'));
      resolveArchiveFolder.mockResolvedValue('Archive');
      isAllMailFolder.mockResolvedValue(false);
      resolveTrashFolder.mockResolvedValue('Trash');
      resolveAllTrashPaths.mockResolvedValue(['Trash']);
      getDeleteStrategy.mockReturnValue({
        action: 'move',
        destination: 'Trash',
      });
      mockImap.bulkMoveMessages.mockResolvedValue({
        failed: [],
        uidMap: new Map([[100, 200]]),
      });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const result = await applyInboxRules([mkMsg()], account, mockImap);

        expect(forwardRuleMessage).toHaveBeenCalledTimes(1);
        expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
        expect(resolveArchiveFolder).not.toHaveBeenCalled();
        expect(resolveTrashFolder).not.toHaveBeenCalled();
        expect(getDeleteStrategy).not.toHaveBeenCalled();
        expect(result.remaining).toHaveLength(1);
        expect(consoleError).toHaveBeenCalledWith(
          'inboxRules: forward action failed; destination actions suppressed'
        );
      } finally {
        consoleError.mockRestore();
      }
    }
  );

  it('runs a later successful forward before an earlier destination rule', async () => {
    const rules = [
      mkRule([
        { type: 'move', value: 'INBOX/Processed' },
      ], { id: 'rule-destination' }),
      mkRule([
        { type: 'forward', value: 'recipient@example.com' },
      ], { id: 'rule-forward' }),
    ];
    query
      .mockResolvedValueOnce({ rows: rules })
      .mockResolvedValueOnce({ rows: [] });
    forwardRuleMessage.mockResolvedValue('sent');
    mockImap.bulkMoveMessages.mockResolvedValue({
      failed: [],
      uidMap: new Map([[100, 200]]),
    });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(forwardRuleMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mockImap.bulkMoveMessages.mock.invocationCallOrder[0]);
    expect(result.remaining).toHaveLength(0);
  });

  it('attempts all matching forwards before suppressing destinations', async () => {
    const rules = [
      mkRule([
        { type: 'move', value: 'INBOX/Processed' },
      ], { id: 'rule-destination' }),
      mkRule([
        { type: 'forward', value: 'first@example.com' },
      ], { id: 'rule-forward-1' }),
      mkRule([
        { type: 'forward', value: 'second@example.com' },
      ], { id: 'rule-forward-2' }),
    ];
    query.mockResolvedValueOnce({ rows: rules });
    forwardRuleMessage
      .mockRejectedValueOnce(new Error('Forward delivery failed'))
      .mockResolvedValueOnce('sent');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await applyInboxRules([mkMsg()], account, mockImap);

      expect(forwardRuleMessage).toHaveBeenCalledTimes(2);
      expect(forwardRuleMessage.mock.calls.map(([input]) => input.ruleId))
        .toEqual(['rule-forward-1', 'rule-forward-2']);
      expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
      expect(result.remaining).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not forward an unread rule after an earlier rule marks the message read', async () => {
    const rules = [
      mkRule([
        { type: 'mark_read', value: '' },
      ], { id: 'rule-mark-read' }),
      mkRule([
        { type: 'forward', value: 'recipient@example.com' },
      ], {
        id: 'rule-forward-unread',
        conditions: [{ field: 'read_status', value: 'unread' }],
      }),
    ];
    query
      .mockResolvedValueOnce({ rows: rules })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.setFlag.mockResolvedValue(undefined);

    const result = await applyInboxRules(
      [mkMsg({ is_read: false })],
      account,
      mockImap
    );

    expect(forwardRuleMessage).not.toHaveBeenCalled();
    expect(result.mutedIds.has('msg-1')).toBe(true);
  });

  it('forwards a read rule after an earlier rule marks the message read', async () => {
    const rules = [
      mkRule([
        { type: 'mark_read', value: '' },
      ], { id: 'rule-mark-read' }),
      mkRule([
        { type: 'forward', value: 'recipient@example.com' },
      ], {
        id: 'rule-forward-read',
        conditions: [{ field: 'read_status', value: 'read' }],
      }),
    ];
    query
      .mockResolvedValueOnce({ rows: rules })
      .mockResolvedValueOnce({ rows: [] });
    forwardRuleMessage.mockResolvedValue('sent');
    mockImap.setFlag.mockResolvedValue(undefined);

    const result = await applyInboxRules(
      [mkMsg({ is_read: false })],
      account,
      mockImap
    );

    expect(forwardRuleMessage).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: 'rule-forward-read',
      recipient: 'recipient@example.com',
    }));
    expect(result.mutedIds.has('msg-1')).toBe(true);
  });
});

describe('applyInboxRules — blank condition value never matches', () => {
  it('does not fire a move rule when the condition value is an empty string', async () => {
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Work' }],
      { conditions: [{ field: 'from', operator: 'contains', value: '' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1); // message stays in inbox
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('does not fire a delete rule when the subject condition value is whitespace', async () => {
    const rule = mkRule(
      [{ type: 'delete', value: '' }],
      { conditions: [{ field: 'subject', operator: 'starts_with', value: '   ' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });
});

describe('applyInboxRules — read_status condition', () => {
  it('fires a read-matching rule when the message is read', async () => {
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Trash' }],
      { conditions: [{ field: 'read_status', value: 'read' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });
    query.mockResolvedValue({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    const result = await applyInboxRules([mkMsg({ is_read: true })], account, mockImap);

    expect(mockImap.bulkMoveMessages).toHaveBeenCalledTimes(1);
    expect(result.remaining).toHaveLength(0);
  });

  it('does not fire a read-matching rule when the message is unread', async () => {
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Trash' }],
      { conditions: [{ field: 'read_status', value: 'read' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });

    const result = await applyInboxRules([mkMsg({ is_read: false })], account, mockImap);

    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
    expect(result.remaining).toHaveLength(1);
  });

  it('fires an unread-matching rule when the message is unread', async () => {
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Trash' }],
      { conditions: [{ field: 'read_status', value: 'unread' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });
    query.mockResolvedValue({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    const result = await applyInboxRules([mkMsg({ is_read: false })], account, mockImap);

    expect(mockImap.bulkMoveMessages).toHaveBeenCalledTimes(1);
    expect(result.remaining).toHaveLength(0);
  });
});

describe('applyInboxRules — malformed condition does not abort other rules', () => {
  it('skips the malformed rule and still applies a subsequent valid rule', async () => {
    const badRule = {
      ...mkRule([{ type: 'mark_read', value: '' }], { id: 'rule-bad' }),
      conditions: [null], // null condition would throw in evaluateCondition
    };
    const goodRule = mkRule(
      [{ type: 'move', value: 'INBOX/Work' }],
      { id: 'rule-good', stop_processing: false }
    );
    query
      .mockResolvedValueOnce({ rows: [badRule, goodRule] })  // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });                    // UPDATE folder (move)
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map() });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    // good rule fired, message removed from inbox
    expect(result.remaining).toHaveLength(0);
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
  });
});

describe('applyInboxRules — destination action no-ops do not remove message', () => {
  it('leaves message in inbox when move action has a blank destination', async () => {
    const rule = mkRule([{ type: 'move', value: '' }]);
    query.mockResolvedValueOnce({ rows: [rule] });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('leaves message in inbox when archive folder is not configured', async () => {
    const rule = mkRule([{ type: 'archive', value: '' }]);
    query.mockResolvedValueOnce({ rows: [rule] });
    resolveArchiveFolder.mockResolvedValue(null);

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });
});

describe('applyInboxRules — archive to Gmail All Mail', () => {
  it('deletes the message row instead of re-homing it into the All Mail folder', async () => {
    const rule = mkRule([{ type: 'archive', value: '' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })                  // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });                      // DELETE FROM messages
    resolveArchiveFolder.mockResolvedValue('[Gmail]/All Mail');
    isAllMailFolder.mockResolvedValue(true);
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    const result = await applyInboxRules([mkMsg({ is_read: false })], account, mockImap);

    expect(result.remaining).toHaveLength(0); // message removed from inbox
    const deleteCall = query.mock.calls[1];
    expect(deleteCall[0]).toMatch(/DELETE FROM messages/);
    expect(deleteCall[1]).toEqual(['msg-1']);
    // Source folder count decrements; All Mail destination count is never touched.
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', -1, -1);
    expect(adjustFolderCounts).toHaveBeenCalledTimes(1);
  });
});

describe('applyInboxRules — UID update after move', () => {
  it('updates both folder and uid when uidMap contains the new uid', async () => {
    const rule = mkRule([{ type: 'move', value: 'INBOX/Work' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })  // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });       // UPDATE folder+uid (move)
    mockImap.bulkMoveMessages.mockResolvedValue({
      failed: [],
      uidMap: new Map([[100, 789]]),
    });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(0); // message removed from inbox
    const updateCall = query.mock.calls[1];
    expect(updateCall[0]).toMatch(/uid/i); // SQL includes uid update
    expect(updateCall[1]).toEqual(['INBOX/Work', 789, 'msg-1']);
  });

  it('updates only folder when uidMap is empty (no UIDPLUS)', async () => {
    const rule = mkRule([{ type: 'move', value: 'INBOX/Work' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({
      failed: [],
      uidMap: new Map(), // empty — non-UIDPLUS server
    });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(0);
    const updateCall = query.mock.calls[1];
    expect(updateCall[1]).toEqual(['INBOX/Work', 'msg-1']); // only folder, no uid
  });
});

describe('applyInboxRules — destination action deduplication', () => {
  it('executes only the first destination action when a legacy rule has move + archive', async () => {
    const rule = mkRule([
      { type: 'move', value: 'INBOX/Work' },
      { type: 'archive', value: '' },
    ]);
    query
      .mockResolvedValueOnce({ rows: [rule] })  // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });       // UPDATE folder (move)
    // resolveArchiveFolder returns a valid path — if archive action ran it would
    // cause a second bulkMoveMessages call, making the assertion below fail
    resolveArchiveFolder.mockResolvedValue('Archive');
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [] });

    await applyInboxRules([mkMsg()], account, mockImap);

    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledWith(account, [100], 'INBOX', 'INBOX/Work', { failFastWhenHeld: true });
  });

  it('executes only the first destination action when a legacy rule has move + delete', async () => {
    const rule = mkRule([
      { type: 'move', value: 'INBOX/Archive' },
      { type: 'delete', value: '' },
    ]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [] });

    await applyInboxRules([mkMsg()], account, mockImap);

    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledWith(account, [100], 'INBOX', 'INBOX/Archive', { failFastWhenHeld: true });
  });

  it('skips subsequent destination actions even when the first one fails', async () => {
    // If move fails due to a bad path, archive must not run as a silent fallback.
    const rule = mkRule([
      { type: 'move', value: 'INBOX/NonExistent' },
      { type: 'archive', value: '' },
    ]);
    query.mockResolvedValueOnce({ rows: [rule] });
    resolveArchiveFolder.mockResolvedValue('Archive');
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [100] }); // move fails

    await applyInboxRules([mkMsg()], account, mockImap);

    // move was attempted once and failed; archive must not have been attempted
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(resolveArchiveFolder).not.toHaveBeenCalled();
  });

  it('still executes non-destination actions alongside a destination action', async () => {
    const rule = mkRule([
      { type: 'mark_read', value: '' },
      { type: 'move', value: 'INBOX/Work' },
    ]);
    query
      .mockResolvedValueOnce({ rows: [rule] })  // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] })        // UPDATE is_read (mark_read)
      .mockResolvedValueOnce({ rows: [] });        // UPDATE folder (move)
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [] });
    mockImap.setFlag.mockResolvedValue(undefined);

    await applyInboxRules([mkMsg()], account, mockImap);

    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(mockImap.setFlag).toHaveBeenCalledWith(account, 100, 'INBOX', '\\Seen', true, { failFastWhenHeld: true });
  });
});

describe('applyInboxRules — already-relocated message skips subsequent rules', () => {
  it('does not apply a second MOVE rule after the first rule moved the message', async () => {
    const rule1 = mkRule(
      [{ type: 'move', value: 'INBOX/Work' }],
      { id: 'rule-1', stop_processing: false }
    );
    const rule2 = mkRule(
      [{ type: 'move', value: 'INBOX/Spam' }],
      { id: 'rule-2', stop_processing: false }
    );
    query
      .mockResolvedValueOnce({ rows: [rule1, rule2] }) // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });              // UPDATE folder (rule1 move)
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    // message removed from remaining; second move never fired
    expect(result.remaining).toHaveLength(0);
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledWith(account, [100], 'INBOX', 'INBOX/Work', { failFastWhenHeld: true });
  });

  it('applies a subsequent mark_read rule even after an earlier rule moved the message', async () => {
    // Real-world scenario: rule 1 moves to a folder, rule 2 marks as read.
    // Both share the same condition. mark_read should still apply because it
    // operates on msg.id (not the stale INBOX uid) and is not a destination action.
    const rule1 = mkRule(
      [{ type: 'move', value: 'INBOX/Work' }],
      { id: 'rule-1', stop_processing: false }
    );
    const rule2 = mkRule(
      [{ type: 'mark_read', value: '' }],
      { id: 'rule-2', stop_processing: false }
    );
    query
      .mockResolvedValueOnce({ rows: [rule1, rule2] }) // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] })               // UPDATE folder+uid (rule1 move)
      .mockResolvedValueOnce({ rows: [] });               // UPDATE is_read (rule2 mark_read)
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });
    mockImap.setFlag.mockResolvedValue(undefined);

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(0); // message still moved
    // mark_read DB update fired: third query call (after rules fetch + move update)
    expect(query).toHaveBeenCalledTimes(3);
    // setFlag targeted the NEW uid (200) in the destination folder (INBOX/Work)
    expect(mockImap.setFlag).toHaveBeenCalledWith(account, 200, 'INBOX/Work', '\\Seen', true, { failFastWhenHeld: true });
  });

  it('does not double-decrement unread count when mark_read fires before move (reversed priority)', async () => {
    // Rule 1 (priority 0): mark_read. Rule 2 (priority 1): move.
    // mark_read must set msg.is_read = true in-memory so the subsequent move's
    // wasUnread check sees the updated state and does not decrement unread again.
    const rule1 = mkRule(
      [{ type: 'mark_read', value: '' }],
      { id: 'rule-1', stop_processing: false }
    );
    const rule2 = mkRule(
      [{ type: 'move', value: 'INBOX/Work' }],
      { id: 'rule-2', stop_processing: false }
    );
    query
      .mockResolvedValueOnce({ rows: [rule1, rule2] }) // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] })               // UPDATE is_read (rule1 mark_read)
      .mockResolvedValueOnce({ rows: [] });               // UPDATE folder+uid (rule2 move)
    mockImap.setFlag.mockResolvedValue(undefined);
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    await applyInboxRules([mkMsg({ is_read: false })], account, mockImap);

    // mark_read should adjust INBOX unread (-1); move should NOT adjust unread again
    // because wasUnread is false after mark_read updated msg.is_read in-memory.
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', 0, -1);  // mark_read
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', -1, 0);  // move source (no unread delta)
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX/Work', 1, 0); // move dest (no unread delta)
    expect(adjustFolderCounts).toHaveBeenCalledTimes(3);
  });
});

describe('applyInboxRules — mutedIds for mark_read', () => {
  it('adds message id to mutedIds when mark_read rule applies', async () => {
    const rule = mkRule([{ type: 'mark_read', value: '' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] }) // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });     // UPDATE is_read
    mockImap.setFlag.mockResolvedValue(undefined);

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1); // message stays in inbox
    expect(result.mutedIds.has('msg-1')).toBe(true);
  });

  it('does not add message id to mutedIds when only star rule applies', async () => {
    const rule = mkRule([{ type: 'star', value: '' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] }) // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });     // UPDATE is_starred
    mockImap.setFlag.mockResolvedValue(undefined);

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1);
    expect(result.mutedIds.has('msg-1')).toBe(false);
  });

  it('returns empty mutedIds when no rules match', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // no rules

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1);
    expect(result.mutedIds.size).toBe(0);
  });
});

describe('applyInboxRules — adjustFolderCounts on action', () => {
  it('calls adjustFolderCounts for source and destination after a successful move', async () => {
    const rule = mkRule([{ type: 'move', value: 'INBOX/Work' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    await applyInboxRules([mkMsg({ is_read: false })], account, mockImap);

    // unread message moved: source loses 1 total and 1 unread; dest gains 1 of each
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', -1, -1);
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX/Work', 1, 1);
  });

  it('calls adjustFolderCounts with zero unread delta when message is already read', async () => {
    const rule = mkRule([{ type: 'move', value: 'INBOX/Work' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    await applyInboxRules([mkMsg({ is_read: true })], account, mockImap);

    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', -1, 0);
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX/Work', 1, 0);
  });

  it('calls adjustFolderCounts with unread delta only for mark_read on an unread message', async () => {
    const rule = mkRule([{ type: 'mark_read', value: '' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.setFlag.mockResolvedValue(undefined);

    await applyInboxRules([mkMsg({ is_read: false })], account, mockImap);

    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', 0, -1);
    expect(adjustFolderCounts).toHaveBeenCalledTimes(1);
  });

  it('does not call adjustFolderCounts for mark_read when message is already read', async () => {
    const rule = mkRule([{ type: 'mark_read', value: '' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.setFlag.mockResolvedValue(undefined);

    await applyInboxRules([mkMsg({ is_read: true })], account, mockImap);

    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });
});

describe('applyInboxRules — from not_contains requires both name and email to not match', () => {
  it('does not fire when email contains the value even if name does not', async () => {
    // Buggy OR semantics: name "Alice" doesn't contain "example.com", so the rule
    // would fire even though fromEmail does contain it. Correct AND semantics: neither
    // email NOR name must contain the value.
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Filtered' }],
      { conditions: [{ field: 'from', operator: 'not_contains', value: 'example.com' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });

    const msg = mkMsg({ fromEmail: 'alice@example.com', fromName: 'Alice' });
    const result = await applyInboxRules([msg], account, mockImap);

    // email contains 'example.com' → condition false → no move
    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('fires when neither email nor name contains the value', async () => {
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Filtered' }],
      { conditions: [{ field: 'from', operator: 'not_contains', value: 'example.com' }] }
    );
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map() });

    const msg = mkMsg({ fromEmail: 'alice@other.net', fromName: 'Alice' });
    const result = await applyInboxRules([msg], account, mockImap);

    // neither field contains 'example.com' → condition true → move fires
    expect(result.remaining).toHaveLength(0);
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
  });
});

describe('applyInboxRules — to not_contains requires all recipients to not match', () => {
  it('does not fire when any recipient address contains the value', async () => {
    // Buggy some() semantics: addr B doesn't contain 'filtered', so some() returns true
    // for that element → rule fires even though addr A does contain 'filtered'.
    // Correct every() semantics: ALL recipients must not contain the value.
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Filtered' }],
      { conditions: [{ field: 'to', operator: 'not_contains', value: 'filtered' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });

    const msg = mkMsg({
      to: [
        { email: 'a@filtered.com', name: 'A' },
        { email: 'b@other.com', name: 'B' },
      ],
    });
    const result = await applyInboxRules([msg], account, mockImap);

    // addr A contains 'filtered' → condition false → no move
    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('fires when all recipients and their names do not contain the value', async () => {
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Filtered' }],
      { conditions: [{ field: 'to', operator: 'not_contains', value: 'filtered' }] }
    );
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map() });

    const msg = mkMsg({
      to: [
        { email: 'a@other.com', name: 'Alice' },
        { email: 'b@other.net', name: 'Bob' },
      ],
    });
    const result = await applyInboxRules([msg], account, mockImap);

    // no recipient contains 'filtered' → condition true → move fires
    expect(result.remaining).toHaveLength(0);
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
  });
});

describe('rules and block list are per mailbox', () => {
  it('loads the enabled rules of the mailbox only', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await applyInboxRules([mkMsg()], account, mockImap);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/WHERE account_id = \$1 AND enabled = true/), ['acc-1']);
  });

  it('reads the block list of the mailbox only', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const remaining = await applyBlockList([mkMsg()], account, mockImap);
    expect(query).toHaveBeenCalledWith('SELECT email_address FROM block_list WHERE account_id = $1', ['acc-1']);
    expect(remaining).toHaveLength(1);
  });
});

describe('destination actions while the mailbox password is rejected', () => {
  // A move goes through the IMAP pool, which would open a login the server is bound to reject:
  // a fail2ban strike against the whole mail node. The pool holds that login back and fails the
  // move with providerRefusing (imapManager's loginHeldBack); the letter stays put and the skip
  // is logged.
  const heldBack = () => Object.assign(new Error('Mail server is not accepting new connections for this account right now'), { providerRefusing: true });
  const heldImap = () => ({ ...mockImap, bulkMoveMessages: vi.fn().mockRejectedValue(heldBack()) });

  it.each([
    ['move', { type: 'move', value: 'INBOX/Processed' }],
    ['archive', { type: 'archive', value: '' }],
    ['delete', { type: 'delete', value: '' }],
  ])('leaves the letter in place and logs the skipped %s', async (what, action) => {
    query.mockResolvedValueOnce({ rows: [mkRule([action])] }).mockResolvedValue({ rows: [] });
    resolveArchiveFolder.mockResolvedValue('Archive');
    isAllMailFolder.mockResolvedValue(false);
    resolveTrashFolder.mockResolvedValue('Trash');
    resolveAllTrashPaths.mockResolvedValue(['Trash']);
    getDeleteStrategy.mockReturnValue({ action: 'move', destination: 'Trash' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const imap = heldImap();
      const result = await applyInboxRules([mkMsg()], account, imap);
      expect(result.remaining).toHaveLength(1);
      expect(query.mock.calls.some(([sql]) => /^UPDATE messages SET folder|^DELETE FROM messages/.test(sql))).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^inboxRules: ${what} skipped for msg msg-1 \\(rule rule-1\\).*stays in INBOX`)));
    } finally { warn.mockRestore(); }
  });

  it.each([
    ['held back', heldBack],
    ['the pool stayed busy', () => Object.assign(new Error('IMAP pool busy, please retry'), { poolExhausted: true })],
  ])('logs a rule move the pool did not run (%s) as skipped, not as an error', async (_what, makeErr) => {
    query.mockResolvedValueOnce({ rows: [mkRule([{ type: 'move', value: 'INBOX/Processed' }])] }).mockResolvedValue({ rows: [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const imap = { ...mockImap, bulkMoveMessages: vi.fn().mockRejectedValue(makeErr()) };
      const result = await applyInboxRules([mkMsg()], account, imap);
      expect(result.remaining).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^inboxRules: move skipped for msg msg-1 \(rule rule-1\).*stays in INBOX/));
      expect(error).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); error.mockRestore(); }
  });

  it('defers a held-back rule mark_read to the flag-push queue with a warning, not an error', async () => {
    query.mockResolvedValueOnce({ rows: [mkRule([{ type: 'mark_read', value: '' }])] }).mockResolvedValue({ rows: [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const imap = { ...mockImap, setFlag: vi.fn().mockRejectedValue(heldBack()), _enqueueFlagPush: vi.fn() };
      await applyInboxRules([mkMsg()], account, imap);
      await vi.waitFor(() => expect(imap._enqueueFlagPush).toHaveBeenCalledWith(account.id, 'msg-1', '\\Seen', true));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^inboxRules: mark_read skipped for msg msg-1 \(rule rule-1\).*deferred to the flag-push queue/));
      expect(error).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); error.mockRestore(); }
  });

  it('still moves when nothing holds logins back', async () => {
    query.mockResolvedValueOnce({ rows: [mkRule([{ type: 'move', value: 'INBOX/Processed' }])] }).mockResolvedValue({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });
    const imap = { ...mockImap };
    const result = await applyInboxRules([mkMsg()], account, imap);
    expect(imap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(result.remaining).toHaveLength(0);
  });

  it('keeps a blocked sender in place when the pool holds the login back', async () => {
    query.mockResolvedValueOnce({ rows: [{ email_address: 'sender@example.com' }] });
    resolveTrashFolder.mockResolvedValue('Trash');
    resolveAllTrashPaths.mockResolvedValue(['Trash']);
    getDeleteStrategy.mockReturnValue({ action: 'move', destination: 'Trash' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const imap = heldImap();
      const remaining = await applyBlockList([mkMsg()], account, imap);
      expect(remaining).toHaveLength(1);
      expect(query.mock.calls.some(([sql]) => /^UPDATE messages SET folder/.test(sql))).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('block list move skipped for msg msg-1'));
    } finally { warn.mockRestore(); }
  });
});

describe('a rule forward held back by a rejected password', () => {
  it('is logged plainly as skipped and not retried, without the error text', async () => {
    query.mockResolvedValueOnce({ rows: [mkRule([{ type: 'forward', value: 'recipient@example.com' }])] }).mockResolvedValue({ rows: [] });
    forwardRuleMessage.mockRejectedValue(Object.assign(new Error('Mail server is not accepting new connections for this account right now'), { providerRefusing: true }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await applyInboxRules([mkMsg()], account, mockImap);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^inboxRules: forward skipped for msg msg-1 \(rule rule-1\).*not retried/));
    } finally { warn.mockRestore(); error.mockRestore(); }
  });

  it('says nothing of the kind for an ordinary forward failure', async () => {
    query.mockResolvedValueOnce({ rows: [mkRule([{ type: 'forward', value: 'recipient@example.com' }])] }).mockResolvedValue({ rows: [] });
    forwardRuleMessage.mockRejectedValue(new Error('Forward delivery failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await applyInboxRules([mkMsg()], account, mockImap);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); error.mockRestore(); }
  });
});

describe('applyInboxRules — body rules while the body is not fetched', () => {
  const bodyRule = (overrides = {}) => mkRule(
    [{ type: 'move', value: 'Processed' }],
    { conditions: [{ field: 'body', operator: 'not_contains', value: 'invoice' }], ...overrides }
  );
  const withBody = (bodyText, bodyHtml = null) => ({ rows: [{ id: 'msg-1', body_text: bodyText, body_html: bodyHtml }] });
  const silence = () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    return () => { warn.mockRestore(); error.mockRestore(); };
  };

  it('skips a negative body rule while the body is not fetched: the message stays', async () => {
    query.mockResolvedValueOnce({ rows: [bodyRule()] }).mockResolvedValueOnce(withBody(null));
    const restore = silence();
    try {
      const result = await applyInboxRules([mkMsg()], account, mockImap);
      expect(result.remaining).toHaveLength(1);
      expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('skips the whole rule, OR included, when one of its conditions needs the unknown body', async () => {
    const rule = bodyRule({
      condition_logic: 'OR',
      conditions: [
        { field: 'subject', operator: 'contains', value: 'Test' },
        { field: 'body', operator: 'contains', value: 'invoice' },
      ],
    });
    query.mockResolvedValueOnce({ rows: [rule] }).mockResolvedValueOnce(withBody(null));
    const restore = silence();
    try {
      const result = await applyInboxRules([mkMsg()], account, mockImap);
      expect(result.remaining).toHaveLength(1);
      expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('skips body rules when the body could not be read, and still runs the others', async () => {
    const other = mkRule([{ type: 'mark_read', value: '' }], { id: 'rule-other' });
    query
      .mockResolvedValueOnce({ rows: [bodyRule(), other] })
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ rows: [] });
    const restore = silence();
    try {
      const result = await applyInboxRules([mkMsg()], account, mockImap);
      expect(result.remaining).toHaveLength(1);
      expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
      expect(result.mutedIds.has('msg-1')).toBe(true);
    } finally { restore(); }
  });

  it('moves a message whose loaded body does not contain the value', async () => {
    query.mockResolvedValueOnce({ rows: [bodyRule()] }).mockResolvedValueOnce(withBody('hello there')).mockResolvedValue({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map() });
    const result = await applyInboxRules([mkMsg()], account, mockImap);
    expect(result.remaining).toHaveLength(0);
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
  });

  it('keeps a message whose loaded body contains the value', async () => {
    query.mockResolvedValueOnce({ rows: [bodyRule()] }).mockResolvedValueOnce(withBody('your Invoice is attached'));
    const result = await applyInboxRules([mkMsg()], account, mockImap);
    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('treats an HTML-only body that was fetched as known, as before', async () => {
    query.mockResolvedValueOnce({ rows: [bodyRule()] }).mockResolvedValueOnce(withBody(null, '<p>hello</p>')).mockResolvedValue({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map() });
    const restore = silence();
    try {
      const result = await applyInboxRules([mkMsg()], account, mockImap);
      expect(result.remaining).toHaveLength(0);
      expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    } finally { restore(); }
  });
});
