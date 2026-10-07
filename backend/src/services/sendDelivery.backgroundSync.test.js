import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Sent folder syncs a panel runs after a send are background work: nobody waits for them, so
// they must not take the pooled session kept for user actions (imapManager backgroundPoolCap).
vi.mock('./auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}), collectHook: vi.fn(async () => []) } }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
import { query } from './db.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { deliverOutgoingMessage, serverSavesSentCopy } from './sendDelivery.js';

const imapManager = {
  appendToSent: vi.fn(),
  upsertSentMessageRecord: vi.fn(async () => {}),
  syncFolderOnDemand: vi.fn(async () => {}),
  findUidByMessageId: vi.fn(async () => null),
  pluginFacade: {},
};
// A password mailbox (the mail node): no server-side Sent copy, so the panel APPENDs it.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: null };
const sendMail = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  query.mockImplementation(async () => ({ rows: [{ id: 'book1' }] }));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue('Sent');
});
const deliver = (acct = account) => deliverOutgoingMessage({
  account: acct,
  actorUserId: 'u1',
  imapManager,
  mail: {
    options: { messageId: '<m1@example.com>', from: 'Me <me@example.com>', to: 'you@example.com', subject: 'Test', text: 'Hello' },
    meta: { to: ['you@example.com'], cc: [], bcc: [], subject: 'Test', fromName: 'Me', fromEmail: 'me@example.com', snippet: 'Hello' },
  },
});

describe('the Sent folder sync after a send', () => {
  it('runs as background work after the Sent copy is appended', async () => {
    imapManager.appendToSent.mockResolvedValue({ uid: null });
    await expect(deliver()).resolves.toMatchObject({ sentFolder: 'Sent', sentCopySaved: true });
    await vi.waitFor(() => expect(imapManager.syncFolderOnDemand).toHaveBeenCalled(), { timeout: 3000 });
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Sent', { background: true });
  });

  it('runs as background work after a failed append (the fallback 8 s later)', async () => {
    imapManager.appendToSent.mockRejectedValue(new Error('append refused'));
    await expect(deliver()).resolves.toMatchObject({ sentCopySaved: false });
    await vi.waitFor(() => expect(imapManager.syncFolderOnDemand).toHaveBeenCalled(), { timeout: 10000, interval: 200 });
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Sent', { background: true });
  }, 15000);

  it('runs as background work for a mailbox whose server saves the Sent copy', async () => {
    // 'microsoft' (non-Gmail OAuth) exercises serverAutoSaves without the Gmail-API send path.
    const oauth = { ...account, oauth_provider: 'microsoft' };
    createAccountSmtpTransport.mockResolvedValue({ account: oauth, transport: { sendMail } });
    await expect(deliver(oauth)).resolves.toMatchObject({ sentFolder: 'Sent', sentCopySaved: null });
    await vi.waitFor(() => expect(imapManager.syncFolderOnDemand).toHaveBeenCalled(), { timeout: 5000, interval: 200 });
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(oauth, 'Sent', { background: true });
  }, 10000);

  it('does not APPEND for Gmail added with manual IMAP/SMTP settings: Gmail saves the Sent copy', async () => {
    const gmail = { ...account, imap_host: 'imap.gmail.com', smtp_host: 'SMTP.gmail.com' };
    createAccountSmtpTransport.mockResolvedValue({ account: gmail, transport: { sendMail } });
    await expect(deliver(gmail)).resolves.toMatchObject({ sentFolder: 'Sent', sentCopySaved: null });
    await vi.waitFor(() => expect(imapManager.syncFolderOnDemand).toHaveBeenCalled(), { timeout: 5000, interval: 200 });
    expect(imapManager.appendToSent).not.toHaveBeenCalled();
  }, 10000);
});

describe('serverSavesSentCopy', () => {
  it('trusts an OAuth provider, and Gmail sending through its own SMTP server', () => {
    expect(serverSavesSentCopy({ oauth_provider: 'google' })).toBe(true);
    expect(serverSavesSentCopy({ oauth_provider: 'microsoft' })).toBe(true);
    expect(serverSavesSentCopy({ imap_host: 'imap.gmail.com', smtp_host: 'smtp.gmail.com' })).toBe(true);
    expect(serverSavesSentCopy({ imap_host: 'imap.googlemail.com', smtp_host: 'smtp.googlemail.com' })).toBe(true);
  });

  it('APPENDs when the letter does not go out through Gmail into the same Gmail mailbox', () => {
    expect(serverSavesSentCopy({ imap_host: 'imap.example.com', smtp_host: 'smtp.example.com' })).toBe(false);
    // Workspace SMTP relay does not file a Sent copy; nor does Gmail SMTP for a non-Gmail mailbox.
    expect(serverSavesSentCopy({ imap_host: 'imap.gmail.com', smtp_host: 'smtp-relay.gmail.com' })).toBe(false);
    expect(serverSavesSentCopy({ imap_host: 'imap.example.com', smtp_host: 'smtp.gmail.com' })).toBe(false);
    expect(serverSavesSentCopy({ imap_host: 'imap.gmail.com', smtp_host: 'smtp.example.com' })).toBe(false);
  });
});
