import { describe, expect, it } from 'vitest';
import { TENANT_FIXTURES } from './fakes.js';
import { acceptedWaitMs, externalOf, mxOf, pickOutboundConnector, planMirror } from './tenantDomains.js';
import { INBOUND_KEYS, OUTBOUND_KEYS, connectorDrift, summarizeConnectors } from './connectors.js';

// The pure parts of stage 7b: what the mirror must change (R-29), the MX of a verified domain
// (R-23), which Outbound connector takes new domains (R-25) and the connectors' drift from their
// reference.

const contact = (address, { external = address, hidden = true } = {}) => ({
  Identity: address, Name: address, PrimarySmtpAddress: address, ExternalEmailAddress: `SMTP:${external}`,
  EmailAddresses: [`SMTP:${address}`], RecipientTypeDetails: 'MailContact', HiddenFromAddressListsEnabled: hidden,
});
const mailbox = (email, state = 1) => ({ email, state });

describe('planMirror (R-29)', () => {
  const base = { domain: 'example.com', aliases: [], panel: [], recipients: [] };

  it('makes a contact for every mailbox that takes mail, and removes contacts nobody needs', () => {
    const plan = planMirror({
      ...base,
      mailboxes: [mailbox('a@example.com'), mailbox('b@example.com', 2), mailbox('off@example.com', 0)],
      panel: [{ email: 'a@example.com', deleting: false }, { email: 'b@example.com', deleting: false }],
      recipients: [contact('b@example.com'), contact('old@example.com'), contact('x@other.example')],
    });
    // Receiving without login (2) keeps its recipient; a disabled mailbox (0) has none.
    expect(plan.desired).toEqual(['a@example.com', 'b@example.com']);
    expect(plan.create).toEqual(['a@example.com']);
    expect(plan.present).toEqual(['b@example.com']);
    // Another domain's contact is not this domain's business.
    expect(plan.remove).toEqual(['old@example.com']);
    expect(plan.hide).toEqual([]);
  });

  it('leaves out a mailbox being deleted, so its removed contact is not made again', () => {
    const plan = planMirror({
      ...base, mailboxes: [mailbox('a@example.com')], panel: [{ email: 'a@example.com', deleting: true }], recipients: [contact('a@example.com')],
    });
    expect(plan.desired).toEqual([]);
    expect(plan.remove).toEqual(['a@example.com']);
  });

  it('mirrors node aliases, reports a catch-all and the node/panel differences', () => {
    const plan = planMirror({
      ...base,
      mailboxes: [mailbox('a@example.com'), mailbox('manual@example.com')],
      aliases: [{ address: 'sales@example.com', active: true }, { address: 'old@example.com', active: false }, { address: '@example.com', active: true }],
      panel: [{ email: 'a@example.com', deleting: false }, { email: 'gone@example.com', deleting: false }],
    });
    expect(plan.desired).toEqual(['a@example.com', 'manual@example.com', 'sales@example.com']);
    expect(plan.catchAll).toBe('@example.com');
    expect(plan.nodeOnly).toEqual(['manual@example.com']);
    expect(plan.panelOnly).toEqual(['gone@example.com']);
  });

  it('makes no contact for an address another recipient holds, and reports it', () => {
    const plan = planMirror({
      ...base,
      mailboxes: [mailbox('a@example.com'), mailbox('team@example.com')],
      recipients: [{ PrimarySmtpAddress: 'someone@example.com', EmailAddresses: ['SMTP:someone@example.com', 'smtp:team@example.com'], RecipientTypeDetails: 'UserMailbox' }],
    });
    expect(plan.create).toEqual(['a@example.com']);
    expect(plan.conflicts).toEqual(['team@example.com']);
    // A cloud recipient is never removed by the mirror.
    expect(plan.remove).toEqual([]);
  });

  it('hides a visible contact and moves one of the other D-7 variant in place', () => {
    const plan = planMirror({
      ...base,
      mailboxes: [mailbox('a@example.com'), mailbox('b@example.com')],
      recipients: [contact('a@example.com', { hidden: false }), contact('b@example.com')],
      externalDomain: 'relay.example.net',
    });
    // Never removed and made again: on an Authoritative domain the address would be rejected between.
    expect(plan.retarget).toEqual(['a@example.com', 'b@example.com']);
    expect(plan.remove).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.hide).toEqual(['a@example.com']);
    expect(plan.present).toEqual([]);
    const same = planMirror({
      ...base, mailboxes: [mailbox('a@example.com')], recipients: [contact('a@example.com', { hidden: false })],
    });
    expect(same.hide).toEqual(['a@example.com']);
  });

  it('removes nothing when the node lists no mailbox while the panel has some there', () => {
    const plan = planMirror({ ...base, mailboxes: [], panel: [{ email: 'a@example.com', deleting: false }], recipients: [contact('a@example.com')] });
    expect(plan.suspicious).toBe(true);
    expect(plan.remove).toEqual([]);
  });

  it('removes nothing when the node lists no mailbox while the tenant has contacts of the domain, the panel none', () => {
    const plan = planMirror({ ...base, mailboxes: [], recipients: [contact('manual@example.com')] });
    expect(plan.suspicious).toBe(true);
    expect(plan.remove).toEqual([]);
    expect(planMirror({ ...base, mailboxes: [] }).suspicious).toBe(false);
  });

  it('lets a disabled catch-all pass (D-6 is about mail it takes)', () => {
    const plan = planMirror({ ...base, mailboxes: [mailbox('a@example.com')], aliases: [{ address: '@example.com', active: false }] });
    expect(plan.catchAll).toBeNull();
  });
});

