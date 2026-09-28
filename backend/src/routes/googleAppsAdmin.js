import { Router } from 'express';
import {
  GOOGLE_APP_STATUSES,
  GoogleAppError,
  createGoogleApp,
  deleteGoogleApp,
  getEffectiveGoogleRedirectUri,
  getGoogleAppSummary,
  listGoogleApps,
  setGoogleAppStatus,
  updateGoogleApp,
} from '../services/oauth/googleApps.js';
import { googleClientJsonWarnings, parseGoogleClientJson } from '../services/oauth/googleClientJson.js';
import { countGoogleReservations } from '../services/oauth/googleAppSelection.js';
import { uuidParam } from '../utils/uuid.js';

// Mounted by routes/admin.js behind requireAdmin at /api/admin/google-apps.
const router = Router();
router.param('id', uuidParam('id'));

// Placeholder the admin screen shows for a stored secret; sending it back keeps the secret.
const REDACTED_SECRET = '••••••••';

const ERRORS = {
  label_invalid: [400, 'Name must be 1 to 100 characters'],
  client_id_invalid: [400, 'Client ID is not a Google OAuth client ID'],
  client_secret_required: [400, 'Client secret is required'],
  client_secret_redacted: [400, 'Client secret contains the redaction placeholder; enter the full secret'],
  user_limit_invalid: [400, 'User limit must be a positive whole number'],
  app_status_invalid: [400, 'Unknown app status'],
  app_exists: [409, 'This client ID is already added'],
  app_same_project: [409, 'An app from this Google Cloud project is already added'],
  app_in_use: [409, 'The app still has connected mailboxes'],
  app_not_found: [404, 'App not found'],
  client_json_invalid: [400, 'The file is not valid JSON, or is not a Google OAuth client file'],
  client_json_service_account: [400, 'This is a service account key, not an OAuth client. Download the OAuth client JSON from Credentials -> OAuth client instead'],
  client_json_not_web: [400, 'This is a desktop (installed) OAuth client. Create a Web application client instead'],
  client_json_incomplete: [400, 'The file is missing a client ID or client secret'],
  client_json_conflict: [400, 'Provide either the client JSON file or a client ID and secret, not both'],
};

function refuse(res, code) {
  const [status, error] = ERRORS[code];
  return res.status(status).json({ error, code });
}

function handleRegistryError(res, err) {
  if (err instanceof GoogleAppError && ERRORS[err.code]) return refuse(res, err.code);
  throw err;
}

// A secret field that is exactly the placeholder or empty keeps the stored value; one that
// mixes the placeholder with typed text would overwrite the real secret with junk.
function secretFromBody(value) {
  if (typeof value !== 'string' || value === '' || value === REDACTED_SECRET) return { secret: null };
  if (value.includes('•')) return { error: 'client_secret_redacted' };
  return { secret: value };
}

async function toApi(row) {
  const reservedCount = await countGoogleReservations(row.id);
  return {
    id: row.id,
    label: row.label,
    clientId: row.client_id,
    projectNumber: row.project_number,
    userLimit: row.user_limit,
    status: row.status,
    grantsCount: row.grants_count ?? 0,
    reservedCount,
    accountsCount: row.accounts_count ?? 0,
    // "Full" is not a stored status: an active app whose counted seats reached its limit.
    full: row.status === 'active' && (row.grants_count ?? 0) + reservedCount >= row.user_limit,
    createdAt: row.created_at,
  };
}

router.get('/', async (_req, res) => {
  const rows = await listGoogleApps();
  res.json({ apps: await Promise.all(rows.map(toApi)) });
});

// A body field counts as "given" only when it has real content: an empty string alongside
// clientJson (what an untouched form field sends) must not trip the "not both" refusal.
function hasContent(value) {
  return typeof value === 'string' && value.trim() !== '';
}

router.post('/', async (req, res) => {
  const body = req.body || {};
  const hasClientJson = hasContent(body.clientJson);
  const hasManualFields = hasContent(body.clientId) || hasContent(body.clientSecret);
  if (hasClientJson && hasManualFields) return refuse(res, 'client_json_conflict');

  let clientId = body.clientId;
  let clientSecretInput = body.clientSecret;
  let label = body.label;
  let warnings = [];

  if (hasClientJson) {
    let parsed;
    try {
      parsed = parseGoogleClientJson(body.clientJson);
    } catch (err) {
      return handleRegistryError(res, err);
    }
    clientId = parsed.clientId;
    clientSecretInput = parsed.clientSecret;
    if (!hasContent(label)) label = parsed.projectId;
    const expected = await getEffectiveGoogleRedirectUri();
    warnings = googleClientJsonWarnings(parsed.redirectUris, expected);
  }

  const { secret, error } = secretFromBody(clientSecretInput);
  if (error) return refuse(res, error);
  try {
    const row = await createGoogleApp({
      label,
      clientId,
      clientSecret: secret,
      userLimit: body.userLimit ?? 100,
    });
    res.status(201).json({ app: await toApi(row), warnings });
  } catch (err) {
    return handleRegistryError(res, err);
  }
});

router.patch('/:id', async (req, res) => {
  const body = req.body || {};
  const { secret, error } = secretFromBody(body.clientSecret);
  if (error) return refuse(res, error);
  if (body.status !== undefined && !GOOGLE_APP_STATUSES.includes(body.status)) return refuse(res, 'app_status_invalid');
  try {
    await updateGoogleApp(req.params.id, { label: body.label, clientSecret: secret, userLimit: body.userLimit });
    // Always applied when sent: setGoogleAppStatus is idempotent, and disabling again re-flags
    // mailboxes a previous disable may have left half done.
    if (body.status !== undefined) {
      const flagged = await setGoogleAppStatus(req.params.id, body.status);
      // Their tokens came from a client that no longer refreshes: drop the live connections.
      const manager = req.app.get('imapManager');
      for (const accountId of flagged) {
        Promise.resolve(manager?.disconnectAccount(accountId)).catch(() => {});
      }
    }
    // Re-read so the response carries the grants/accounts counts as they stand now:
    // updateGoogleApp's own return only has the columns it wrote.
    const row = await getGoogleAppSummary(req.params.id);
    if (!row) return refuse(res, 'app_not_found');
    res.json({ app: await toApi(row) });
  } catch (err) {
    return handleRegistryError(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteGoogleApp(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    return handleRegistryError(res, err);
  }
});

export default router;
