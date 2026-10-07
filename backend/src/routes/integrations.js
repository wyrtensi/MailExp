import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  MICROSOFT_INTEGRATION_ERRORS, MICROSOFT_PROVIDER, applyMicrosoftEnv, clearMicrosoftEnv, redactConfig,
  removeMicrosoftIntegration, saveMicrosoftIntegration,
} from '../services/integrations/microsoft.js';
import { importLegacyGoogleConfig, resolveGoogleConfig } from '../services/oauth/googleApps.js';
import { googleHasCapacity } from '../services/oauth/googleAppSelection.js';
import { MAIL_NODE_PROVIDER, getMailNodeConfig } from '../services/mailNode/mailcow.js';
import { GOOGLE_CALLBACK_PATH } from '../services/oauth/constants.js';

const router = Router();

// Rows of integration_config that belong to the mail node, not to this screen: 'mail_node' and every
// 'mail_node_*' row (EOP settings, DNS check, apply result, alert settings and state, and what later
// stages add).
const isMailNodeRow = (provider) => provider === MAIL_NODE_PROVIDER || String(provider).startsWith(`${MAIL_NODE_PROVIDER}_`);

// GOOGLE_REDIRECT_URI as the process started with it (docker-compose.yml passes it through).
// Captured once: applyGoogleEnv overwrites process.env, and the startup value must stay the
// fallback for a stored google row without a callback URL (rows written before PR 8a).
const STARTUP_GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || null;

// Mirror the stored Google callback URL into process.env, falling back to the startup value.
// Client credentials live in google_oauth_apps, so only the redirect URI is kept in
// integration_config.
function applyGoogleEnv(config) {
  const redirectUri = config?.redirectUri || STARTUP_GOOGLE_REDIRECT_URI;
  if (redirectUri) process.env.GOOGLE_REDIRECT_URI = redirectUri;
  else delete process.env.GOOGLE_REDIRECT_URI;
}

// The shared Google callback URL: an absolute http(s) address on the callback path, trimmed,
// without a query or fragment. Null for anything else, so a relative path or a script URL never
// reaches process.env or the OAuth redirect, and a URL Google would send back to a page that does
// not finish the flow (another path), or that the redirect cannot rebuild for another public host
// (getGoogleRedirectUri keeps only the path), is refused here.
function parseRedirectUri(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /[?#]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.pathname === GOOGLE_CALLBACK_PATH ? trimmed : null;
  } catch {
    return null;
  }
}

router.use(requireAuth);

// Get all integration configs (secrets redacted) — admin only (exposes OAuth client IDs)
router.get('/', requireAdmin, async (req, res) => {
  const result = await query(
    'SELECT provider, config, updated_at FROM integration_config'
  );

  // Redact secrets from response. The mail node rows have their own admin endpoints
  // (/api/mail-node) and this screen never reads them, so they are left out entirely.
  const configs = {};
  for (const row of result.rows) {
    if (isMailNodeRow(row.provider)) continue;
    configs[row.provider] = { ...redactConfig(row.config), updated_at: row.updated_at };
  }
  // Google clients live in google_oauth_apps (/api/admin/google-apps); only the shared
  // callback URL is a setting here. Legacy client fields left in the row are never returned.
  const stored = configs.google || {};
  const redirectUri = stored.redirectUri || process.env.GOOGLE_REDIRECT_URI || null;
  delete configs.google;
  if (redirectUri || stored.updated_at) {
    configs.google = {
      ...(redirectUri ? { redirectUri } : {}),
      ...(stored.updated_at ? { updated_at: stored.updated_at } : {}),
    };
  }
  res.json(configs);
});