describe('the small rules', () => {
  it('reads both MX forms, lowest preference first (R-23)', () => {
    expect(mxOf(TENANT_FIXTURES.graph.serviceConfigurationRecords)).toEqual(['example-com.mail.protection.outlook.com']);
    expect(mxOf({
      value: [
        { recordType: 'Mx', mailExchange: 'b.example-com.n-v1.mx.microsoft.', preference: 10 },
        { recordType: 'Mx', mailExchange: 'A.example-com.n-v1.mx.microsoft', preference: 0 },
        { recordType: 'Mx', mailExchange: 'bad host', preference: 5 },
        { recordType: 'Txt', text: 'v=spf1 -all' },
      ],
    })).toEqual(['a.example-com.n-v1.mx.microsoft', 'b.example-com.n-v1.mx.microsoft']);
    expect(mxOf(null)).toEqual([]);
  });

  it('picks the Outbound connector by name, else the only OnPremises one (R-25, D-9)', () => {
    const c = (Name, ConnectorType = 'OnPremises', Enabled = true) => ({ Name, Identity: Name, ConnectorType, Enabled });
    expect(pickOutboundConnector([c('To mail node'), c('Partner', 'Partner')], null).connector.Name).toBe('To mail node');
    expect(pickOutboundConnector([c('A'), c('B')], null)).toMatchObject({ code: 'outbound_connector_ambiguous', names: ['A', 'B'] });
    expect(pickOutboundConnector([c('A'), c('B')], 'b').connector.Name).toBe('B');
    expect(pickOutboundConnector([c('A')], 'C')).toEqual({ code: 'outbound_connector_not_found' });
    expect(pickOutboundConnector([c('A', 'OnPremises', false)], null)).toMatchObject({ code: 'outbound_connector_missing' });
  });

  it('waits 1, 2, 4 ... up to 10 minutes for an accepted domain', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => acceptedWaitMs(n) / 60000)).toEqual([1, 2, 4, 8, 10, 10]);
  });

  it('builds the external address of either D-7 variant', () => {
    expect(externalOf('info@example.com', null)).toBe('info@example.com');
    expect(externalOf('info@example.com', 'relay.example.net')).toBe('info@relay.example.net');
  });
});

describe('connectorDrift (R-25)', () => {
  const read = (rows, keys, domains) => summarizeConnectors(rows, keys, { domains });
  const reference = {
    inbound: read(TENANT_FIXTURES.exo.get_inbound_connectors, INBOUND_KEYS),
    outbound: read(TENANT_FIXTURES.exo.get_outbound_connectors, OUTBOUND_KEYS, true),
  };

  it('finds nothing in the same read, nor in new RecipientDomains', () => {
    const outbound = TENANT_FIXTURES.exo.get_outbound_connectors.map((c) => ({ ...c, RecipientDomains: [...c.RecipientDomains, 'example.com'] }));
    expect(connectorDrift(reference, { ok: true, inbound: reference.inbound, outbound: read(outbound, OUTBOUND_KEYS, true) })).toEqual([]);
  });

  it('names a changed property, a connector gone and one added', () => {
    const inbound = TENANT_FIXTURES.exo.get_inbound_connectors.map((c) => ({ ...c, TlsSenderCertificateName: 'other.example.com' }));
    const outbound = [{ Name: 'Partner', ConnectorType: 'Partner' }];
    expect(connectorDrift(reference, { ok: true, inbound: read(inbound, INBOUND_KEYS), outbound: read(outbound, OUTBOUND_KEYS, true) })).toEqual([
      { direction: 'inbound', name: 'From mail node', kind: 'changed', changes: [{ property: 'TlsSenderCertificateName', was: 'mail.example.com', now: 'other.example.com' }] },
      { direction: 'outbound', name: 'To mail node', kind: 'missing' },
      { direction: 'outbound', name: 'Partner', kind: 'added' },
    ]);
  });

  it('says nothing without a reference or a good read', () => {
    expect(connectorDrift(null, { ok: true, inbound: [], outbound: [] })).toEqual([]);
    expect(connectorDrift(reference, { ok: false })).toEqual([]);
  });
});
