import { readFileSync } from 'node:fs';
import { TenantError, checkExoOp } from './exoRunner.js';

// Fakes of the two transports (R-22, "без EOP: да"): an ExoRunner that answers the recorded JSON of
// fixtures.json, and a fetch for the Microsoft login endpoint and Graph. Tests drive them directly;
// TENANT_DRIVER=fake selects them for the stand and the demo backend (services/tenant/driver.js).
// They check what they are given the way the real ones do: the whitelist and its values, the
// thumbprint against the worker's certificate, the token request's form and the bearer token.

export const TENANT_FIXTURES = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// The real worker always knows its certificate; a test that makes the certificate read fail
// (certificateInfo an Error) does not make every call a mismatch.
const differs = (fake, tenant) => !(fake.certificateInfo instanceof Error) && tenant?.thumbprint !== fake.certificateInfo.thumbprint;
const mismatch = () => new TenantError('certificate_mismatch', 'The thumbprint in the panel is not the worker certificate\'s', { status: 409 });

// answers: { op: result | (args) => result | TenantError } over the fake tenant's (model, stage
// 7b operations) and the recorded ones (tests change fake.answers and fake.certificateInfo as they
// go); calls: the operations that ran.
export function createFakeExoRunner({ answers = {}, certificate = TENANT_FIXTURES.worker.certificate, model = null } = {}) {
  const fake = {
    kind: 'fake',
    model,
    calls: [],
    answers: { ...answers },
    certificateInfo: { ...certificate },
    async certificate() {
      if (fake.certificateInfo instanceof Error) throw fake.certificateInfo;
      return clone(fake.certificateInfo);
    },
    async assertion(tenant) {
      if (differs(fake, tenant)) throw mismatch();
      return { assertion: `fake.${Buffer.from(JSON.stringify({ aud: tenant.tenantId, iss: tenant.appId })).toString('base64url')}.sig`, expiresAt: null };
    },
    async run(tenant, op, args = {}) {
      const checked = checkExoOp(op, args);
      fake.calls.push({ op, args: checked, organization: tenant?.organization ?? null });
      if (differs(fake, tenant)) throw mismatch();
      let answer = TENANT_FIXTURES.exo[op];
      if (Object.hasOwn(fake.answers, op)) answer = fake.answers[op];
      else if (fake.model && Object.hasOwn(fake.model.exo, op)) answer = fake.model.exo[op];
      const value = typeof answer === 'function' ? await answer(checked) : answer;
      if (value instanceof Error) throw value;
      return clone(value);
    },
  };
  return fake;
}

const json = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

// A fetch for the token endpoint and Graph. graph: { 'GET /domains': body | (url) => Response };
// token: the token answer or a function of the form; model: the fake tenant, answering what graph
// does not. requests: what was asked (no secrets kept).
export function createFakeGraphFetch({ graph = {}, token = TENANT_FIXTURES.graph.token, model = null } = {}) {
  const requests = [];
  const routes = { ...(model ? {} : { 'GET /domains': TENANT_FIXTURES.graph.domains }), ...graph };
  const accessToken = () => (typeof token === 'object' && token ? token.access_token : null);
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    const method = options.method ?? 'GET';
    if (/\/oauth2\/v2\.0\/token$/.test(target.pathname)) {
      const form = new URLSearchParams(String(options.body ?? ''));
      requests.push({ kind: 'token', tenant: target.pathname.split('/')[1], clientId: form.get('client_id'), scope: form.get('scope') });
      if (form.get('grant_type') !== 'client_credentials'
        || form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        || !form.get('client_assertion')) {
        return json(400, { error: 'invalid_request', error_description: 'AADSTS900144: The request body must contain client_assertion.' });
      }
      const answer = typeof token === 'function' ? await token(form) : token;
      return answer instanceof Response ? answer : json(200, answer);
    }
    const path = target.pathname.replace(/^\/v1\.0/, '');
    requests.push({ kind: 'graph', method, path, query: target.search });
    if (options.headers?.Authorization !== `Bearer ${accessToken()}` && typeof token === 'object') {
      return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } });
    }
    const route = routes[`${method} ${path}`];
    if (route === undefined && model) {
      let body;
      try {
        body = options.body ? JSON.parse(String(options.body)) : undefined;
      } catch {
        return json(400, { error: { code: 'BadRequest', message: 'Unreadable body' } });
      }
      const answer = model.graph(method, path, body, target);
      if (answer) return answer.status === 204 ? new Response(null, { status: 204 }) : json(answer.status, answer.body);
    }
    if (route === undefined) return json(404, { error: { code: 'Request_ResourceNotFound', message: 'Not found' } });
    const answer = typeof route === 'function' ? await route(target, options) : route;
    return answer instanceof Response ? answer : json(200, answer);
  };
  return { fetchImpl, requests };
}

