import { recordAudit } from '../auditLog.js';
import { auditOf } from '../actor.js';
import { checkMailNodeDisk } from './diskWatch.js';
import {
  DEFAULT_DELETE_AFTER_DAYS,
  DEFAULT_QUOTA_MB,
  MAX_DELETE_AFTER_DAYS,
  MAX_QUOTA_MB,
  MailNodeError,
  getMailNodeConfig,
  listDomains,
  parseHostName,
  parseNetworkList,
  parsePingUrl,
  parseWholeNumber,
  saveMailNodeConfig,
} from './mailcow.js';
import {
  EOP_FIELDS,
  eopSettingsConflict,
  getEopSettings,
  parseEopSettings,
  saveEopSettings,
  tenantConfigured,
  tenantDriverActive,
} from './eopSettings.js';
import { applyInBackground, applyNode, applyQuietly } from './nodeApply.js';
import { closeFulfilledRequests, seatSupply, withSeatLicenses } from './eopSeats.js';
import { readPostfixLog } from './postfixLog.js';
import { TERRL_WINDOW_MS, aliasDomainsOf, computeTerrlBudget } from './terrl.js';
import { getTenantDriver } from '../tenant/driver.js';

// The administrator's actions on the mail node settings and the EOP settings that routes/mailNode.js
// and the panel CLI (src/cli/mailexpert.js) share. They answer a result or { error: code } (a key of
// services/mailNode/errors.js); a failure of the node itself is a MailNodeError, as everywhere.
// actor: services/actor.js.
//
// A save that changes what the node holds applies the node settings again. The route answers first
// and applies after (background: true, the default), so a save never waits for a node that does not
// answer; the CLI ends its database pool right after the answer, so it waits for the apply and the
// disk check instead (background: false) and gets the apply's result in the answer.

// Sent instead of the stored API key; posting it back keeps the stored key.
export const REDACTED_SECRET = '••••••••';

// A settings change is journaled by the names of the fields that changed, never their values.
function configAudit(actor, settings, fields) {
  if (!fields.length) return;
  recordAudit(auditOf(actor, { action: 'mail_node.config_changed', details: { settings, fields } }));
}

// applyNode as the route calls it; the CLI's actor goes along so the journal names it.
function applyNodeAs(actor, trigger) {
  return applyNode({ userId: actor?.userId ?? null, ...(actor?.via ? { actor } : {}), trigger });
}

// Runs the apply after the save: in the background for a route, awaited (and answered) for the CLI.
async function applyAfterSave(actor, trigger, background) {
  if (background) {
    applyInBackground(() => applyNodeAs(actor, trigger));
    return {};
  }
  const apply = await applyQuietly(() => applyNodeAs(actor, trigger));
  return apply ? { apply } : {};
}

// GET /api/mail-node/config. nodeIp: the node's public address, kept with the EOP settings (one
// stored value, shown with both forms) so that moving the node changes its name and its address in
// one place. The API key is never in the answer: the placeholder stands for a stored one.
export async function nodeConfigView() {
  const cfg = await getMailNodeConfig();
  const { nodeIp } = await getEopSettings();
  return {
    configured: !!cfg,
    mailHost: cfg?.mailHost ?? '',
    apiKey: cfg ? REDACTED_SECRET : '',
    quotaMb: cfg?.quotaMb ?? DEFAULT_QUOTA_MB,
    diskPingUrl: cfg?.diskPingUrl ?? '',
    deleteAfterDays: cfg?.deleteAfterDays ?? DEFAULT_DELETE_AFTER_DAYS,
    panelIps: cfg?.panelIps ?? [],
    nodeIp: nodeIp ?? '',
  };
}

