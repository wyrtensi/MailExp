import express from 'express';
import session from 'express-session';
import cors from 'cors';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import { RedisStore } from 'connect-redis';
import './loadEnv.js';
import { redisClient } from './services/redis.js';
import { buildSessionOptions } from './utils/sessionConfig.js';

import sendRoutes from './routes/send.js';
import draftRoutes from './routes/draft.js';
import oauthRoutes from './routes/oauth.js';
import authGoogleRoutes from './routes/authGoogle.js';
import integrationsRoutes, { loadIntegrationConfigs } from './routes/integrations.js';
import oauthGoogleApiRoutes from './routes/oauthGoogleApi.js';
import authRoutes, { destroyUserSessions } from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import mailNodeRoutes from './routes/mailNode.js';
import { startMailNodeDiskWatch } from './services/mailNode/diskWatch.js';
import { adoptDomainsWithMailboxes } from './services/mailNode/domains.js';
import mailRoutes from './routes/mail.js';
import searchRoutes from './routes/search.js';
import adminRoutes from './routes/admin.js';
import totpRoutes from './routes/totp.js';
import oidcApiRouter, { oidcBrowserRouter } from './routes/oidc.js';
import rulesRoutes from './routes/rules.js';
import blockListRoutes from './routes/blockList.js';
import contactsRoutes from './routes/contacts.js';
import todoistRoutes from './routes/todoist.js';
import aiRoutes from './routes/ai.js';
import categoriesRoutes from './routes/categories.js';
import { pluginRegistry } from './plugins/registry.js';
import { loadBundledPlugins } from './plugins/loadPlugins.js';
import { setMailEngine } from './plugins/mailEngine.js';
import pluginsRoutes from './routes/plugins.js';
import senderFaviconsRoutes from './routes/senderFavicons.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import healthRoutes from './routes/health.js';
import { encryptExistingCredentials, query } from './services/db.js';
import { runMigrations } from './services/migrations.js';
import { parseVCard } from './utils/vcard.js';
import { reloadAuthSettings } from './services/authLimiter.js';
import { closeUserSockets, setupWebSocket } from './services/websocket.js';
import { ImapManager } from './services/imapManager.js';
import { loadSyncSettings } from './services/syncSettings.js';
import { getUpdateStatus } from './services/updateCheck.js';
import { recordHttp } from './services/performanceMetrics.js';
import { defaultEmptyBody } from './middleware/defaultEmptyBody.js';
import { authSettingsError, getAuthSettings } from './services/auth/authSettings.js';
import { startAccessSync } from './services/accessSync/index.js';
import { identityGate } from './middleware/identityGate.js';
import { providerThreadIndexState } from './services/threading/providerThreadIndex.js';

const packageMeta = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
let buildMeta = {};
try {
  buildMeta = JSON.parse(readFileSync(new URL('../build-meta.json', import.meta.url), 'utf-8'));
} catch {
  // Local dev runs may not have build metadata yet.
}
const APP_VERSION = (process.env.APP_VERSION || buildMeta.version || packageMeta.version).replace(/^v[.]?/, '');

const app = express();
// Trust the nginx reverse proxy so req.secure reflects HTTPS correctly.
// Without this, express-session sees HTTP (from nginx) and refuses to set
// the Secure cookie, meaning the session cookie is never sent to the browser.
app.set('trust proxy', 1);
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Redis — connect the shared client before any route or session middleware uses it.
await redisClient.connect();

// Fail fast if required secrets are missing
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('FATAL: SESSION_SECRET must be set and at least 32 characters. Exiting.');
  process.exit(1);
}
if (!process.env.DB_PASSWORD) {
  console.error('FATAL: DB_PASSWORD must be set. Exiting.');
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
  console.error('FATAL: ENCRYPTION_KEY must be set and exactly 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  process.exit(1);
}
// A google sign-in mode without any way to sign in would lock everyone out.
const authConfigError = authSettingsError();
if (authConfigError) {
  console.error(`FATAL: ${authConfigError} Exiting.`);
  process.exit(1);
}
// APP_URL is required in production: without it every browser WebSocket connection
// is rejected (websocket.js closes connections that send an Origin header when
// ALLOWED_ORIGIN is null), and OIDC redirect URIs become malformed.
if (process.env.NODE_ENV === 'production' && !process.env.APP_URL) {
  console.error('FATAL: APP_URL must be set in production (e.g. https://mail.example.com). WebSocket connections and OIDC depend on it.');
  process.exit(1);
}

// Session — options live in utils/sessionConfig.js so they can be exercised by tests.
const sessionMiddleware = session(
  buildSessionOptions(new RedisStore({ client: redisClient }), process.env.SESSION_SECRET)
);

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

// Performance baseline: time the full request lifecycle and record it under the
// matched route *pattern* (never the concrete URL, so no ids/PII and bounded
// cardinality). Registered early so body-parse/session/routing are all included;
// req.route is populated by the time 'finish' fires. Behavior-neutral.
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const pattern = typeof req.route?.path === 'string'
      ? (req.baseUrl || '') + req.route.path
      : (req.baseUrl || 'unmatched'); // fall back to the mount, never req.path (unbounded)
    recordHttp(`${req.method} ${pattern || '/'}`, ms, res.statusCode >= 500);
  });
  next();
});

