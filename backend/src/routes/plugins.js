// Plugin management API (v3.0 plugin platform).
//
// Lists the plugins registered in this build and whether each is enabled. The switch is one per
// plugin for the whole panel (system_settings.enabled_plugins): every signed-in user may read it,
// because the client shows a plugin's features only while it is on, and only an administrator may
// flip it. A real flip is written to the audit journal, fires the generic `onPluginActivationChanged`
// hook so the affected plugin can react (GTD drops its cached config so the change takes effect at
// once) — core never calls a plugin directly — and tells every signed-in browser (`plugins_changed`)
// to read the list again, so a plugin's features appear or go away without a reload.
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { pluginRegistry } from '../plugins/registry.js';
import { getEnabledPlugins, setPluginEnabled } from '../plugins/activation.js';
import { recordAudit } from '../services/auditLog.js';
import { imapManager } from '../index.js';

const router = Router();
router.use(requireAuth);

// The user-facing view of a registered plugin. Deliberately minimal — no handlers/hooks/router.
function publicManifest(plugin, enabled) {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    tier: plugin.tier,
    enabled,
  };
}

// GET /api/plugins — every registered plugin plus whether it is enabled for the panel.
router.get('/', async (_req, res) => {
  const enabled = await getEnabledPlugins();
  res.json(pluginRegistry.list().map((p) => publicManifest(p, enabled.has(p.id))));
});

// PATCH /api/plugins/:id — enable/disable a plugin for every user. Administrators only.
// Body: { enabled }.
router.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!pluginRegistry.has(id)) return res.status(404).json({ error: 'Unknown plugin' });
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }
  const enabled = req.body.enabled;
  const { changed } = await setPluginEnabled(id, enabled);

  // A PATCH that leaves the plugin as it was changes nothing: no journal entry, no hook, no event.
  if (changed) {
    const plugin = pluginRegistry.get(id);
    recordAudit([{
      actorUserId: req.session.userId,
      action: enabled ? 'plugin.enabled' : 'plugin.disabled',
      details: { pluginId: id, name: plugin?.name ?? id },
    }]);
    console.log(`[plugins] ${req.session.userId} ${enabled ? 'enabled' : 'disabled'} plugin ${id}`);

    // Let the plugin react to the switch (e.g. GTD drops its per-account config cache so the
    // effective gate flips immediately). Errors are swallowed per-plugin by the registry.
    await pluginRegistry.runHook('onPluginActivationChanged', { pluginId: id, enabled });

    // Every signed-in user's browser re-reads GET /api/plugins.
    imapManager.broadcast({ type: 'plugins_changed', pluginId: id, enabled });
  }

  res.json({ id, enabled });
});

export default router;