// PUT /api/mail-node/config: the whole form (mailHost required; quotaMb left out is the default;
// diskPingUrl left out or empty is none; deleteAfterDays, panelIps and nodeIp left out keep the
// stored ones; apiKey left out or the placeholder keeps the stored key for the same host only).
// Saves only settings the node accepts: the key is checked by listing the domains first (a
// MailNodeError when the node refuses). Answers { ok, applying?, apply? }.
export async function saveNodeConfig(body, actor, { background = true } = {}) {
  const mailHost = parseHostName(body?.mailHost);
  if (!mailHost) return { error: 'mail_host_invalid' };
  const quotaMb = parseWholeNumber(body?.quotaMb ?? DEFAULT_QUOTA_MB, 1, MAX_QUOTA_MB);
  if (!quotaMb) return { error: 'quota_invalid' };
  const rawPing = typeof body?.diskPingUrl === 'string' ? body.diskPingUrl.trim() : '';
  const diskPingUrl = rawPing ? parsePingUrl(rawPing) : null;
  if (rawPing && !diskPingUrl) return { error: 'ping_url_invalid' };
  const sent = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  const current = await getMailNodeConfig();
  // Days a mailbox asked to be deleted keeps working. A new value applies to deletions asked for
  // from now on: dates already set stay as they are.
  const deleteAfterDays = parseWholeNumber(
    body?.deleteAfterDays ?? current?.deleteAfterDays ?? DEFAULT_DELETE_AFTER_DAYS, 1, MAX_DELETE_AFTER_DAYS,
  );
  if (!deleteAfterDays) return { error: 'delete_after_days_invalid' };
  // The panel's own addresses for the node's fail2ban whitelist; left out, the stored ones stay.
  const ips = body?.panelIps === undefined ? { networks: current?.panelIps ?? [] } : parseNetworkList(body.panelIps);
  if (ips.error) return { error: ips.error };
  const panelIps = ips.networks;
  // The node's address, left out to keep the stored one; checked as the EOP settings check it.
  const address = body?.nodeIp === undefined ? { settings: {} } : parseEopSettings({ nodeIp: body.nodeIp });
  if (address.error) return { error: address.error };
  let apiKey = sent;
  if (!sent || sent === REDACTED_SECRET) {
    // The stored key goes only to the host it was entered for: a new host needs the key again.
    if (!current?.apiKey || current.mailHost !== mailHost) return { error: 'api_key_required' };
    apiKey = current.apiKey;
  }
  const cfg = { mailHost, apiKey, quotaMb, diskPingUrl, deleteAfterDays, panelIps };
  await listDomains(cfg);
  await saveMailNodeConfig(cfg);
  const changed = Object.keys(cfg).filter((field) => JSON.stringify(current?.[field]) !== JSON.stringify(cfg[field]));
  if ('nodeIp' in address.settings) {
    const { nodeIp: storedIp } = await getEopSettings();
    if (address.settings.nodeIp !== storedIp) {
      await saveEopSettings(address.settings);
      changed.push('nodeIp');
    }
  }
  configAudit(actor, 'node', changed);
  // Read the disk (and ping) right away instead of at the next scheduled run.
  const disk = checkMailNodeDisk().catch((err) => console.error('Mail node disk check failed:', err.message));
  if (!background) await disk;
  // Another node, key or panel address: the node gets the panel's settings again.
  const applying = changed.some((field) => ['mailHost', 'apiKey', 'panelIps'].includes(field));
  if (!applying) return { ok: true };
  return { ok: true, applying, ...(await applyAfterSave(actor, 'node_settings', background)) };
}

// tenantDriver: the tenant driver the backend runs with ('worker', 'fake' or null), for the
// "Microsoft tenant" part of the screen (routes/mailNodeTenant.js).
export function eopView(settings) {
  return {
    ...settings, tenantConfigured: tenantConfigured(settings), tenantDriverActive: tenantDriverActive(settings),
    tenantDriver: getTenantDriver()?.kind ?? null,
  };
}

// GET /api/mail-node/eop.
export async function eopSettingsView() {
  return eopView(await getEopSettings());
}

// The fields the node gets: a change applies the node settings at once.
const NODE_APPLIED_FIELDS = Object.freeze(['eopHost', 'tlsPolicy', 'tlsPolicyParameters', 'dkimMode', 'sendLimitPerHour']);

// PUT /api/mail-node/eop: the fields sent, checked and kept (a field left out keeps its value, an
// optional one sent empty is cleared); the next hop, its TLS, the DKIM mode and the send limit are
// applied to the node (a run that never deletes a DKIM key nor writes the spam filing rule). TLS
// policy parameters must fit the policy (eopSettingsConflict). The tenant fields are kept; the
// tenant jobs read them (services/tenant/tenantJobs.js). Answers the settings as eopView shows them,
// with applying (and apply, when not in the background) when the node gets them.
export async function saveEopConfig(body, actor, { background = true } = {}) {
  const { settings, error } = parseEopSettings(body);
  if (error) return { error };
  const current = await getEopSettings();
  const merged = { ...current, ...settings };
  const conflict = eopSettingsConflict(merged);
  if (conflict) return { error: conflict };
  await saveEopSettings(settings);
  // EOP seats in manual mode: a larger Licenses number closes the seat requests it covers.
  if (settings.licenses != null) {
    const supply = await seatSupply();
    if (supply.source === 'manual') await closeFulfilledRequests(supply.purchased);
  }
  const changed = EOP_FIELDS.filter((field) => field in settings && settings[field] !== current[field]);
  configAudit(actor, 'eop', changed);
  const applying = changed.some((field) => NODE_APPLIED_FIELDS.includes(field)) && !!(await getMailNodeConfig());
  if (!applying) return eopView(merged);
  return { ...eopView(merged), applying, ...(await applyAfterSave(actor, 'eop_settings', background)) };
}

// GET /api/mail-node/eop/budget: the TERRL budget now, unique external recipients of the last 24
// hours against the limit (services/mailNode/terrl.js). The node's log is read for what the journal
// does not see, through the shared read of the alert job (a minute's cache, one read at a time), so
// opening the EOP screen does not ask the node for 10000 lines each time; when the node does not
// answer, the journal alone counts (log.read: false). The licenses are the purchased EOP seats
// (services/mailNode/eopSeats.js): Graph's number when the tenant gives it, else the Licenses field.
export async function eopBudgetNow(now = Date.now()) {
  const [eop, cfg] = await Promise.all([getEopSettings(), getMailNodeConfig()]);
  const log = cfg
    ? await readPostfixLog(cfg, { since: now - TERRL_WINDOW_MS }).catch((err) => {
      if (err instanceof MailNodeError) return null;
      throw err;
    })
    : null;
  const aliasDomains = cfg ? await aliasDomainsOf(cfg) : [];
  return computeTerrlBudget({ eop: await withSeatLicenses(eop), log, aliasDomains, now });
}