// --- the fake tenant (stage 7b) ----------------------------------------------------------------
//
// A small tenant that keeps what the writes did, so a domain's onboarding and the recipient mirror
// can run end to end without Microsoft: Graph domains (add, verification records, verify, Email
// service, service records), accepted domains (seen by EXO a few reads after the verification, as
// the tenant's undocumented delay), the connectors of fixtures.json, EOP DKIM configs and mail
// contacts. Answers are in the shapes of fixtures.json. options (tests change them as they go):
//   verifiable          POST /verify succeeds (the TXT is published)
//   acceptedDelayReads  Get-AcceptedDomain reads that miss a verified domain before it shows
//   dkimPublished       Set-DkimSigningConfig -Enabled $true succeeds (the CNAMEs are published)
//   mxForm              'classic' (<domain>.mail.protection.outlook.com) or 'mx_microsoft'
//   defaultType         the accepted domain type a new domain gets ('Authoritative', section 2.8)

const exoError = (code, message) => new TenantError(code, message, { status: 502 });
const dashed = (domain) => domain.replace(/\./g, '-');
// A stable verification value per domain, MS=ms + 8 digits.
const txtOf = (domain) => `MS=ms${String([...domain].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100000000, 7)).padStart(8, '0')}`;

export function createFakeTenantModel(options = {}) {
  const model = {
    options: {
      verifiable: true, acceptedDelayReads: 0, dkimPublished: true, mxForm: 'classic', defaultType: 'Authoritative', ...options,
    },
    domains: new Map(),
    accepted: new Map(),
    inbound: clone(TENANT_FIXTURES.exo.get_inbound_connectors),
    outbound: clone(TENANT_FIXTURES.exo.get_outbound_connectors),
    dkim: new Map(),
    recipients: new Map(),
    // Stage 7c: the quarantine by Identity (Get-QuarantineMessage -Identity rows), the releases in
    // order, and the message trace rows (Graph shapes) with their details by '<id>|<recipient>'.
    quarantine: new Map(),
    released: [],
    traces: [],
    traceDetails: {},
  };

  // A recipient of another kind (a cloud mailbox, a group) holding an address: tests add them.
  model.addRecipient = (row) => model.recipients.set(String(row.PrimarySmtpAddress).toLowerCase(), clone(row));

  const graphDomain = (domain) => ({ ...clone(TENANT_FIXTURES.graph.domain), ...domain });
  const notFound = () => ({ status: 404, body: { error: { code: 'Request_ResourceNotFound', message: 'Resource does not exist.' } } });
  const records = (template, fill) => ({ ...clone(template), value: fill(clone(template.value)) });

  model.graph = (method, path, body, target = null) => {
    if (method === 'GET' && path === '/admin/exchange/tracing/messageTraces') return model.listTraces(target);
    const detailsOf = /^\/admin\/exchange\/tracing\/messageTraces\/([^/]+)\/getDetailsByRecipient\(recipientAddress='(.*)'\)$/.exec(decodeURIComponent(path));
    if (method === 'GET' && detailsOf) {
      const recipient = detailsOf[2].replace(/''/g, "'").toLowerCase();
      const events = model.traceDetails[`${detailsOf[1]}|${recipient}`];
      return events ? { status: 200, body: { value: clone(events) } } : notFound();
    }
    if (method === 'GET' && path === '/domains') {
      return { status: 200, body: { ...clone(TENANT_FIXTURES.graph.domains), value: [...TENANT_FIXTURES.graph.domains.value.filter((d) => d.isInitial), ...[...model.domains.values()].map(graphDomain)] } };
    }
    if (method === 'POST' && path === '/domains') {
      const id = String(body?.id ?? '').toLowerCase();
      // The answer to a domain the tenant has already is not documented (Inferred).
      if (model.domains.has(id)) return { status: 400, body: { error: { code: 'Request_BadRequest', message: 'Another object with the same value for property id already exists.' } } };
      model.domains.set(id, { id, isVerified: false, supportedServices: [] });
      return { status: 201, body: graphDomain(model.domains.get(id)) };
    }
    const match = /^\/domains\/([^/]+)(?:\/(\w+))?$/.exec(path);
    if (!match) return undefined;
    const id = decodeURIComponent(match[1]).toLowerCase();
    const domain = model.domains.get(id);
    if (!domain) return notFound();
    const part = match[2] ?? null;
    if (method === 'GET' && !part) return { status: 200, body: graphDomain(domain) };
    if (method === 'PATCH' && !part) {
      if (Array.isArray(body?.supportedServices)) domain.supportedServices = [...body.supportedServices];
      return { status: 204, body: null };
    }
    if (method === 'GET' && part === 'verificationDnsRecords') {
      return { status: 200, body: records(TENANT_FIXTURES.graph.verificationDnsRecords, (value) => value.map((r) => ({ ...r, label: id, ...(r.recordType === 'Txt' ? { text: txtOf(id) } : {}) }))) };
    }
    if (method === 'POST' && part === 'verify') {
      if (!model.options.verifiable) {
        // The refusal's wording is not documented (Inferred): a 400 the panel reads as "not yet".
        return { status: 400, body: { error: { code: 'Request_BadRequest', message: 'Domain verification failed. The TXT record was not found.' } } };
      }
      if (!domain.isVerified) {
        domain.isVerified = true;
        model.accepted.set(id, { type: model.options.defaultType, misses: model.options.acceptedDelayReads });
      }
      return { status: 200, body: graphDomain(domain) };
    }
    if (method === 'GET' && part === 'serviceConfigurationRecords') {
      if (!domain.isVerified) return { status: 200, body: { ...clone(TENANT_FIXTURES.graph.serviceConfigurationRecords), value: [] } };
      const mx = model.options.mxForm === 'mx_microsoft' ? `${dashed(id)}.n-v1.mx.microsoft` : `${dashed(id)}.mail.protection.outlook.com`;
      return {
        status: 200,
        body: records(TENANT_FIXTURES.graph.serviceConfigurationRecords, (value) => value.map((r) => ({
          ...r, label: r.recordType === 'CName' ? `autodiscover.${id}` : id, ...(r.recordType === 'Mx' ? { mailExchange: mx } : {}),
        }))),
      };
    }
    return undefined;
  };

  const accepted = (domain) => {
    const entry = model.accepted.get(domain);
    if (!entry) throw exoError('exo_not_found', `The operation couldn't be performed because object '${domain}' couldn't be found.`);
    if (entry.misses > 0) {
      entry.misses -= 1;
      throw exoError('exo_not_found', `The operation couldn't be performed because object '${domain}' couldn't be found.`);
    }
    return entry;
  };
  const acceptedRow = (domain, entry) => ({ DomainName: domain, DomainType: entry.type, Default: false, Identity: domain });
  const dkimRow = (domain, entry) => ({
    ...clone(TENANT_FIXTURES.exo.get_dkim_signing_config[0]), Identity: domain, Domain: domain, Enabled: entry.enabled,
    Status: entry.enabled ? 'Valid' : 'CnameMissing',
    Selector1CNAME: `selector1-${dashed(domain)}._domainkey.contoso.n-v1.dkim.mail.microsoft`,
    Selector2CNAME: `selector2-${dashed(domain)}._domainkey.contoso.n-v1.dkim.mail.microsoft`,
  });
  const byConnector = (id) => model.outbound.find((c) => String(c.Guid ?? '').toLowerCase() === id.toLowerCase());
  // A connector the tests add: a Guid of its own.
  model.addOutbound = (props) => {
    const n = model.outbound.length + 1;
    model.outbound.push({ ...clone(TENANT_FIXTURES.exo.get_outbound_connectors[0]), RecipientDomains: [], Guid: `4b1d2c3e-5f60-4718-8a9b-0c1d2e3f4a${String(n).padStart(2, '0')}`, ...props });
  };

  // --- stage 7c: the message trace (Graph) and the quarantine (EXO) ---

  // GET messageTraces as Learn documents it: both receivedDateTime bounds (at most 10 days apart),
  // $top up to 5000 (1000 by default), the next page by @odata.nextLink. Without bounds Graph
  // answers the last 48 hours; the panel always sends both, so the fake refuses a request without.
  model.listTraces = (target) => {
    const params = target?.searchParams ?? new URLSearchParams();
    const filter = params.get('$filter') ?? '';
    const ge = /receivedDateTime ge (\S+)/.exec(filter)?.[1];
    const le = /receivedDateTime le (\S+)/.exec(filter)?.[1];
    const from = Date.parse(ge);
    const to = Date.parse(le);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 10 * 24 * 3600 * 1000) {
      return { status: 400, body: { error: { code: 'BadRequest', message: 'The time interval must not exceed 10 days.' } } };
    }
    const top = Math.min(5000, Math.max(1, Number(params.get('$top')) || 1000));
    const skip = Number(params.get('$skiptoken')) || 0;
    const rows = model.traces.filter((row) => {
      const at = Date.parse(row.receivedDateTime);
      return at >= from && at <= to;
    });
    const page = rows.slice(skip, skip + top);
    const body = { value: clone(page) };
    if (skip + top < rows.length) {
      const next = new URL(target.href);
      next.searchParams.set('$skiptoken', String(skip + top));
      body['@odata.nextLink'] = next.href;
    }
    return { status: 200, body };
  };

  // A quarantined message the tests add: the row Get-QuarantineMessage -Identity answers.
  model.addQuarantined = (row) => {
    const full = {
      ...clone(TENANT_FIXTURES.exo.get_quarantine_message[0]), Released: false, ReleasedUser: [], ...clone(row),
    };
    model.quarantine.set(String(full.Identity).toLowerCase(), full);
    return full;
  };
  const quarantined = (identity) => {
    const row = model.quarantine.get(identity);
    if (!row) throw exoError('exo_not_found', `The operation couldn't be performed because object '${identity}' couldn't be found.`);
    return row;
  };
  const isNotReleased = (row) => String(row.ReleaseStatus).toLowerCase() === 'notreleased';

  // The worker's release guard (runner.lib.ps1 Test-ReleasableInbound): inbound; QuarantineTypes
  // (or Type when it is empty) all releasable; no forbidden word in any of them.
  const RELEASABLE = ['highconfphish', 'phish', 'spam', 'highconfspam', 'bulk'];
  const FORBIDDEN = ['malware', 'transportrule', 'filetype', 'datalossprevention'];
  const token = (value) => {
    const t = String(value).toLowerCase().replace(/[^a-z]/g, '');
    return {
      highconfidencephish: 'highconfphish', highconfidencephishing: 'highconfphish', phishing: 'phish', highconfidencespam: 'highconfspam',
    }[t] ?? t;
  };
  const present = (value) => [value].flat().filter((v) => v != null && String(v).trim() !== '');
  const releasable = (row) => {
    const kinds = present(row.QuarantineTypes);
    const typeText = present(row.Type);
    if ([...kinds, ...typeText].map(token).some((t) => FORBIDDEN.some((w) => t.includes(w)))) return false;
    const deciding = (kinds.length ? kinds : typeText.slice(0, 1)).map(token);
    return row.Direction === 'Inbound' && deciding.length > 0 && deciding.every((t) => RELEASABLE.includes(t));
  };
  const LISTED = ['HighConfPhish', 'Phish', 'Spam', 'Bulk'];

  // The Default anti-spam policy (R-28), as fixtures.json has it; the set operations of section 5.14
  // change one action each. writesIgnored: a write the tenant accepts without applying it (the
  // panel must notice by reading again).
  model.policy = clone(TENANT_FIXTURES.exo.get_content_filter_policy[0]);
  model.policyWrites = [];
  model.options.policyWritesIgnored = model.options.policyWritesIgnored ?? false;
  const setAction = (field) => () => {
    model.policyWrites.push(field);
    if (!model.options.policyWritesIgnored) model.policy[field] = 'MoveToJmf';
    return [];
  };

  model.exo = {
    get_content_filter_policy: () => [clone(model.policy)],
    set_spam_action_junk: setAction('SpamAction'),
    set_high_confidence_spam_action_junk: setAction('HighConfidenceSpamAction'),
    set_phish_spam_action_junk: setAction('PhishSpamAction'),
    set_bulk_spam_action_junk: setAction('BulkSpamAction'),
    // The summary: inbound high confidence phishing, phishing and spam not released, 100 per page;
    // no recipients.
    get_quarantine_messages: ({ page }) => {
      const rows = [...model.quarantine.values()].filter((row) => [row.QuarantineTypes].flat().some((t) => LISTED.includes(t))
        && row.Direction === 'Inbound' && isNotReleased(row));
      const start = (Number(page) - 1) * 100;
      const SUMMARY = ['Identity', 'ReceivedTime', 'SenderAddress', 'Subject', 'Type', 'QuarantineTypes', 'ReleaseStatus', 'Direction', 'MessageId', 'Expires'];
      return rows.slice(start, start + 100).map((row) => ({
        ...Object.fromEntries(SUMMARY.map((key) => [key, clone(row[key])])), RecipientCount: (row.RecipientAddress ?? []).length,
      }));
    },
    // As the worker answers it: only the message with exactly this Identity, none for an unknown one.
    get_quarantine_message: ({ identity }) => (model.quarantine.has(identity) ? [clone(model.quarantine.get(identity))] : []),
    // -ReleaseToAll, after the worker's guard (inbound spam and phishing only, quarantine_not_allowed).
    // A second release of a released message: its wording is Inferred.
    release_quarantine_message: ({ identity }) => {
      const found = model.quarantine.get(identity);
      if (!found || !releasable(found)) {
        throw exoError('quarantine_not_allowed', 'Only inbound spam and phishing are released');
      }
      const row = quarantined(identity);
      if (!isNotReleased(row)) throw exoError('exo_failed', 'The message has already been released.');
      row.ReleaseStatus = 'RELEASED';
      row.Released = true;
      row.ReleasedUser = [...(row.RecipientAddress ?? [])];
      model.released.push(identity);
      return [];
    },
    get_accepted_domain: ({ domain }) => [acceptedRow(domain, accepted(domain))],
    set_accepted_domain_internal_relay: ({ domain }) => { accepted(domain).type = 'InternalRelay'; return []; },
    set_accepted_domain_authoritative: ({ domain }) => { accepted(domain).type = 'Authoritative'; return []; },
    get_inbound_connectors: () => clone(model.inbound),
    get_outbound_connectors: () => clone(model.outbound),
    add_outbound_connector_domain: ({ connector, domain }) => {
      const found = byConnector(connector);
      if (!found) throw exoError('exo_not_found', `The operation couldn't be performed because object '${connector}' couldn't be found.`);
      if (!found.RecipientDomains.includes(domain)) found.RecipientDomains.push(domain);
      return [];
    },
    new_dkim_signing_config: ({ domain }) => {
      if (!model.accepted.has(domain)) throw exoError('exo_failed', `${domain} is not an accepted domain of your organization.`);
      if (model.dkim.has(domain)) throw exoError('exo_exists', `A DKIM signing config for ${domain} already exists.`);
      model.dkim.set(domain, { enabled: false });
      return [dkimRow(domain, model.dkim.get(domain))];
    },
    get_dkim_signing_config: ({ domain }) => {
      const entry = model.dkim.get(domain);
      if (!entry) throw exoError('exo_not_found', `The operation couldn't be performed because object '${domain}' couldn't be found.`);
      return [dkimRow(domain, entry)];
    },
    enable_dkim_signing_config: ({ domain }) => {
      const entry = model.dkim.get(domain);
      if (!entry) throw exoError('exo_not_found', `The operation couldn't be performed because object '${domain}' couldn't be found.`);
      // The wording of the refusal before the CNAMEs are published is Inferred.
      if (!model.options.dkimPublished) throw exoError('exo_failed', `CNAME record does not exist for this config. Please publish the following two CNAME records first.`);
      entry.enabled = true;
      return [];
    },
    get_recipients: () => clone([...model.recipients.values()]),
    new_mail_contact: ({ address, external }) => {
      if (model.recipients.has(address)) {
        throw exoError('exo_exists', `The proxy address "SMTP:${address}" is already being used by the proxy addresses or LegacyExchangeDN.`);
      }
      const row = {
        ...clone(TENANT_FIXTURES.exo.get_recipients[0]), Identity: address, Name: address, PrimarySmtpAddress: address,
        ExternalEmailAddress: `SMTP:${external}`, EmailAddresses: [`SMTP:${address}`], HiddenFromAddressListsEnabled: false,
      };
      model.recipients.set(address, row);
      return [{ Identity: address, Name: address, PrimarySmtpAddress: address, ExternalEmailAddress: row.ExternalEmailAddress }];
    },
    set_mail_contact_external: ({ address, external }) => {
      const row = model.recipients.get(address);
      if (!row || row.RecipientTypeDetails !== 'MailContact') throw exoError('exo_not_found', `The operation couldn't be performed because object '${address}' couldn't be found.`);
      row.ExternalEmailAddress = `SMTP:${external}`;
      return [];
    },
    hide_mail_contact: ({ address }) => {
      const row = model.recipients.get(address);
      if (!row || row.RecipientTypeDetails !== 'MailContact') throw exoError('exo_not_found', `The operation couldn't be performed because object '${address}' couldn't be found.`);
      row.HiddenFromAddressListsEnabled = true;
      return [];
    },
    remove_mail_contact: ({ address }) => {
      const row = model.recipients.get(address);
      if (!row || row.RecipientTypeDetails !== 'MailContact') throw exoError('exo_not_found', `The operation couldn't be performed because object '${address}' couldn't be found.`);
      model.recipients.delete(address);
      return [];
    },
  };
  return model;
}
