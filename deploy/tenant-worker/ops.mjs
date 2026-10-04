// The whitelist of the tenant worker (R-36): the only Exchange Online PowerShell operations it runs,
// with the parameters each takes and how they are checked. Nothing else reaches pwsh: an unknown
// operation, an unknown parameter or a value that fails its check is refused here, before the
// request is written to the pwsh runner. The runner (runner.ps1) has the same table and splats the
// checked values as parameters; no command text is ever built from them.
//
// The value rules are those of the panel (backend/src/services/mailNode/mailcow.js parseHostName and
// parseLocalPart): a domain is lower-case LDH labels with a letter TLD, a local part is letters,
// digits, dot, dash and underscore. Quotes, ';', '$', '(', ')', '`', spaces and line breaks can
// never pass them.

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A quarantined message's Identity: GUID1\GUID2 (Get-QuarantineMessage, Release-QuarantineMessage).
const QUARANTINE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A page number of Get-QuarantineMessage (1 to 1000), sent as a digit string like every value.
const PAGE_RE = /^(?:[1-9][0-9]{0,2}|1000)$/;

// Values are taken as given apart from case: a value with spaces around it is refused, not trimmed,
// so what reaches pwsh is exactly what was checked.
export function parseDomain(value) {
  if (typeof value !== 'string') return null;
  const host = value.toLowerCase();
  return HOST_RE.test(host) ? host : null;
}

export function parseAddress(value) {
  if (typeof value !== 'string') return null;
  const text = value.toLowerCase();
  const at = text.lastIndexOf('@');
  if (at < 1) return null;
  const local = text.slice(0, at);
  const domain = parseDomain(text.slice(at + 1));
  return LOCAL_PART_RE.test(local) && !local.includes('..') && domain ? `${local}@${domain}` : null;
}

export function parseGuid(value) {
  if (typeof value !== 'string') return null;
  const id = value.toLowerCase();
  return GUID_RE.test(id) ? id : null;
}

// The organization Connect-ExchangeOnline takes: the tenant's initial domain, <TENANT>.onmicrosoft.com.
export function parseOrganization(value) {
  const domain = parseDomain(value);
  return domain && domain.endsWith('.onmicrosoft.com') ? domain : null;
}

// Stage 7c (R-42).
export function parseQuarantineId(value) {
  if (typeof value !== 'string') return null;
  const id = value.toLowerCase();
  return QUARANTINE_ID_RE.test(id) ? id : null;
}

export function parsePage(value) {
  return typeof value === 'string' && PAGE_RE.test(value) ? value : null;
}

const KINDS = {
  domain: parseDomain, address: parseAddress, guid: parseGuid, quarantine_id: parseQuarantineId, page: parsePage,
};

