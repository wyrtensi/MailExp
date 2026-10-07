import { demoRequest } from '../demo/index.js';
import { isDemoMode } from '../demo/mode.js';
import { exitDeleteBodies } from './deleteIntent.js';

const BASE = '/api';

// Sent on every /api request so the backend CSRF guard accepts it. A cross-site
// form/navigation cannot set a custom header, and a cross-origin fetch that tries
// triggers a CORS preflight the server rejects. Any raw fetch() to /api elsewhere
// in the app must include this same header (see CSRF_HEADER).
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'MailExpert';
const messageBodyRequests = new Map();

async function request(method, path, body, extraHeaders) {
  if (isDemoMode) return demoRequest(method, path, body);
  const opts = {
    method,
    credentials: 'include',
    headers: { [CSRF_HEADER]: CSRF_VALUE, ...(extraHeaders || {}) },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    if (res.status === 423) {
      // Server-enforced screen lock (#235) — surface the lock overlay from any call.
      window.dispatchEvent(new CustomEvent('mailexpert:locked'));
    }
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('mailexpert:session_expired'));
    }
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    const e = new Error(err.error || 'Request failed');
    // Stable machine-readable code (e.g. send_in_progress) for callers that branch on it.
    if (err.code) e.code = err.code;
    // Same idea as code, for a 409 that also names why it refused (e.g. threading_switch_blocked's
    // reason: not_gmail/index_invalid/ids_missing) and, for ids_missing, the row count. A send's
    // smtp_connection_failed also carries the SMTP host/port it could not reach, so the composer
    // can build its own localized message instead of the backend's English one.
    if (err.reason) e.reason = err.reason;
    if (err.count != null) e.count = err.count;
    if (err.host) e.host = err.host;
    if (err.port != null) e.port = err.port;
    e.status = res.status;
    throw e;
  }
  return res.json();
}

const EMPTY_ZIP_DATA_URL = 'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==';
const TRANSPARENT_GIF_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

