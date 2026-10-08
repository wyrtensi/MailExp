import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireMailbox } from '../utils/requireMailbox.js';
import { uuidParam } from '../utils/uuid.js';

const router = Router();
router.param('id', uuidParam('id'));
router.use(requireAuth);

// The block list of every mailbox; each entry names the mailbox it applies to.
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM block_list ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /block-list error:', err.message);
    res.status(500).json({ error: 'Failed to load block list' });
  }
});

router.post('/', async (req, res) => {
  const { accountId, emailAddress } = req.body;
  if (!emailAddress || typeof emailAddress !== 'string' || !emailAddress.trim()) {
    return res.status(400).json({ error: 'emailAddress is required' });
  }
  const email = emailAddress.trim().toLowerCase();
  try {
    const mailboxId = await requireMailbox(accountId, res);
    if (!mailboxId) return;
    const result = await query(
      `INSERT INTO block_list (account_id, email_address)
       VALUES ($1, $2)
       ON CONFLICT (account_id, email_address) DO NOTHING
       RETURNING *`,
      [mailboxId, email]
    );
    const row = result.rows[0] ?? (
      await query('SELECT * FROM block_list WHERE account_id = $1 AND email_address = $2', [mailboxId, email])
    ).rows[0];
    res.status(201).json(row);
  } catch (err) {
    console.error('POST /block-list error:', err.message);
    res.status(500).json({ error: 'Failed to add to block list' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM block_list WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /block-list/:id error:', err.message);
    res.status(500).json({ error: 'Failed to remove from block list' });
  }
});

export default router;