// Security headers on every response
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// 25 MB attachment limit → ~34 MB base64 on the wire; add headroom for the rest of the payload.
app.use('/api/mail/send', express.json({ limit: '35mb' }));
app.use('/api/mail/draft', express.json({ limit: '35mb' }));
// A pet-import body carries a base64 spritesheet (~33% larger than the 5 MB sheet cap
// enforced after decode in gtdPet.importPet), so it needs more than the global 1 MB.
app.use('/api/gtd/pet/import', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '1mb' }));
// Express 5 leaves req.body undefined when no parser ran; handlers destructure it directly.
app.use(defaultEmptyBody);
// Return a clean JSON error when the body parser rejects an oversized payload.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large. Total attachment size must not exceed 25 MB.' });
  }
  next(err);
});
app.use(sessionMiddleware);

// Google sign-in mode: every request to these surfaces needs an approved, active user (a
// Cloudflare Access token or a direct Google sign-in session); local sign-in routes are 404.
app.use(['/api', '/oauth', '/auth/oidc'], identityGate);

// CSRF defense-in-depth for the cookie-authenticated /api surface. A mutating
// request must carry a custom header that a cross-site <form> cannot set and a
// cross-origin fetch cannot send without a CORS preflight — which the CORS policy
// above restricts to FRONTEND_URL. SameSite=lax cookies are the primary defense;
// this closes same-site/subdomain and legacy-browser gaps. OAuth flows (/oauth) are
// mounted outside /api and use their own auth, so they are intentionally not gated here.
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use('/api', (req, res, next) => {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (req.get('X-Requested-With')) return next();
  return res.status(403).json({ error: 'Missing required X-Requested-With header' });
});

// Screen-lock enforcement (#235). A locked session may only reach the endpoints
// needed to render the lock screen, unlock, or sign out; everything else returns
// 423 Locked until the PIN is verified (routes/auth.js sets req.session.locked).
// Matches the full path (minus query) so it can't fail open on mount-relative paths.
const LOCK_ALLOWED = new Set(['/api/auth/unlock', '/api/auth/logout', '/api/auth/me', '/api/health', '/api/health/ready', '/api/version']);
app.use('/api', (req, res, next) => {
  if (req.session?.locked && !LOCK_ALLOWED.has(req.originalUrl.split('?')[0])) {
    return res.status(423).json({ error: 'Locked', locked: true });
  }
  next();
});

// Make imap manager available globally
export const imapManager = new ImapManager(wss);
app.set('imapManager', imapManager);
// Hand the mail engine to the plugin platform so plugin-api capabilities (labels, archive,
// broadcast) can be bound to it without any plugin importing the mail engine or this entry file.
setMailEngine(imapManager);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/auth/oidc', oidcApiRouter);
app.use('/auth/oidc', oidcBrowserRouter);
app.use('/oauth/login/google', authGoogleRoutes);
app.use('/oauth', oauthRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/oauth/google', oauthGoogleApiRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/mail-node', mailNodeRoutes);
app.use('/api/mail', mailRoutes);
app.use('/api/mail', sendRoutes);
app.use('/api/mail', draftRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/totp', totpRoutes);
app.use('/api/rules', rulesRoutes);
app.use('/api/block-list', blockListRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/todoist', todoistRoutes);
app.use('/api', aiRoutes);
app.use('/api', categoriesRoutes);
// Tier-1 plugin routers, mounted via the plugin registry (see src/plugins/). Registered
// here — before the unauthenticated /api/health and /api/version probes below — so a
// plugin's router-level auth can't intercept them. GTD is the first such plugin; its
// router mounts at /api/gtd exactly as before.
loadBundledPlugins();
// Platform API: list registered plugins + per-user activation (must be after loadBundledPlugins).
app.use('/api/plugins', pluginsRoutes);
for (const plugin of pluginRegistry.list()) {
  if (plugin.router) app.use(plugin.router.base, plugin.router.handler);
}
app.use('/api/sender-favicons', senderFaviconsRoutes);
app.use('/api/diagnostics', diagnosticsRoutes);

app.use('/api/health', healthRoutes);
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION, sha: process.env.BUILD_SHA || 'dev' }));
// Server-side update check (#261). Cached in updateCheck.js so repeated hits never
// re-query GitHub; the browser only talks to MailExpert. Never throws into the response.
app.get('/api/update', async (_req, res) => {
  try { res.json(await getUpdateStatus(APP_VERSION)); }
  catch { res.json({ current: APP_VERSION, latest: null, updateAvailable: false, disabled: false }); }
});