export function createDirectApi({
  demoMode = isDemoMode,
  demoRequestImpl = demoRequest,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async streamAiChat(messages, { signal, onDelta } = {}) {
      if (demoMode) {
        await demoRequestImpl('POST', '/ai/chat', { messages });
        return '';
      }
      const response = await fetchImpl(`${BASE}/ai/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_VALUE },
        body: JSON.stringify({ messages }),
        signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'AI request failed' }));
        throw new Error(error.error || 'AI request failed');
      }
      if (!response.body) throw new Error('AI response body is unavailable');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let completed = false;

      function consumeLine(line) {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data) return;
        if (data === '[DONE]') {
          completed = true;
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed?.error) {
            const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
            throw new Error(message || 'AI request failed');
          }
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            fullText += delta;
            onDelta?.(fullText, delta);
          }
        } catch (error) {
          if (error instanceof SyntaxError) return;
          throw error;
        }
      }

      try {
        while (!completed) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            consumeLine(line);
            if (completed) break;
          }
        }
        if (!completed && buffer) consumeLine(buffer);
        if (!completed) throw new Error('AI response ended before completion');
        return fullText;
      } finally {
        await reader.cancel().catch(() => {});
      }
    },

    async unlock(pin) {
      if (demoMode) return demoRequestImpl('POST', '/auth/unlock', { pin });
      const res = await fetchImpl(BASE + '/auth/unlock', {
        method: 'POST', credentials: 'include',
        headers: { [CSRF_HEADER]: CSRF_VALUE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if (data.signedOut) {
        window.dispatchEvent(new CustomEvent('mailexpert:session_expired'));
        const error = new Error('signed_out');
        error.signedOut = true;
        throw error;
      }
      throw new Error(data.error || 'Incorrect PIN');
    },

    savePreferencesOnExit(prefs) {
      if (demoMode) return demoRequestImpl('PATCH', '/auth/preferences', prefs);
      return fetchImpl(BASE + '/auth/preferences', {
        method: 'PATCH',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_VALUE },
        body: JSON.stringify(prefs),
      });
    },

    // Without an account the device-code flow adds a mailbox; with one it reconnects that
    // Microsoft mailbox (backend routes/oauth.js).
    async startMsDeviceFlow(accountId) {
      const body = accountId ? { account: accountId } : {};
      if (demoMode) return demoRequestImpl('POST', '/oauth/microsoft/device', body);
      const res = await fetchImpl('/oauth/microsoft/device', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_VALUE },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start device code flow');
      return data;
    },

    async pollMsDeviceFlow() {
      if (demoMode) return demoRequestImpl('GET', '/oauth/microsoft/device/poll');
      const res = await fetchImpl('/oauth/microsoft/device/poll', { credentials: 'include' });
      return res.json();
    },

    deleteMessagesOnExit(ids, folders) {
      const deleteIds = Array.isArray(ids) ? ids : [];
      if (deleteIds.length === 0) return Promise.resolve({ ok: true, deleted: [] });
      const bulkBody = folders ? { ids: deleteIds, folders } : { ids: deleteIds };
      const folder = folders?.[deleteIds[0]];
      if (demoMode) {
        return deleteIds.length > 1
          ? demoRequestImpl('POST', '/mail/messages/bulk-delete', bulkBody)
          : demoRequestImpl('DELETE', `/mail/messages/${deleteIds[0]}`)
            .then(result => ({ ...result, deleted: deleteIds }));
      }
      if (deleteIds.length > 1) {
        // Chunked to the server's 500 ids, compact, and within the page's keepalive budget
        // (utils/deleteIntent.js). What does not fit is not sent: those letters stay put.
        const { bodies, dropped } = exitDeleteBodies(deleteIds, folders);
        if (dropped.length) console.warn(`Page closing: ${dropped.length} pending deletes did not fit the keepalive budget and were not sent`);
        return Promise.all(bodies.map(body => fetchImpl(BASE + '/mail/messages/bulk-delete', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_VALUE },
          body,
          keepalive: true,
        })));
      }
      return fetchImpl(`${BASE}/mail/messages/${deleteIds[0]}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: folder
          ? { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_VALUE }
          : { [CSRF_HEADER]: CSRF_VALUE },
        ...(folder ? { body: JSON.stringify({ folder }) } : {}),
        keepalive: true,
      });
    },

    async downloadAttachment(messageId, part) {
      if (demoMode) {
        const attachment = await demoRequestImpl(
          'GET',
          `/mail/messages/${messageId}/attachments/${encodeURIComponent(part)}`,
        );
        return new Blob([attachment.content || ''], { type: attachment.type || 'application/octet-stream' });
      }
      const res = await fetchImpl(`/api/mail/messages/${messageId}/attachments/${encodeURIComponent(part)}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        // Keep the server's stable code (mailbox_busy) so the caller can say the mailbox is busy.
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error('Download failed'), body.code ? { code: body.code } : {});
      }
      return res.blob();
    },

    attachmentArchiveUrl(messageId) {
      return demoMode ? EMPTY_ZIP_DATA_URL : `/api/mail/messages/${messageId}/attachments.zip`;
    },

    // Download the raw RFC 822 source as an .eml file (#381). A fetch (not a bare URL the
    // caller navigates to) so the server's 413/mailbox_busy/etc. response is visible to the
    // caller instead of silently failing as a browser-level navigation would.
    async downloadRawEml(messageId) {
      if (demoMode) {
        const eml = await demoRequestImpl('GET', `/mail/messages/${messageId}/raw.eml`);
        return new Blob([eml.content || ''], { type: eml.type || 'message/rfc822' });
      }
      const res = await fetchImpl(`/api/mail/messages/${messageId}/raw.eml`, {
        credentials: 'include',
      });
      if (!res.ok) {
        // Keep the server's stable code (message_too_large, mailbox_busy, move_pending) so
        // the caller can show its own localized message instead of the English error text.
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error('Download failed'), body.code ? { code: body.code } : {});
      }
      return res.blob();
    },

    gtdPetSheetUrl(slug) {
      return demoMode ? TRANSPARENT_GIF_DATA_URL : `${BASE}/gtd/pet/${encodeURIComponent(slug)}/sheet`;
    },
  };
}

const directApi = createDirectApi();

export function streamAiChat(messages, options) {
  return directApi.streamAiChat(messages, options);
}

function getMessageBody(id, remoteImages = false) {
  const key = `${id}:${remoteImages ? 'remote' : 'blocked'}`;
  const existing = messageBodyRequests.get(key);
  if (existing) return existing;
  const promise = request('GET', `/mail/messages/${id}/body${remoteImages ? '?remoteImages=1' : ''}`)
    .finally(() => messageBodyRequests.delete(key));
  messageBodyRequests.set(key, promise);
  return promise;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body, extraHeaders) => request('POST', path, body, extraHeaders),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  delete: (path) => request('DELETE', path),

  // Auth
  login: (username, password) => request('POST', '/auth/login', { username, password }),
  register: (username, password, inviteToken) => request('POST', '/auth/register', { username, password, inviteToken }),
  logout: () => request('POST', '/auth/logout'),
  lock: () => request('POST', '/auth/lock'),
  // Custom response handling is kept inside the direct transport so lockout state is
  // preserved in production while demo mode remains entirely local.
  unlock: (pin) => directApi.unlock(pin),
  setLockPin: (pin, currentPin) => request('POST', '/auth/lock-pin', { pin, currentPin }),
  removeLockPin: (currentPin) => request('DELETE', '/auth/lock-pin', { currentPin }),
  me: () => request('GET', '/auth/me'),
  authConfig: () => request('GET', '/auth/config'),
  forgotPassword: (email) => request('POST', '/auth/forgot-password', { email }),
  resetPassword: (token, password) => request('POST', '/auth/reset-password', { token, password }),
  getPreferences: () => request('GET', '/auth/preferences'),
  savePreferences: (prefs) => request('PATCH', '/auth/preferences', prefs),
  // The same write, but issued while the page is going away. keepalive lets the browser
  // finish the request after the document is gone; an ordinary fetch is cancelled and the
  // setting is lost, then overwritten by the older server value on the next load. Bypasses
  // request() deliberately: there is no point parsing a response nobody will see, and the
  // 401/423 events it dispatches cannot be acted on during unload.
  savePreferencesOnExit: (prefs) => directApi.savePreferencesOnExit(prefs),
  updateProfile: (data) => request('PATCH', '/auth/profile', data),
  uploadAvatar: (avatar) => request('POST', '/auth/avatar', { avatar }),
  deleteAvatar: () => request('DELETE', '/auth/avatar'),
  getRegistrationStatus: () => request('GET', '/auth/registration-status'),
  validateInvite: (token) => request('GET', `/auth/invite/${token}`),

  // Recovery email (profile security)
  getRecoveryEmail: () => request('GET', '/auth/profile/recovery-email'),
  updateRecoveryEmail: (email) => request('PATCH', '/auth/profile/recovery-email', { email }),

  // TOTP / 2FA
  totp: {
    setup: () => request('GET', '/totp/setup'),
    enable: (code) => request('POST', '/totp/enable', { code }),
    disable: (password) => request('POST', '/totp/disable', { password }),
    cancel: () => request('POST', '/totp/cancel'),
    challenge: (code, rememberDevice) => request('POST', '/auth/2fa/challenge', { code, rememberDevice }),
    sendEmailOtp: () => request('POST', '/auth/2fa/send-email-otp'),
    verifyEmailOtp: (code, rememberDevice) => request('POST', '/auth/2fa/verify-email-otp', { code, rememberDevice }),
    enrollmentSetup: () => request('GET', '/auth/2fa/enrollment/setup'),
    enrollmentEnable: (code) => request('POST', '/auth/2fa/enrollment/enable', { code }),
  },

  // Admin
  admin: {
    getUsers: (params) => request('GET', '/admin/users' + (params ? '?' + new URLSearchParams(params) : '')),
    createUser: (email) => request('POST', '/admin/users', { email }),
    updateUser: (id, data) => request('PATCH', `/admin/users/${id}`, data),
    deleteUser: (id) => request('DELETE', `/admin/users/${id}`),
    disableUserTotp: (id) => request('POST', `/admin/users/${id}/totp/disable`),
    getSettings: () => request('GET', '/admin/settings'),
    updateSettings: (data) => request('PATCH', '/admin/settings', data),
    getInvites: (params) => request('GET', '/admin/invites' + (params ? '?' + new URLSearchParams(params) : '')),
    createInvite: (email) => request('POST', '/admin/invites', { email }),
    deleteInvite: (id) => request('DELETE', `/admin/invites/${id}`),
    getSystemEmail: () => request('GET', '/admin/system-email'),
    saveSystemEmail: (data) => request('POST', '/admin/system-email', data),
    testSystemEmail: () => request('POST', '/admin/system-email/test'),
    deleteSystemEmail: () => request('DELETE', '/admin/system-email'),
    getAuthEvents: (params) => request('GET', '/admin/auth-events?' + new URLSearchParams(params)),
    getAuditLog: (params) => request('GET', '/admin/audit' + (params && Object.keys(params).length ? '?' + new URLSearchParams(params) : '')),
    getAccessSync: () => request('GET', '/admin/access-sync'),
    saveAccessSync: (data) => request('PUT', '/admin/access-sync', data),
    runAccessSync: () => request('POST', '/admin/access-sync/run'),
    // Update of the panel from the admin UI (the host's updater does the work; see utils/panelUpdate.js).
    // refresh: asks the backend to look at GitHub's `latest` now instead of its 6-hour cache (the
    // backend allows that once a minute); used when the card opens, never by the poll.
    getPanelUpdate: ({ refresh = false } = {}) => request('GET', refresh ? '/admin/update?refresh=1' : '/admin/update'),
    checkPanelUpdate: (target) => request('POST', '/admin/update/check', { target }),
    startPanelUpdate: (target) => request('POST', '/admin/update', { target, confirm: target }),
    googleApps: {
      list: () => request('GET', '/admin/google-apps'),
      create: (data) => request('POST', '/admin/google-apps', data),
      update: (id, data) => request('PATCH', `/admin/google-apps/${id}`, data),
      remove: (id) => request('DELETE', `/admin/google-apps/${id}`),
    },
    oidc: {
      getProviders: () => request('GET', '/admin/oidc'),
      createProvider: (data) => request('POST', '/admin/oidc', data),
      updateProvider: (id, data) => request('PATCH', `/admin/oidc/${id}`, data),
      deleteProvider: (id) => request('DELETE', `/admin/oidc/${id}`),
    },
  },

  // OIDC
  oidc: {
    getProviders: () => request('GET', '/auth/oidc/providers'),
    getIdentities: () => request('GET', '/auth/oidc/identities'),
    unlinkIdentity: (id) => request('DELETE', `/auth/oidc/identities/${id}`),
  },

  // Accounts
  getAccounts: () => request('GET', '/accounts'),
  addAccount: (data) => request('POST', '/accounts', data),
  // A mailbox on the mail node: the server picks the host and a password nobody sees.
  addDomainMailbox: ({ localPart, domain, name, ...names }) => request('POST', '/accounts', { kind: 'domain', localPart, domain, name, ...names }),
  mailNode: {
    getConfig: () => request('GET', '/mail-node/config'),
    saveConfig: (data) => request('PUT', '/mail-node/config', data),
    listDomains: () => request('GET', '/mail-node/domains'),
    addDomain: (data) => request('POST', '/mail-node/domains', data),
    adoptDomain: (domain) => request('POST', `/mail-node/domains/${encodeURIComponent(domain)}/adopt`),
    confirmDomainStep: (domain, step) => request('POST', `/mail-node/domains/${encodeURIComponent(domain)}/steps/${encodeURIComponent(step)}`),
    markDomainReady: (domain) => request('POST', `/mail-node/domains/${encodeURIComponent(domain)}/ready`),
    restartDomainOnboarding: (domain) => request('POST', `/mail-node/domains/${encodeURIComponent(domain)}/restart`),
    // `created`: the node's creation time the administrator saw; the server refuses if it changed.
    acknowledgeDomainNode: (domain, created) => request('POST', `/mail-node/domains/${encodeURIComponent(domain)}/acknowledge`, { created }),
    getEopSettings: () => request('GET', '/mail-node/eop'),
    saveEopSettings: (data) => request('PUT', '/mail-node/eop', data),
    listMailboxes: () => request('GET', '/mail-node/mailboxes'),
    setQuota: (accountId, quotaMb) => request('PUT', `/mail-node/mailboxes/${accountId}/quota`, { quotaMb }),
    // { value, frame } for an administrator's send limit, or { value: null } for the default.
    setRateLimit: (accountId, limit) => request('PUT', `/mail-node/mailboxes/${accountId}/rate-limit`, limit),
    // Applying the settings to the node: the node with every domain, one domain, and the spam
    // filing rule on its own (it restarts Dovecot).
    getApplyResult: () => request('GET', '/mail-node/apply'),
    applyNode: () => request('POST', '/mail-node/apply'),
    applyDomain: (domain, { confirmDkimDelete = false } = {}) => request('POST', `/mail-node/domains/${encodeURIComponent(domain)}/apply`, { confirmDkimDelete }),
    applyPrefilter: () => request('POST', '/mail-node/apply/prefilter'),
    // The DNS checks: the node's last result, "Check now" for the node with every domain and for
    // one domain, and the values a domain must publish that the panel cannot read yet.
    getDnsCheck: () => request('GET', '/mail-node/dns-check'),
    checkDns: () => request('POST', '/mail-node/dns-check'),
    checkDomainDns: (domain) => request('POST', `/mail-node/domains/${encodeURIComponent(domain)}/dns-check`),
    setDnsExpected: (domain, values) => request('PUT', `/mail-node/domains/${encodeURIComponent(domain)}/dns-expected`, values),
    // The node's operations: its mail queue (one message's body only on request; delete needs
    // { confirm: true }), its alerts with their settings, and the tenant's TERRL budget.
    getQueue: () => request('GET', '/mail-node/queue'),
    getQueuedMessage: (queueId, { body = false } = {}) => request('GET', `/mail-node/queue/${encodeURIComponent(queueId)}${body ? '?body=1' : ''}`),
    queueAction: (queueId, action, { confirm = false } = {}) => request('POST', `/mail-node/queue/${encodeURIComponent(queueId)}/${encodeURIComponent(action)}`, confirm ? { confirm: true } : undefined),
    flushQueue: () => request('POST', '/mail-node/queue/flush'),
    getAlerts: () => request('GET', '/mail-node/alerts'),
    checkAlerts: () => request('POST', '/mail-node/alerts/check'),
    saveAlertSettings: (data) => request('PUT', '/mail-node/alerts/settings', data),
    getTerrlBudget: () => request('GET', '/mail-node/eop/budget'),
    getSeats: () => request('GET', '/mail-node/seats'),
    checkSeats: () => request('POST', '/mail-node/seats/check'),
    requestSeats: (seats) => request('POST', '/mail-node/seats/requests', { seats }),
    saveSeatSettings: ({ holdDays }) => request('PUT', '/mail-node/seats/settings', { holdDays }),
    // The Microsoft tenant (stage 7a): what the tenant jobs stored, the buttons that queue a job
    // (202 with { job }), and one job followed until it ends.
    getTenant: () => request('GET', '/mail-node/tenant'),
    testTenant: () => request('POST', '/mail-node/tenant/test'),
    pollTenant: () => request('POST', '/mail-node/tenant/poll'),
    readTenantAntispam: () => request('POST', '/mail-node/tenant/antispam'),
    getTenantJob: (id) => request('GET', `/mail-node/tenant/jobs/${encodeURIComponent(id)}`),
    // Stage 7b: one domain's tenant steps and mirror now, and the connectors as the reference.
    syncTenantDomain: (domain) => request('POST', `/mail-node/tenant/domains/${encodeURIComponent(domain)}/sync`),
    takeTenantConnectorReference: () => request('POST', '/mail-node/tenant/connectors/reference'),
    setTenantDomainHold: (domain, hold) => request('POST', `/mail-node/tenant/domains/${encodeURIComponent(domain)}/hold`, { hold }),
    approveTenantInternalRelay: (domain) => request('POST', `/mail-node/tenant/domains/${encodeURIComponent(domain)}/internal-relay`),
    // Section 5.14: allow removing the alias contacts kept on an Authoritative domain.
    removeTenantAliasContacts: (domain) => request('POST', `/mail-node/tenant/domains/${encodeURIComponent(domain)}/alias-contacts/remove`),
    // Stage 7c (R-42): the phishing released from EOP's quarantine, the pause switch, a run now.
    getPhishRelease: () => request('GET', '/mail-node/tenant/phish-release'),
    setPhishRelease: (enabled) => request('PUT', '/mail-node/tenant/phish-release', { enabled }),
    runPhishRelease: () => request('POST', '/mail-node/tenant/phish-release/run'),
    // The node's quarantine (R-20): the entries, one with its letter parsed for the safe view,
    // release and delete (administrators), and whether users see it too.
    listQuarantine: () => request('GET', '/mail-node/quarantine'),
    getQuarantineItem: (id) => request('GET', `/mail-node/quarantine/${encodeURIComponent(id)}`),
    releaseQuarantineItem: (id) => request('POST', `/mail-node/quarantine/${encodeURIComponent(id)}/release`),
    deleteQuarantineItem: (id) => request('DELETE', `/mail-node/quarantine/${encodeURIComponent(id)}`),
    learnSpamQuarantineItem: (id) => request('POST', `/mail-node/quarantine/${encodeURIComponent(id)}/learn-spam`),
    // Writes every quarantine setting of mailcow (the screen warns first).
    applyQuarantineNodeSettings: () => request('POST', '/mail-node/quarantine/node-settings', { confirm: true }),
    getQuarantineSettings: () => request('GET', '/mail-node/quarantine/settings'),
    saveQuarantineSettings: (data) => request('PUT', '/mail-node/quarantine/settings', data),
    // "Why is this letter in Spam": rspamd's verdict on a letter of a node mailbox.
    spamVerdict: (messageId) => request('GET', `/mail-node/messages/${encodeURIComponent(messageId)}/spam-verdict`),
    // Letters delayed or lost while the node was down (R-43): the panel mailboxes' letters for
    // everyone; the outage windows, their letters, windows by hand, a trace pass now and how long
    // letters are kept for administrators. A window change needs a reason; deleting needs
    // { confirm: true, reason }.
    outageLetters: () => request('GET', '/mail-node/outage-letters'),
    getOutages: () => request('GET', '/mail-node/outages'),
    getOutageLetters: (id) => request('GET', `/mail-node/outages/${encodeURIComponent(id)}/letters`),
    addOutage: (data) => request('POST', '/mail-node/outages', data),
    updateOutage: (id, data) => request('PUT', `/mail-node/outages/${encodeURIComponent(id)}`, data),
    closeOutage: (id, data) => request('POST', `/mail-node/outages/${encodeURIComponent(id)}/close`, data),
    deleteOutage: (id, reason) => request('DELETE', `/mail-node/outages/${encodeURIComponent(id)}`, { confirm: true, reason }),
    // The node agent (scripts/deploy/mail-node/node-agent.sh): its state with the last status report
    // and recent jobs; its token, issued or rotated (the answer is the only time it is shown) and
    // revoked; and a job for it ({ kind: 'backup' }: "Back up mail now").
    getAgent: () => request('GET', '/mail-node/agent'),
    issueAgentToken: () => request('POST', '/mail-node/agent/token'),
    revokeAgentToken: () => request('DELETE', '/mail-node/agent/token'),
    requestAgentJob: (kind) => request('POST', '/mail-node/agent/jobs', { kind }),
    traceOutages: () => request('POST', '/mail-node/outages/trace'),
    saveOutageSettings: (data) => request('PUT', '/mail-node/outage-settings', data),
  },
  updateAccount: (id, data) => request('PUT', `/accounts/${id}`, data),
  deleteAccount: (id) => request('DELETE', `/accounts/${id}`),
  getNodeAliases: (id) => request('GET', `/accounts/${id}/node-aliases`),
  // A mail node mailbox: ask for its deletion after the waiting time ({ email, reason }), or cancel it.
  requestMailboxDeletion: (id, { email, reason }) => request('POST', `/accounts/${id}/deletion`, { email, reason }),
  cancelMailboxDeletion: (id) => request('DELETE', `/accounts/${id}/deletion`),
  deactivateMailbox: (id, { reason }) => request('POST', `/accounts/${id}/deactivation`, { reason }),
  activateMailbox: (id) => request('DELETE', `/accounts/${id}/deactivation`),
  reconnectAccount: (id) => request('POST', `/accounts/${id}/reconnect`),
  // Admin: forget which Google/Microsoft account an OAuth mailbox is bound to.
  resetOAuthSubject: (id) => request('POST', `/accounts/${id}/oauth-subject/reset`),
  reindexAccount: (id) => request('POST', `/accounts/${id}/reindex`),
  previewThreading: (id, mode) => request('POST', `/accounts/${id}/threading/preview`, { mode }),
  setThreadingMode: (id, mode) => request('POST', `/accounts/${id}/threading/mode`, { mode }),
  getFolders: (accountId) => request('GET', `/accounts/${accountId}/folders`),
  getAliases: (accountId) => request('GET', `/accounts/${accountId}/aliases`),
  addAlias: (accountId, data) => request('POST', `/accounts/${accountId}/aliases`, data),
  updateAlias: (accountId, aliasId, data) => request('PUT', `/accounts/${accountId}/aliases/${aliasId}`, data),
  deleteAlias: (accountId, aliasId) => request('DELETE', `/accounts/${accountId}/aliases/${aliasId}`),

  // Mail
  getMessages: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request('GET', `/mail/messages?${qs}`);
  },
  getMessage: (id) => request('GET', `/mail/messages/${id}`),
  getSenderHistory: (id, limit) => request('GET', `/mail/messages/${id}/sender-history?limit=${limit}`),
  getConversation: (id) => request('GET', `/mail/messages/${id}/conversation`),
  getMessageThreading: (id) => request('GET', `/mail/messages/${id}/threading`),
  // What became of a sent letter, per recipient (R-17): the node's log and delivery reports.
  messageDelivery: (id) => request('GET', `/mail/messages/${encodeURIComponent(id)}/delivery`),
  // R-30: ask Microsoft's message trace about the letter (a job; GET .../delivery follows it).
  messageEopTrace: (id) => request('POST', `/mail/messages/${encodeURIComponent(id)}/eop-trace`),
  // Resolve a deep-link reference (stable Message-ID header, or a legacy UUID) to the
  // current message row — durable across folder moves (#270).
  resolveMessage: (ref, accountId) => {
    const qs = new URLSearchParams({ ref });
    if (accountId) qs.set('accountId', accountId);
    return request('GET', `/mail/resolve-message?${qs}`);
  },
  getMessageBody,
  // accountId limits the thread to one mailbox: the same conversation sent to two mailboxes has
  // one thread key in both, and an action in one mailbox must not reach the other.
  getThread: (threadId, folder, unified = false, accountId = null) => {
    const qs = new URLSearchParams();
    if (folder) qs.set('folder', folder);
    if (unified) qs.set('unified', 'true');
    if (accountId) qs.set('accountId', accountId);
    const query = qs.size ? `?${qs}` : '';
    return request('GET', `/mail/thread/${encodeURIComponent(threadId)}${query}`);
  },
  bulkRead: (ids, read) => request('POST', '/mail/messages/bulk-read', { ids, read }),
  bulkStar: (ids, starred) => request('POST', '/mail/messages/bulk-star', { ids, starred }),
  markStarred: (id, starred) => request('PATCH', `/mail/messages/${id}/star`, { starred }),
  markAllRead: (accountId, folder) => request('POST', '/mail/mark-all-read', { accountId, folder }),
  // folder / folders: where the user saw the letters (utils/deleteIntent.js). Without them the
  // server only moves to Trash and never deletes forever.
  // 404: the letter is gone already (another tab, a colleague, an earlier try that got through).
  // That is what the delete asked for, so it counts as done and the row is not put back.
  deleteMessage: (id, folder) => request('DELETE', `/mail/messages/${id}`, folder ? { folder } : undefined)
    .catch((err) => {
      if (err.status === 404) return { ok: true, alreadyGone: true };
      throw err;
    }),
  bulkDelete: (ids, folders) => request('POST', '/mail/messages/bulk-delete', folders ? { ids, folders } : { ids }),
  deleteMessagesOnExit: (ids, folders) => directApi.deleteMessagesOnExit(ids, folders),
  bulkMove: (ids, folder) => request('POST', '/mail/messages/bulk-move', { ids, folder }),
  bulkArchive: (ids) => request('POST', '/mail/messages/bulk-archive', { ids }),
  getUnreadCounts: () => request('GET', '/mail/unread-counts'),

  // Mailbox cleanup (read-only analysis; actual cleanup reuses bulkDelete above).
  mailboxUsage: (accountId) => request('GET', `/mail/mailbox-usage?accountId=${encodeURIComponent(accountId)}`),
  cleanupPreview: (accountId, fromEmail) =>
    request('GET', `/mail/cleanup-preview?accountId=${encodeURIComponent(accountId)}&fromEmail=${encodeURIComponent(fromEmail)}`),

  // Antispam (v0.1) — manual user feedback.
  // markSpam moves the message to the account's spam/junk folder and
  // records the decision in spam_training_log. markHam moves it back to
  // INBOX. No automatic classification runs here yet.
  markSpam: (id) => request('POST', `/mail/messages/${id}/spam`),
  markHam:  (id) => request('POST', `/mail/messages/${id}/ham`),

  getMessageHeaders: (id) => request('GET', `/mail/messages/${id}/headers`),
  getMessageBcc: (id) => request('GET', `/mail/messages/${id}/bcc`),
  downloadAttachment: (messageId, part) => directApi.downloadAttachment(messageId, part),
  attachmentArchiveUrl: (messageId) => directApi.attachmentArchiveUrl(messageId),
  downloadRawEml: (messageId) => directApi.downloadRawEml(messageId),
  snoozeMessage: (id, until) => request('POST', `/mail/messages/${id}/snooze`, { until }),

  // Sanitized diagnostics report (server-owned sections; scoped to the user).
  diagnosticsReport: (salt) => request('POST', '/diagnostics/report', { salt }),

  // Integrations
  getIntegrations: () => request('GET', '/integrations'),
  getIntegrationsStatus: () => request('GET', '/integrations/status'),
  saveIntegration: (provider, config) => request('POST', `/integrations/${provider}`, config),
  deleteIntegration: (provider) => request('DELETE', `/integrations/${provider}`),
  startMsDeviceFlow: (accountId) => directApi.startMsDeviceFlow(accountId),
  pollMsDeviceFlow: () => directApi.pollMsDeviceFlow(),
  // Gmail by address: start answers a one-time /oauth/google/launch path (the address stays out
  // of MailExpert URLs); known-emails lists addresses connected before that have no mailbox now.
  startGoogleOAuth: (email, names = {}) => request('POST', '/oauth/google/start', { email, ...names }),
  knownGoogleEmails: (q) => request('GET', `/oauth/google/known-emails?${new URLSearchParams({ q })}`),

  // Sync
  // Manual sync is per mailbox: the server answers { ok, skipped } and rejects a request without one.
  syncNow: (accountId) => request('POST', '/mail/sync', { accountId }),
  syncFolder: (accountId, folder) => request('POST', '/mail/sync-folder', { accountId, folder }),
  syncFoldersNow: (accountId) => request('POST', '/mail/sync-folders', { accountId }),

  // Folder management
  createFolder: (accountId, name, parentPath) => request('POST', '/mail/folders', { accountId, name, parentPath }),
  deleteFolder: (accountId, path) => request('POST', '/mail/folders/delete', { accountId, path }),
  renameFolder: (accountId, oldPath, newName) => request('POST', '/mail/folders/rename', { accountId, oldPath, newName }),
  emptyFolder: (accountId, path) => request('POST', '/mail/folders/empty', { accountId, path }),

  // Search
  search: (q, accountId, { offset = 0, limit, folder } = {}) => {
    const params = new URLSearchParams({ q });
    if (accountId) params.set('accountId', accountId);
    if (limit) params.set('limit', limit);
    if (folder) params.set('folder', folder);
    if (offset) params.set('offset', offset);
    return request('GET', `/search?${params}`);
  },
  suggestContacts: (q) => request('GET', `/search/contacts?q=${encodeURIComponent(q)}`),

  // Contacts
  getContacts:   ({ q, limit, offset, is_auto } = {}) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (limit !== undefined) p.set('limit', limit);
    if (offset !== undefined) p.set('offset', offset);
    if (is_auto !== undefined) p.set('is_auto', is_auto);
    const qs = p.toString();
    return request('GET', `/contacts${qs ? '?' + qs : ''}`);
  },
  getContact:    (id)       => request('GET',    `/contacts/${id}`),
  createContact: (data)     => request('POST',   '/contacts', data),
  updateContact: (id, data) => request('PATCH',  `/contacts/${id}`, data),
  deleteContact: (id)       => request('DELETE', `/contacts/${id}`),
  getContactLetters: (id, { limit, offset } = {}) => {
    const p = new URLSearchParams();
    if (limit !== undefined) p.set('limit', limit);
    if (offset !== undefined) p.set('offset', offset);
    const qs = p.toString();
    return request('GET', `/contacts/${id}/letters${qs ? '?' + qs : ''}`);
  },

  // Image whitelist
  addToImageWhitelist: (entry) => request('POST', '/auth/preferences/whitelist-add', entry),

  // Web Push
  getPushVapidKey:  ()           => request('GET',    '/auth/push/vapid-key'),
  pushSubscribe:    (subscription) => request('POST',   '/auth/push/subscribe',    subscription),
  pushUnsubscribe:  (body)       => request('POST',    '/auth/push/unsubscribe',   body),

  // Inbox Rules
  getRules:    ()         => request('GET',    '/rules'),
  createRule:  (data)     => request('POST',   '/rules', data),
  updateRule:  (id, data) => request('PUT',    `/rules/${id}`, data),
  deleteRule:  (id)       => request('DELETE', `/rules/${id}`),
  reorderRules:(ids)      => request('PATCH',  '/rules/reorder', { ids }),
  runRules:    (accountId) => request('POST',  '/rules/run', accountId ? { accountId } : {}),

  // Letters waiting to be sent: undo send and send later (backend routes/scheduled.js)
  scheduled: {
    // No accountId: every mailbox.
    list: (accountId) => request('GET', `/mail/scheduled?accountId=${encodeURIComponent(accountId || '')}`),
    get: (id) => request('GET', `/mail/scheduled/${encodeURIComponent(id)}`),
    // reason: 'undo' or 'edit' answer { compose } to reopen the composer with; 'discard' answers { ok }.
    cancel: (id, reason = 'discard') => request('POST', `/mail/scheduled/${encodeURIComponent(id)}/cancel`, { reason }),
    reschedule: (id, sendAt) => request('PATCH', `/mail/scheduled/${encodeURIComponent(id)}`, { sendAt }),
    // Sends again, now, a letter that failed or needs attention.
    resend: (id) => request('PATCH', `/mail/scheduled/${encodeURIComponent(id)}`, { resend: true }),
  },

  // Drafts
  saveDraft:   (data)              => request('POST',   '/mail/draft', data),
  deleteDraft: (accountId, uid, folder) =>
    request('DELETE', `/mail/draft/${uid}?accountId=${encodeURIComponent(accountId)}&folder=${encodeURIComponent(folder)}`),

  // Block List — each entry blocks a sender for one account
  getBlockList:          ()                 => request('GET',    '/block-list'),
  addToBlockList:        (accountId, email) => request('POST',   '/block-list', { accountId, emailAddress: email }),
  removeFromBlockList:   (id)               => request('DELETE', `/block-list/${id}`),

  // AI assistant
  ai: {
    getConfig: () => request('GET', '/admin/ai'),
    saveConfig: (data) => request('PATCH', '/admin/ai', data),
    deleteConfig: () => request('DELETE', '/admin/ai'),
    test: () => request('POST', '/admin/ai/test'),
    status: () => request('GET', '/ai/status'),
    chat: streamAiChat,
    codex: {
      start: () => request('POST', '/admin/ai/codex/device'),
      poll: (flowId) => request('POST', '/admin/ai/codex/device/poll', { flowId }),
      status: () => request('GET', '/admin/ai/codex/status'),
      cancel: (flowId) => request('DELETE', '/admin/ai/codex/device', { flowId }),
      disconnect: () => request('DELETE', '/admin/ai/codex'),
    },
  },

  // Category counts for inbox tab badges
  getCategoryCounts: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/mail/category-counts${qs ? '?' + qs : ''}`);
  },

  // Manual category override for a single message
  setMessageCategory: (id, category) => request('PATCH', `/mail/messages/${id}/category`, { category }),

  // Trigger unsubscribe for a newsletter message
  unsubscribeMessage: (id) => request('POST', `/mail/messages/${id}/unsubscribe`),

  // Email categorization
  categories: {
    getSources: () => request('GET', '/categories/sources'),
    addSource: (data) => request('POST', '/categories/sources', data),
    toggleSource: (id, enabled) => request('PATCH', `/categories/sources/${id}`, { enabled }),
    deleteSource: (id) => request('DELETE', `/categories/sources/${id}`),
    refreshSource: (id) => request('POST', `/categories/sources/${id}/refresh`),
    recategorize: (accountId) => request('POST', `/categories/recategorize/${accountId}`),
    aiClassify: (messageId) => request('POST', `/categories/ai-classify/${messageId}`),
  },

  // GTD — sections feed (rail + tabs) and classify/unclassify (COPY / remove copy)
  getGtdSections: (params) => {
    const p = new URLSearchParams();
    if (params?.accountId) p.set('accountId', params.accountId);
    if (params?.limit != null) p.set('limit', params.limit);
    const qs = p.toString();
    return request('GET', `/gtd/sections${qs ? '?' + qs : ''}`);
  },
  gtdClassify: (messageId, state) => request('POST', '/gtd/classify', { messageId, state }),
  gtdUndoClassify: (undoToken) => request('POST', '/gtd/classify/undo', undoToken),
  gtdUnclassify: (messageId, state) => request('DELETE', '/gtd/classify', { messageId, state }),
  // GTD "done": strip the row's label(s) for these states, mark read, archive the INBOX
  // copy. id is the rail head's row id (its label-folder copy); the server resolves the
  // INBOX copy from the shared Message-ID.
  gtdDone: (id, states) => request('POST', '/gtd/done', { id, states }),
  gtdEnsureFolders: (accountId, folders) => request('POST', '/gtd/folders/ensure', { accountId, folders }),

  // GTD — Inbox-Zero pet. Import uploads your own pet (pet.json text + a base64 spritesheet)
  // and caches it server-side; meta returns the animation descriptor; the sheet URL is used
  // directly as an <img>/background src (authenticated same-origin, cookies ride along).
  importGtdPet: (payload) => request('POST', '/gtd/pet/import', payload),
  getGtdPetMeta: (slug) => request('GET', `/gtd/pet/${encodeURIComponent(slug)}/meta`),
  gtdPetSheetUrl: (slug) => directApi.gtdPetSheetUrl(slug),

  // Plugins — registered plugins for this build plus the panel-wide switch an administrator sets
  // for every user (PATCH is admin-only). Independent of a plugin's own per-account config (e.g.
  // GTD's gtd_enabled).
  plugins: {
    list: () => request('GET', '/plugins'),
    setEnabled: (id, enabled) => request('PATCH', `/plugins/${encodeURIComponent(id)}`, { enabled }),
  },

  // Todoist integration
  todoist: {
    status:       ()       => request('GET',    '/todoist/status'),
    connect:      (token)  => request('POST',   '/todoist/connect', { token }),
    disconnect:   ()       => request('DELETE', '/todoist/disconnect'),
    getProjects:  ()       => request('GET',    '/todoist/projects'),
    getLabels:    ()       => request('GET',    '/todoist/labels'),
    createTask:   (data)   => request('POST',   '/todoist/tasks', data),
  },
};
