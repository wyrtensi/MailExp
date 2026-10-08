import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';

const router = Router();
router.use(requireAuth);

// code -> [HTTP status, text]. Todoist's own status never becomes the panel's (its 401 would read
// as the panel session expiring), and neither its body nor a database error reaches the browser:
// the detail goes to the server log with the user it happened to.
const TODOIST_ERRORS = Object.freeze({
  todoist_not_connected: [409, 'Todoist is not connected'],
  todoist_token_required: [400, 'API token is required'],
  todoist_token_invalid: [409, 'Todoist refused the saved API token. Connect Todoist again.'],
  todoist_unavailable: [502, 'Todoist did not answer. Try again later.'],
  todoist_task_title_required: [400, 'Task title is required'],
  todoist_failed: [500, 'The Todoist request failed'],
});

class TodoistError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

function refuse(res, code) {
  const [status, error] = TODOIST_ERRORS[code];
  return res.status(status).json({ error, code });
}

function todoistFailure(req, res, err, what) {
  const code = err instanceof TodoistError ? err.code : 'todoist_failed';
  if (code !== 'todoist_not_connected') {
    console.error(`Todoist ${what} failed for user ${req.session?.userId}: ${code}: ${err?.message || err}`);
  }
  return refuse(res, code);
}

async function getTodoistToken(userId) {
  const result = await query(
    "SELECT config FROM user_integrations WHERE user_id = $1 AND provider = 'todoist'",
    [userId]
  );
  if (!result.rows.length) throw new TodoistError('todoist_not_connected');
  return decrypt(result.rows[0].config.token);
}

async function todoistFetch(token, method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(`https://api.todoist.com/api/v1${path}`, opts);
  } catch (err) {
    throw new TodoistError('todoist_unavailable', `${method} ${path}: ${err?.cause?.code || err?.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const code = res.status === 401 || res.status === 403 ? 'todoist_token_invalid' : 'todoist_unavailable';
    throw new TodoistError(code, `${method} ${path}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

// GET /api/todoist/status
router.get('/status', async (req, res) => {
  try {
    const result = await query(
      "SELECT id FROM user_integrations WHERE user_id = $1 AND provider = 'todoist'",
      [req.session.userId]
    );
    res.json({ connected: result.rows.length > 0 });
  } catch (err) {
    todoistFailure(req, res, err, 'status');
  }
});

// POST /api/todoist/connect
router.post('/connect', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || !token.trim()) return refuse(res, 'todoist_token_required');
  const trimmed = token.trim();

  try {
    // Validate token against Todoist before storing
    let testRes;
    try {
      testRes = await fetch('https://api.todoist.com/api/v1/projects', {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
    } catch (err) {
      throw new TodoistError('todoist_unavailable', `token check: ${err?.cause?.code || err?.message}`);
    }
    // Drain body to allow connection reuse
    await testRes.body?.cancel();
    if (!testRes.ok) {
      // The token typed into the form: the same 400 and text as before, now with the code.
      return res.status(400).json({ error: 'Invalid Todoist API token', code: 'todoist_token_invalid' });
    }

    const encryptedToken = encrypt(trimmed);
    await query(`
      INSERT INTO user_integrations (user_id, provider, config)
      VALUES ($1, 'todoist', $2)
      ON CONFLICT (user_id, provider) DO UPDATE
      SET config = EXCLUDED.config, updated_at = NOW()
    `, [req.session.userId, { token: encryptedToken }]);

    res.json({ ok: true });
  } catch (err) {
    todoistFailure(req, res, err, 'connect');
  }
});

// DELETE /api/todoist/disconnect
router.delete('/disconnect', async (req, res) => {
  try {
    await query(
      "DELETE FROM user_integrations WHERE user_id = $1 AND provider = 'todoist'",
      [req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    todoistFailure(req, res, err, 'disconnect');
  }
});

// GET /api/todoist/projects
router.get('/projects', async (req, res) => {
  try {
    const token = await getTodoistToken(req.session.userId);
    const data = await todoistFetch(token, 'GET', '/projects');
    res.json(data.results ?? data);
  } catch (err) {
    todoistFailure(req, res, err, 'projects');
  }
});

// GET /api/todoist/labels
router.get('/labels', async (req, res) => {
  try {
    const token = await getTodoistToken(req.session.userId);
    const data = await todoistFetch(token, 'GET', '/labels');
    res.json(data.results ?? data);
  } catch (err) {
    todoistFailure(req, res, err, 'labels');
  }
});

// POST /api/todoist/tasks
router.post('/tasks', async (req, res) => {
  try {
    const token = await getTodoistToken(req.session.userId);
    const { content, description, project_id, labels, priority, due_string, due_date } = req.body;
    if (typeof content !== 'string' || !content.trim()) return refuse(res, 'todoist_task_title_required');
    const taskData = { content: content.trim() };
    if (description) taskData.description = description;
    if (project_id) taskData.project_id = project_id;
    if (labels?.length) taskData.labels = labels;
    if (priority && priority > 1) taskData.priority = priority;
    if (due_string) taskData.due_string = due_string;
    if (due_date) taskData.due_date = due_date;
    const task = await todoistFetch(token, 'POST', '/tasks', taskData);
    res.json({ ...task, url: `https://app.todoist.com/app/task/${task.id}` });
  } catch (err) {
    todoistFailure(req, res, err, 'task');
  }
});

export default router;