// Catch unhandled errors thrown (or rejected) inside async route handlers.
// Express 5 forwards a rejected async handler here natively.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// WebSocket
setupWebSocket(wss, sessionMiddleware);

// Run pending schema migrations then start
await runMigrations();

// Mail node domains that already hold panel mailboxes keep taking new ones: they are recorded as
// ready before the server takes requests (services/mailNode/domains.js).
const adoptedDomains = await adoptDomainsWithMailboxes();
if (adoptedDomains.length) console.log(`Mail node: took in ${adoptedDomains.length} domain(s) with mailboxes as ready`);

// Resume the queued server MOVEs of DB-first moves (services/moveQueue.js) before any mailbox
// syncs: the guards that keep sync from re-adding a moved letter at its source live in memory and
// are rebuilt here from the queue.
const resumedMoves = await imapManager.moveQueue.resume();
if (resumedMoves) console.log(`Move queue: resumed ${resumedMoves} pending move(s)`);

// A failed concurrent build (migration 0061) leaves an unusable index that no later migration repairs.
providerThreadIndexState(query)
  .then(state => {
    if (state !== 'valid') {
      console.warn(`Index idx_messages_provider_thread is ${state}: drop it and rerun the CREATE INDEX CONCURRENTLY from migration 0061`);
    }
  })
  .catch(err => console.warn('Provider thread index check failed:', err.message));

// One-time backfill: populate photo_data from the stored vcard for contacts saved
// before photo_data was persisted.
async function backfillContactPhotos() {
  const { rows } = await query(
    `SELECT id, vcard FROM contacts WHERE vcard IS NOT NULL AND photo_data IS NULL`
  );
  if (!rows.length) return;

  let count = 0;
  for (const row of rows) {
    const parsed = parseVCard(row.vcard);
    if (!parsed.photoData) continue;
    await query('UPDATE contacts SET photo_data = $1 WHERE id = $2', [parsed.photoData, row.id]);
    count++;
  }
  if (count > 0) console.log(`Backfilled contact photos for ${count} contact(s)`);
}
await backfillContactPhotos();

// Load configurable auth rate limit values from DB (seeded by migration above).
await reloadAuthSettings();

// Encrypt any plaintext credentials left in the DB from before this feature was added
await encryptExistingCredentials();

// Load OAuth integration configs from DB into process.env
await loadIntegrationConfigs();

// Start background snooze watcher — polls every 60 seconds to restore snoozed messages
imapManager.startSnoozeWatcher();

// Read the mail node's disk every 10 minutes and ping the administrator's check URL.
startMailNodeDiskWatch();

// Keep the Cloudflare Access policy in line with approved users; only google mode approves users.
if (getAuthSettings().mode === 'google') {
  startAccessSync({
    signOutUser: async (userId) => {
      await destroyUserSessions(userId);
      closeUserSockets(wss, userId);
    },
  });
}

// Mailboxes are serviced by the server: apply the install-wide sync cadence, then connect every
// enabled IMAP mailbox through a bounded queue (IMAP_CONNECT_CONCURRENCY). Signing in, signing
// out and sockets never connect them.
try {
  await imapManager.applySyncSettings(await loadSyncSettings());
} catch (err) {
  console.error('Loading mailbox sync intervals failed, using the defaults:', err.message);
}
imapManager.connectAllEnabled()
  .catch(err => console.error('Startup mailbox connection error:', err.message));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`MailExpert backend running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  httpServer.close(async () => {
    // close() lets pending commands finish before the connection is shut down.
    try { await redisClient.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  // Force exit if graceful shutdown takes more than 10 s
  setTimeout(() => process.exit(1), 10_000).unref();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