// Capability check for any authenticated user (non-admins included). Reports only
// whether each provider is configured — never the client ID, secret, or any other
// credential. This lets a non-admin see that Microsoft OAuth is available and enable
// the connect buttons, while the config read/write/delete endpoints stay admin-only.
// The OAuth connect routes already require only an authenticated session and bind the
// resulting mailbox to that user, so no privilege is granted here. (#315)
// A Redis error from googleHasCapacity must not fail the whole response: Microsoft's
// configured flag has nothing to do with Google's capacity check.
async function googleAvailable(configured) {
  if (!configured) return false;
  try {
    return await googleHasCapacity();
  } catch (err) {
    console.error(`Google OAuth capacity check failed: ${err?.name || 'Error'}`);
    return false;
  }
}

router.get('/status', async (req, res) => {
  const configured = !!(await resolveGoogleConfig());
  res.json({
    microsoft: {
      configured: !!process.env.MS_CLIENT_ID,
    },
    google: {
      configured,
      // Whether an active app still has a free seat. Without one the Gmail form stays usable with
      // a note: an address an app already counted goes back there without a seat, and the start
      // route decides per address (no_app_capacity otherwise).
      available: await googleAvailable(configured),
    },
    // Whether the add-mailbox dialog offers a mailbox on the mail node.
    domainMail: {
      configured: !!(await getMailNodeConfig()),
    },
  });
});

// Save/update integration config — admin only (writes affect global OAuth env vars)
router.post('/:provider', requireAdmin, async (req, res) => {
  const { provider } = req.params;
  const allowed = ['microsoft', 'google'];
  if (!allowed.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });

  if (provider === 'google') {
    // Only the shared callback URL is stored here: apps are managed at /api/admin/google-apps,
    // so any client ID or secret in the body is ignored.
    const redirectUri = parseRedirectUri(req.body?.redirectUri);
    if (!redirectUri) {
      return res.status(400).json({ error: `Callback URL must be a full http or https address with the path ${GOOGLE_CALLBACK_PATH} and no query or fragment`, code: 'redirect_uri_invalid' });
    }
    const googleConfig = { redirectUri };
    await query(`
      INSERT INTO integration_config (provider, config)
      VALUES ($1, $2)
      ON CONFLICT (provider) DO UPDATE
      SET config = EXCLUDED.config, updated_at = NOW()
    `, [provider, googleConfig]);
    applyGoogleEnv(googleConfig);
    return res.json({ ok: true });
  }

  // Microsoft: services/integrations/microsoft.js keeps or encrypts the secret and refuses one
  // typed into the redacted field.
  const result = await saveMicrosoftIntegration(req.body);
  if (result.error) {
    const [status, message] = MICROSOFT_INTEGRATION_ERRORS[result.error];
    return res.status(status).json({ error: message, code: result.error });
  }
  // Write plaintext values to process.env so oauth routes pick them up immediately
  applyMicrosoftEnv(result.config);
  res.json({ ok: true });
});

// Delete integration config — admin only. Google has no deletable settings any more: its apps
// are disabled or removed at /api/admin/google-apps, and the callback URL is only replaced.
router.delete('/:provider', requireAdmin, async (req, res) => {
  if (req.params.provider !== 'microsoft') return res.status(400).json({ error: 'Unknown provider' });
  await removeMicrosoftIntegration();
  clearMicrosoftEnv();
  res.json({ ok: true });
});

// Load saved configs into process.env on startup
export async function loadIntegrationConfigs() {
  try {
    const result = await query('SELECT provider, config FROM integration_config');
    for (const row of result.rows) {
      if (row.provider === MICROSOFT_PROVIDER) {
        applyMicrosoftEnv(row.config);
      } else if (row.provider === 'google') {
        applyGoogleEnv(row.config);
      }
    }
    console.log('Integration configs loaded');
  } catch (err) {
    console.error('Failed to load integration configs:', err.message);
  }
  // Runs after the stored callback URL is applied; logs only a code so a failure never
  // prints SQL, secrets or provider text.
  try {
    await importLegacyGoogleConfig();
  } catch (err) {
    console.error(`Google OAuth app import failed: ${err?.code || err?.name || 'Error'}`);
  }
}

export default router;
