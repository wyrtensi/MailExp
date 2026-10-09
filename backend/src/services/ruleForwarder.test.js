import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./smtpTransport.js', () => ({
  createAccountSmtpTransport: vi.fn(),
}));

import { createHash, createHmac, hkdfSync } from 'crypto';
import nodemailer from 'nodemailer';
import { query } from './db.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { parseRawHeaders } from './messageParser.js';
import {
  buildForwardMessage,
  forwardRuleMessage,
} from './ruleForwarder.js';

// The fresh state of a mailbox that may send (forwardRuleMessage reads it first).
const SENDABLE = { rows: [{ enabled: true, mail_node: false, delete_after: null, deactivated_at: null }] };
const account = {
  id: 'account-1',
  sender_name: 'Mailbox',
  email_address: 'mailbox@example.com',
};
const storedAttachments = [
  {
    part: '2',
    filename: 'invoice.pdf',
    type: 'application/pdf',
    encoding: 'base64',
    size: 7,
  },
  {
    part: '3',
    filename: 'notes.txt',
    type: 'text/plain',
    encoding: 'quoted-printable',
    size: 5,
  },
];
const messageRow = {
  id: 'message-1',
  account_id: account.id,
  uid: 42,
  folder: 'INBOX',
  subject: 'Quarterly review',
  from_name: 'Example Sender',
  from_email: 'sender@example.com',
  to_addresses: [{ address: 'team@example.com' }],
  cc_addresses: [],
  date: '2026-07-29T12:00:00.000Z',
  body_text: 'Original body',
  body_html: '<p>Original body</p>',
  attachments: [],
};

// The headers sync hands the rules when a sent forward lands in a mailbox: the message as
// nodemailer writes it, read back by the parser sync uses.
async function deliveredHeaders(mail) {
  const { message } = await nodemailer
    .createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
    .sendMail(mail);
  return parseRawHeaders(message.subarray(0, message.indexOf('\r\n\r\n')));
}

// The loop token is keyed with a key derived from ENCRYPTION_KEY, which index.js requires.
const KEY = 'a1'.repeat(32);
const OTHER_KEY = '5e'.repeat(32);

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildForwardMessage', () => {
  it('builds a PII-free-shape Fwd message and escapes forwarded headers', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'Quarterly <review>',
        from_name: 'Example <Sender>',
        from_email: 'sender@example.com',
        to_addresses: [{ address: 'team@example.com' }],
        cc_addresses: [],
        date: '2026-07-29T12:00:00.000Z',
      },
      account: {
        sender_name: 'Mailbox',
        email_address: 'mailbox@example.com',
      },
      recipient: 'recipient@example.com',
      text: 'Plain body',
      html: '<p>HTML body</p>',
      attachments: [],
    });

    expect(mail).toMatchObject({
      from: 'Mailbox <mailbox@example.com>',
      to: 'recipient@example.com',
      subject: 'Fwd: Quarterly <review>',
    });
    expect(mail.text).toContain('---------- Forwarded message ----------');
    expect(mail.text).toContain('Plain body');
    expect(mail.html).toContain('Example &lt;Sender&gt;');
    expect(mail.html).toContain('<p>HTML body</p>');
  });

  it('does not add a second Fwd prefix', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'Fwd: Existing',
        from_name: '',
        from_email: 'sender@example.com',
        to_addresses: [],
        cc_addresses: [],
        date: null,
      },
      account: {
        name: 'Mailbox',
        email_address: 'mailbox@example.com',
      },
      recipient: 'recipient@example.com',
      text: '',
      html: null,
      attachments: [],
    });
    expect(mail.subject).toBe('Fwd: Existing');
  });

  it('derives a readable text alternative for HTML-only messages', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'HTML only',
        from_name: 'Example Sender',
        from_email: 'sender@example.com',
        to_addresses: [],
        cc_addresses: [],
        date: null,
      },
      account,
      recipient: 'recipient@example.com',
      text: '',
      html: '<p>Hello <strong>there</strong></p><p>Second&nbsp;line</p>',
      attachments: [],
    });

    expect(mail.text).toContain('Hello there');
    expect(mail.text).toContain('Second line');
  });

  it('preserves a text-only body without adding an HTML alternative', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'Text only',
        from_name: 'Example Sender',
        from_email: 'sender@example.com',
        to_addresses: [],
        cc_addresses: [],
        date: null,
      },
      account,
      recipient: 'recipient@example.com',
      text: 'Plain body only',
      html: null,
      attachments: [],
    });

    expect(mail.text).toContain('Plain body only');
    expect(mail).not.toHaveProperty('html');
  });

  it('keys the loop token with a key derived from ENCRYPTION_KEY', async () => {
    const tokenUnder = async key => {
      vi.resetModules();
      vi.stubEnv('ENCRYPTION_KEY', key);
      const forwarder = await import('./ruleForwarder.js');
      return forwarder.buildForwardMessage({
        row: messageRow,
        account,
        recipient: 'recipient@example.com',
        text: 'Plain body',
      }).headers['X-MailExpert-Loop'];
    };
    const token = await tokenUnder(KEY);

    // Only this instance can compute it: an HMAC of the address under the HKDF-derived key.
    const derived = Buffer.from(
      hkdfSync('sha256', Buffer.from(KEY, 'hex'), Buffer.alloc(0), 'mailexpert:rule-forward-loop', 32)
    );
    expect(token).toBe(createHmac('sha256', derived)
      .update(account.email_address)
      .digest('hex')
      .slice(0, 16));
    expect(await tokenUnder(OTHER_KEY)).not.toBe(token);
  });

  it('refuses to build a forward without a valid ENCRYPTION_KEY', async () => {
    vi.resetModules();
    vi.stubEnv('ENCRYPTION_KEY', '');
    const forwarder = await import('./ruleForwarder.js');
    expect(() => forwarder.buildForwardMessage({
      row: messageRow, account, recipient: 'recipient@example.com', text: 'Plain body',
    })).toThrow(/ENCRYPTION_KEY/);
  });
});