// op -> { cmdlets: what Connect-ExchangeOnline -CommandName loads for it, params: { name: kind } }.
// The cmdlet calls themselves live in runner.ps1, keyed by the same op names.
export const OPS = Object.freeze({
  // The connection test: the organization the session reached.
  whoami: { cmdlets: ['Get-OrganizationConfig'], params: {} },
  // R-27: blocked inbound connectors (an empty list is the normal answer).
  get_blocked_connector: { cmdlets: ['Get-BlockedConnector'], params: {} },
  // R-28: the default anti-spam policy, read.
  get_content_filter_policy: { cmdlets: ['Get-HostedContentFilterPolicy'], params: {} },
  // R-28, owner's decision after stage 7 (section 5.14): the Default policy's action for one
  // verdict set to MoveToJmf (deliver with the verdict headers, the node files it into Junk). One
  // op per field, nothing but the field and the value fixed in runner.lib.ps1, no arguments.
  // HighConfidencePhishAction cannot take MoveToJmf (Learn) and has no op.
  set_spam_action_junk: { cmdlets: ['Set-HostedContentFilterPolicy'], params: {} },
  set_high_confidence_spam_action_junk: { cmdlets: ['Set-HostedContentFilterPolicy'], params: {} },
  set_phish_spam_action_junk: { cmdlets: ['Set-HostedContentFilterPolicy'], params: {} },
  set_bulk_spam_action_junk: { cmdlets: ['Set-HostedContentFilterPolicy'], params: {} },
  // Read only, for stage 7b (R-24): whether a domain is an accepted domain and of which type.
  get_accepted_domain: { cmdlets: ['Get-AcceptedDomain'], params: { domain: 'domain' } },
  // Stage 7b. R-24 and R-29: the accepted domain's type (the type is fixed by the operation).
  set_accepted_domain_internal_relay: { cmdlets: ['Set-AcceptedDomain'], params: { domain: 'domain' } },
  set_accepted_domain_authoritative: { cmdlets: ['Set-AcceptedDomain'], params: { domain: 'domain' } },
  // R-25: the connectors, read for the reference and the comparison; a domain added to the
  // Outbound connector's RecipientDomains (@{Add=...}, the others stay), the connector named by its
  // Guid (an EAC name may hold any character).
  get_inbound_connectors: { cmdlets: ['Get-InboundConnector'], params: {} },
  get_outbound_connectors: { cmdlets: ['Get-OutboundConnector'], params: {} },
  add_outbound_connector_domain: { cmdlets: ['Set-OutboundConnector'], params: { connector: 'guid', domain: 'domain' } },
  // R-26: EOP DKIM of a domain: made disabled with a 2048-bit key, read, enabled.
  new_dkim_signing_config: { cmdlets: ['New-DkimSigningConfig'], params: { domain: 'domain' } },
  get_dkim_signing_config: { cmdlets: ['Get-DkimSigningConfig'], params: { domain: 'domain' } },
  enable_dkim_signing_config: { cmdlets: ['Set-DkimSigningConfig'], params: { domain: 'domain' } },
  // R-29: the recipient mirror (DBEB): every recipient of the tenant, and mail contacts made
  // (named by their address), hidden from the address lists and removed.
  get_recipients: { cmdlets: ['Get-Recipient'], params: {} },
  new_mail_contact: { cmdlets: ['New-MailContact'], params: { address: 'address', external: 'address' } },
  set_mail_contact_external: { cmdlets: ['Set-MailContact'], params: { address: 'address', external: 'address' } },
  hide_mail_contact: { cmdlets: ['Set-MailContact'], params: { address: 'address' } },
  remove_mail_contact: { cmdlets: ['Remove-MailContact'], params: { address: 'address' } },
  // Stage 7c, R-42 (decision D-2), widened by the owner's decision after stage 7 (section 5.14):
  // the spam and phishing EOP quarantined, released to the node's mailboxes by the panel. The list
  // is fixed to inbound HighConfPhish, Phish, Spam and Bulk (high confidence spam is listed as Spam:
  // Learn's QuarantineTypes has no value of its own for it) not yet released, a page of 100 at a
  // time; one message is read by its Identity (only then are its recipients shown; only the item
  // with exactly that Identity is answered) and released to all its original recipients. The
  // release reads the message again in runner.lib.ps1 and refuses (quarantine_not_allowed) unless
  // it is inbound, every QuarantineTypes value (Type when there is none) is HighConfPhish, Phish,
  // Spam, HighConfSpam or Bulk and no type names malware, a mail flow rule, a file type or DLP, so
  // those are never released; -User,
  // -AllowSender and the Tenant Allow/Block List of R-31 are not reachable.
  get_quarantine_messages: { cmdlets: ['Get-QuarantineMessage'], params: { page: 'page' } },
  get_quarantine_message: { cmdlets: ['Get-QuarantineMessage'], params: { identity: 'quarantine_id' } },
  release_quarantine_message: { cmdlets: ['Release-QuarantineMessage'], params: { identity: 'quarantine_id' } },
});

export const COMMAND_NAMES = Object.freeze([...new Set(Object.values(OPS).flatMap((op) => op.cmdlets))].sort());

export class OpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// { op, args } as the panel sent them -> the checked arguments, or an OpError. Every parameter of
// the operation is required; one it does not take is refused.
export function checkOp(op, args) {
  if (typeof op !== 'string' || !Object.hasOwn(OPS, op)) throw new OpError('unknown_op', 'Unknown operation', 404);
  const spec = OPS[op];
  const given = args == null ? {} : args;
  if (typeof given !== 'object' || Array.isArray(given)) throw new OpError('invalid_args', 'Arguments must be an object');
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(spec.params, name)) throw new OpError('invalid_args', `Unknown argument ${name.slice(0, 40)}`);
  }
  const checked = {};
  for (const [name, kind] of Object.entries(spec.params)) {
    const value = KINDS[kind](given[name]);
    if (value == null) throw new OpError('invalid_args', `Argument ${name} is not a valid ${kind}`);
    checked[name] = value;
  }
  return checked;
}

// The tenant a call is for, as the panel sends it: { tenantId, appId, organization, thumbprint }.
export function checkTenant(tenant) {
  const t = tenant && typeof tenant === 'object' ? tenant : {};
  const checked = {
    tenantId: parseGuid(t.tenantId),
    appId: parseGuid(t.appId),
    organization: parseOrganization(t.organization),
    thumbprint: typeof t.thumbprint === 'string' && /^[0-9A-Fa-f]{40}$/.test(t.thumbprint) ? t.thumbprint.toUpperCase() : null,
  };
  for (const [field, value] of Object.entries(checked)) {
    if (value == null) throw new OpError('invalid_tenant', `Tenant ${field} is missing or invalid`);
  }
  return checked;
}