describe('forwardRuleMessage', () => {
  let transport;
  let imapManager;
  let input;

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    transport = { sendMail: vi.fn().mockResolvedValue({ accepted: true }) };
    createAccountSmtpTransport.mockResolvedValue({ account, transport });
    imapManager = {
      fetchMessageBody: vi.fn(),
      fetchMultipleAttachments: vi.fn().mockResolvedValue(new Map()),
      // A letter with no pending move is read where its row says (moveQueue.serverLocation).
      moveQueue: { serverLocation: vi.fn(async (row) => ({ folder: row.folder, uid: Number(row.uid) })) },
    };
    input = {
      ruleId: 'rule-1',
      message: { id: messageRow.id },
      account,
      imapManager,
      recipient: 'recipient@example.com',
    };
  });

  it('skips a forward from a read-only mail node mailbox: it cannot send', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ mail_node: true, delete_after: null, deactivated_at: new Date() }] });
    const result = await forwardRuleMessage({
      ruleId: 'r1', message: { id: 'm1' }, account: { id: 'a1', mail_node: true, email_address: 'me@example.com' },
      imapManager: {}, recipient: 'you@example.com',
    });
    expect(result).toBe('read_only');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('skips a forward from a disabled mailbox of any kind, read fresh: it cannot send', async () => {
    for (const mailNode of [false, true]) {
      query.mockReset();
      query.mockResolvedValueOnce({ rows: [{ enabled: false, mail_node: mailNode, delete_after: null, deactivated_at: null }] });
      // The account object the rule runs with may predate the change: it still says enabled.
      const result = await forwardRuleMessage({ ...input, account: { ...account, enabled: true, mail_node: mailNode } });
      expect(result).toBe('disabled');
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain('FROM email_accounts');
    }
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('reserves, sends once, and marks the delivery sent', async () => {
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [messageRow] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).resolves.toBe('sent');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.at(-1)[0]).toContain("status = 'sent'");
  });

  it('returns duplicate without sending when the existing reservation is sent', async () => {
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'sent' }] });

    await expect(forwardRuleMessage(input)).resolves.toBe('duplicate');
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toContain('SELECT status');
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });

  it('rejects a pending reservation without starting another delivery', async () => {
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] });

    await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery pending');
    expect(query).toHaveBeenCalledTimes(3);
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });

  it('allows only one SMTP attempt while another run owns the pending reservation', async () => {
    let reservationCreated = false;
    let reservationStatus = 'pending';
    let notifyDeliveryStarted;
    let releaseDelivery;
    const deliveryStarted = new Promise(resolve => {
      notifyDeliveryStarted = resolve;
    });
    transport.sendMail.mockImplementation(() => {
      notifyDeliveryStarted();
      return new Promise(resolve => {
        releaseDelivery = resolve;
      });
    });
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts')) return SENDABLE;
      if (sql.includes('INSERT INTO inbox_rule_forwards')) {
        if (reservationCreated) return { rows: [] };
        reservationCreated = true;
        return { rows: [{ id: 'delivery-1' }] };
      }
      if (sql.includes('SELECT status')) {
        return { rows: [{ status: reservationStatus }] };
      }
      if (sql.includes('FROM messages')) {
        return { rows: [messageRow] };
      }
      if (sql.includes('UPDATE inbox_rule_forwards')) {
        reservationStatus = 'sent';
        return { rows: [] };
      }
      throw new Error('Unexpected query');
    });

    const firstRun = forwardRuleMessage(input);
    await deliveryStarted;

    await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery pending');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(createAccountSmtpTransport).toHaveBeenCalledTimes(1);

    releaseDelivery({ accepted: true });
    await expect(firstRun).resolves.toBe('sent');
    expect(reservationStatus).toBe('sent');
  });

  it('deletes a pending reservation after a known pre-delivery failure', async () => {
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockRejectedValueOnce(new Error('body unavailable'))
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).rejects.toThrow('body unavailable');
    expect(query.mock.calls.at(-1)[0]).toContain('DELETE FROM inbox_rule_forwards');
  });

  it('keeps the reservation when recording success fails after SMTP delivery', async () => {
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [messageRow] })
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(forwardRuleMessage(input)).rejects.toThrow('database unavailable');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('fetches only stored attachment parts once and preserves their metadata', async () => {
    const pdf = Buffer.from('pdfdata');
    const notes = Buffer.from('notes');
    const row = {
      ...messageRow,
      attachments: JSON.stringify(storedAttachments),
    };
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
      ['2', pdf],
      ['3', notes],
    ]));
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).resolves.toBe('sent');

    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
    expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledTimes(1);
    expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(
      account,
      messageRow.uid,
      messageRow.folder,
      storedAttachments,
      { failFastWhenHeld: true }
    );
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [
        {
          filename: 'invoice.pdf',
          content: pdf,
          contentType: 'application/pdf',
        },
        {
          filename: 'notes.txt',
          content: notes,
          contentType: 'text/plain',
        },
      ],
    }));
  });

  // A user moved the letter (DB-first, services/moveQueue.js) after the rule matched: its row
  // holds a placeholder uid, and the body and attachments are read where the server has it.
  it('reads a letter whose move is pending at the source of its move', async () => {
    const row = { ...messageRow, uid: -12, folder: 'Archive', body_text: '', body_html: null, attachments: [storedAttachments[0]] };
    imapManager.moveQueue.serverLocation.mockResolvedValueOnce({ folder: 'INBOX', uid: 41 });
    imapManager.fetchMessageBody.mockResolvedValue({ text: 'Body', html: null, attachments: [] });
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([['2', Buffer.from('pdf')]]));
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(forwardRuleMessage(input)).resolves.toBe('sent');
    expect(imapManager.moveQueue.serverLocation).toHaveBeenCalledWith(expect.objectContaining({ uid: -12 }), account);
    expect(imapManager.fetchMessageBody).toHaveBeenCalledWith(account, 41, 'INBOX', expect.anything());
    expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(account, 41, 'INBOX', expect.anything(), expect.anything());
  });

  it('fetches an uncached body, sanitizes HTML, and embeds inline data images', async () => {
    const pdf = Buffer.from('pdfdata');
    const row = {
      ...messageRow,
      body_text: '',
      body_html: null,
      attachments: [storedAttachments[0]],
    };
    imapManager.fetchMessageBody.mockResolvedValue({
      text: 'Secret original body',
      html: '<p onclick="alert(1)">Secret original body<img src="data:image/png;base64,QUJD"></p><script>alert(1)</script>',
      attachments: [{ ...storedAttachments[0], filename: 'duplicate.pdf' }],
    });
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
      ['2', pdf],
    ]));
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });
    const consoleSpies = ['log', 'info', 'warn', 'error'].map(method =>
      vi.spyOn(console, method).mockImplementation(() => {}));

    try {
      await expect(forwardRuleMessage(input)).resolves.toBe('sent');

      expect(imapManager.fetchMessageBody).toHaveBeenCalledWith(
        account,
        messageRow.uid,
        messageRow.folder,
        { allowLogin: true, failFastWhenHeld: true }
      );
      expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(
        account,
        messageRow.uid,
        messageRow.folder,
        [storedAttachments[0]],
        { failFastWhenHeld: true }
      );
      const mail = transport.sendMail.mock.calls[0][0];
      expect(mail.html).not.toContain('<script');
      expect(mail.html).not.toContain('onclick=');
      expect(mail.html).not.toContain('data:image');
      expect(mail.html).toMatch(/src="cid:img-[a-f0-9]+-0@mailexpert"/);
      expect(mail.attachments).toEqual([
        expect.objectContaining({
          filename: 'image-0.png',
          content: Buffer.from('ABC'),
          contentDisposition: 'inline',
          contentType: 'image/png',
        }),
        {
          filename: 'invoice.pdf',
          content: pdf,
          contentType: 'application/pdf',
        },
      ]);
      const consoleOutput = consoleSpies
        .flatMap(spy => spy.mock.calls.flat())
        .map(value => String(value))
        .join(' ');
      expect(consoleOutput).not.toContain(input.recipient);
      expect(consoleOutput).not.toContain('Secret original body');
      expect(consoleOutput).not.toContain('invoice.pdf');
    } finally {
      consoleSpies.forEach(spy => spy.mockRestore());
    }
  });

  it('forwards attachment metadata discovered while fetching an uncached body', async () => {
    const pdf = Buffer.from('pdfdata');
    const fetchedAttachment = {
      part: '4',
      filename: 'discovered.pdf',
      type: 'application/pdf',
      encoding: 'base64',
      size: pdf.length,
    };
    const row = {
      ...messageRow,
      body_text: '',
      body_html: null,
      attachments: [],
    };
    imapManager.fetchMessageBody.mockResolvedValue({
      text: 'Fetched body',
      html: '<p>Fetched body</p>',
      attachments: [fetchedAttachment],
    });
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
      ['4', pdf],
    ]));
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).resolves.toBe('sent');

    expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(
      account,
      messageRow.uid,
      messageRow.folder,
      [fetchedAttachment],
      { failFastWhenHeld: true }
    );
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{
        filename: 'discovered.pdf',
        content: pdf,
        contentType: 'application/pdf',
      }],
    }));
  });

  it('rejects attachments larger than 25 MiB before SMTP delivery', async () => {
    const row = {
      ...messageRow,
      attachments: [{
        part: '2',
        filename: 'large.bin',
        type: 'application/octet-stream',
        encoding: 'base64',
        size: 0,
      }],
    };
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
      ['2', Buffer.alloc((25 * 1024 * 1024) + 1)],
    ]));
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input))
      .rejects.toThrow('Total attachment size exceeds 25 MiB');
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)[0]).toContain('DELETE FROM inbox_rule_forwards');
  });

  it('rejects declared attachment sizes over 25 MiB before fetching bytes', async () => {
    const row = {
      ...messageRow,
      attachments: [{
        part: '2',
        filename: 'declared-large.bin',
        type: 'application/octet-stream',
        size: (25 * 1024 * 1024) + 1,
      }],
    };
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input))
      .rejects.toThrow('Total attachment size exceeds 25 MiB');
    expect(imapManager.fetchMultipleAttachments).not.toHaveBeenCalled();
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)[0]).toContain('DELETE FROM inbox_rule_forwards');
  });

  it('deletes the reservation when an attachment buffer is unavailable', async () => {
    const row = {
      ...messageRow,
      attachments: [storedAttachments[0]],
    };
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map());
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input))
      .rejects.toThrow('Forward attachment unavailable');
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)[0]).toContain('DELETE FROM inbox_rule_forwards');
  });

  it('deletes the reservation when SMTP setup returns a safe error', async () => {
    createAccountSmtpTransport.mockResolvedValue({
      error: 'SMTP is unavailable',
    });
    query
      .mockResolvedValueOnce(SENDABLE)
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [messageRow] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).rejects.toThrow('SMTP is unavailable');
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)[0]).toContain('DELETE FROM inbox_rule_forwards');
  });

  it('clears a failed delivery reservation so a retry can send, for a definite rejection', async () => {
    // A server reply (responseCode) is a definite refusal — sendFailureIsDefinite (shared with
    // routes/send.js, see services/smtpErrors.js) reports it as safe to retry.
    const unsafeMessage = 'Message failed: 550 rejected for recipient@example.com';
    let reservationStatus = null;
    transport.sendMail
      .mockRejectedValueOnce(Object.assign(new Error(unsafeMessage), { responseCode: 550 }))
      .mockResolvedValueOnce({ accepted: true });
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts')) return SENDABLE;
      if (sql.includes('INSERT INTO inbox_rule_forwards')) {
        if (reservationStatus) return { rows: [] };
        reservationStatus = 'pending';
        return { rows: [{ id: 'delivery-1' }] };
      }
      if (sql.includes('SELECT status')) {
        return { rows: [{ status: reservationStatus }] };
      }
      if (sql.includes('FROM messages')) {
        return { rows: [messageRow] };
      }
      if (sql.includes('DELETE FROM inbox_rule_forwards')) {
        reservationStatus = null;
        return { rows: [] };
      }
      if (sql.includes('UPDATE inbox_rule_forwards')) {
        reservationStatus = 'sent';
        return { rows: [] };
      }
      throw new Error('Unexpected query');
    });

    let thrown;
    try {
      await forwardRuleMessage(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe('Forward delivery failed');
    expect(thrown.message).not.toContain('recipient@example.com');
    expect(thrown.message).not.toContain(unsafeMessage);
    expect(thrown.cause).toBeInstanceOf(Error);
    await expect(forwardRuleMessage(input)).resolves.toBe('sent');
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    expect(createAccountSmtpTransport).toHaveBeenCalledTimes(2);
    expect(reservationStatus).toBe('sent');
  });

  // The server may already have accepted the message (a connection break with no reply, or —
  // for a Gmail mailbox — a Gmail API timeout after the request was sent, see
  // services/mailSendTransport.js). Unlike a definite rejection above, this must NOT clear the
  // reservation: a retry could deliver the same forward a second time. The rule simply never
  // retries this message again.
  it('leaves the reservation pending after an uncertain delivery failure, so no retry follows', async () => {
    let reservationStatus = null;
    transport.sendMail.mockRejectedValueOnce(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' }));
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts')) return SENDABLE;
      if (sql.includes('INSERT INTO inbox_rule_forwards')) {
        if (reservationStatus) return { rows: [] };
        reservationStatus = 'pending';
        return { rows: [{ id: 'delivery-1' }] };
      }
      if (sql.includes('SELECT status')) {
        return { rows: [{ status: reservationStatus }] };
      }
      if (sql.includes('FROM messages')) {
        return { rows: [messageRow] };
      }
      if (sql.includes('DELETE FROM inbox_rule_forwards')) {
        reservationStatus = null;
        return { rows: [] };
      }
      throw new Error('Unexpected query');
    });

    await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery uncertain — leaving it pending to avoid a duplicate');
    expect(reservationStatus).toBe('pending');

    // The tick calling this again for the same rule+message (its normal retry path) must not
    // attempt a second send while the outcome of the first is unknown.
    await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery pending');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });

  // An OAuthTokenError from sendMail's own forced token refresh (Gmail via
  // mailSendTransport.js, or Microsoft via smtpTransport.js's createOAuthSmtpTransport) has no
  // responseCode and no message smtpFailureIsDefinite's regex matches — AUTH (or the equivalent
  // API request) never got far enough to deliver anything, so sendFailureIsDefinite (extended to
  // recognize the OAUTH_SEND_FAILURES codes) must still call this definite and clear the
  // reservation rather than leaving it pending forever.
  it('clears the reservation for an OAuthTokenError thrown during sendMail (both Gmail and Microsoft mailboxes)', async () => {
    const { OAuthTokenError } = await import('./oauth/tokenManager.js');
    let reservationStatus = null;
    transport.sendMail.mockRejectedValueOnce(new OAuthTokenError('oauth_reconnect_required'));
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts')) return SENDABLE;
      if (sql.includes('INSERT INTO inbox_rule_forwards')) {
        if (reservationStatus) return { rows: [] };
        reservationStatus = 'pending';
        return { rows: [{ id: 'delivery-1' }] };
      }
      if (sql.includes('FROM messages')) {
        return { rows: [messageRow] };
      }
      if (sql.includes('DELETE FROM inbox_rule_forwards')) {
        reservationStatus = null;
        return { rows: [] };
      }
      throw new Error('Unexpected query');
    });

    await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery failed');
    expect(reservationStatus).toBeNull();
  });

  // Every forward gets a reservation and the same source row.
  function reserveEveryForward() {
    query.mockImplementation(async sql => ({
      rows: sql.includes('FROM email_accounts')
        ? SENDABLE.rows
        : sql.includes('INSERT INTO inbox_rule_forwards')
          ? [{ id: 'delivery-1' }]
          : sql.includes('FROM messages') ? [messageRow] : [],
    }));
  }

  it('stops a forward that comes back to a mailbox that already forwarded it (A -> B -> A)', async () => {
    const other = { ...account, id: 'account-2', email_address: 'other@example.org' };
    reserveEveryForward();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // A forwards to B; B's rule forwards the copy back to A.
      await expect(forwardRuleMessage({ ...input, recipient: other.email_address })).resolves.toBe('sent');
      let parsedHeaders = await deliveredHeaders(transport.sendMail.mock.calls[0][0]);
      await expect(forwardRuleMessage({
        ...input, ruleId: 'rule-2', account: other, recipient: account.email_address,
        message: { id: 'message-2', parsedHeaders },
      })).resolves.toBe('sent');
      parsedHeaders = await deliveredHeaders(transport.sendMail.mock.calls[1][0]);
      const queriesBeforeReturn = query.mock.calls.length;

      // Back at A: A's token is on it, so A does not send it round again.
      await expect(forwardRuleMessage({
        ...input, message: { id: 'message-3', parsedHeaders }, recipient: other.email_address,
      })).resolves.toBe('loop');

      expect(query).toHaveBeenCalledTimes(queriesBeforeReturn);   // no reservation, no DB read
      expect(transport.sendMail).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.flat().join(' ');
      for (const box of [account, other]) expect(logged).not.toContain(box.email_address);
    } finally {
      warn.mockRestore();
    }
  });

  it('stops a loop through several mailboxes and passes on only well-formed tokens', async () => {
    const upstream = { ...account, id: 'account-0', email_address: 'upstream@example.net' };
    const second = { ...account, id: 'account-2', email_address: 'second@example.org' };
    const third = { ...account, id: 'account-3', email_address: 'third@example.org' };
    const hops = [[upstream, account], [account, second], [second, third], [third, account]];
    reserveEveryForward();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      let parsedHeaders;
      for (const [index, [from, to]] of hops.entries()) {
        await expect(forwardRuleMessage({
          ...input,
          ruleId: `rule-${index}`,
          account: from,
          recipient: to.email_address,
          message: { id: `message-${index}`, parsedHeaders },
        })).resolves.toBe('sent');
        parsedHeaders = await deliveredHeaders(transport.sendMail.mock.calls[index][0]);
      }

      await expect(forwardRuleMessage({
        ...input, recipient: second.email_address, message: { id: 'message-4', parsedHeaders },
      })).resolves.toBe('loop');
      expect(transport.sendMail).toHaveBeenCalledTimes(hops.length);
      const tokens = parsedHeaders['x-mailexpert-loop'].split(', ');
      expect(tokens).toHaveLength(hops.length);
      expect(new Set(tokens).size).toBe(hops.length);
      for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{16}$/);

      // Junk in a sender-supplied header is not passed on.
      await expect(forwardRuleMessage({
        ...input,
        message: { id: 'message-5', parsedHeaders: parseRawHeaders(`X-MailExpert-Loop: ${'ab'.repeat(8)}, mailbox@example.com, zz`) },
      })).resolves.toBe('sent');
      const delivered = await deliveredHeaders(transport.sendMail.mock.calls.at(-1)[0]);
      expect(delivered['x-mailexpert-loop']).toMatch(new RegExp(`^${'ab'.repeat(8)}, [0-9a-f]{16}$`));
    } finally {
      warn.mockRestore();
    }
  });

  it('stops a loop through ten mailboxes, and the header stays at ten tokens', async () => {
    const mailboxes = Array.from({ length: 10 }, (_, index) => ({
      ...account, id: `account-${index}`, email_address: `mailbox${index}@example.org`,
    }));
    reserveEveryForward();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      let parsedHeaders;
      for (const [index, from] of mailboxes.entries()) {
        await expect(forwardRuleMessage({
          ...input,
          ruleId: `rule-${index}`,
          account: from,
          recipient: mailboxes[(index + 1) % mailboxes.length].email_address,
          message: { id: `message-${index}`, parsedHeaders },
        })).resolves.toBe('sent');
        parsedHeaders = await deliveredHeaders(transport.sendMail.mock.calls[index][0]);
      }
      expect(parsedHeaders['x-mailexpert-loop'].split(', ')).toHaveLength(10);

      await expect(forwardRuleMessage({
        ...input, account: mailboxes[0], recipient: mailboxes[1].email_address,
        message: { id: 'message-10', parsedHeaders },
      })).resolves.toBe('loop');
    } finally {
      warn.mockRestore();
    }
  });

  it('a sender cannot stop the forward with a forged or padded loop header', async () => {
    reserveEveryForward();
    const address = account.email_address;
    // Guesses a sender can make without the instance key: plain hashes of the address, HMACs
    // under other keys, and any number of well-formed tokens.
    const guesses = [
      createHash('sha256').update(`mailflow-loop:${address}`).digest('hex').slice(0, 16),
      createHash('sha256').update(`mailexpert-loop:${address}`).digest('hex').slice(0, 16),
      createHash('sha256').update(address).digest('hex').slice(0, 16),
      createHmac('sha256', Buffer.alloc(32)).update(address).digest('hex').slice(0, 16),
      createHmac('sha256', Buffer.from(KEY, 'hex')).update(address).digest('hex').slice(0, 16),
      createHmac('sha256', Buffer.from(OTHER_KEY, 'hex')).update(address).digest('hex').slice(0, 16),
      ...Array.from({ length: 20 }, (_, i) => (i % 16).toString(16).repeat(16)),
    ];

    await expect(forwardRuleMessage({
      ...input,
      message: { id: 'message-forged', parsedHeaders: parseRawHeaders(`X-MailExpert-Loop: ${guesses.join(', ')}`) },
    })).resolves.toBe('sent');

    // The header stays bounded: the newest nine received plus this mailbox's own.
    const delivered = await deliveredHeaders(transport.sendMail.mock.calls[0][0]);
    const tokens = delivered['x-mailexpert-loop'].split(', ');
    expect(tokens).toHaveLength(10);
    expect(tokens.slice(0, 9)).toEqual(guesses.slice(-9));
  });

  it('an external forward is unaffected: no loop header on the source, sent as before', async () => {
    reserveEveryForward();
    await expect(forwardRuleMessage({
      ...input, message: { id: messageRow.id, parsedHeaders: parseRawHeaders('Subject: hi\r\nFrom: someone@example.net') },
    })).resolves.toBe('sent');
    const delivered = await deliveredHeaders(transport.sendMail.mock.calls[0][0]);
    expect(delivered['x-mailexpert-loop']).toMatch(/^[0-9a-f]{16}$/);
    expect(delivered.to).toBe('recipient@example.com');
  });

  it('a mailbox that is disabled still refuses after the loop check passes', async () => {
    query.mockResolvedValueOnce({ rows: [{ enabled: false, mail_node: false, delete_after: null, deactivated_at: null }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(forwardRuleMessage({
        ...input, message: { id: messageRow.id, parsedHeaders: parseRawHeaders(`X-MailExpert-Loop: ${'ab'.repeat(8)}`) },
      })).resolves.toBe('disabled');
      expect(transport.sendMail).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
