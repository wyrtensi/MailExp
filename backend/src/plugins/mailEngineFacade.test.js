import { describe, it, expect, vi } from 'vitest';
import { createPluginMailFacade } from './mailEngineFacade.js';

// GTD marks its follow-up folder sync and its label strips as background work, so they cannot
// take the pooled session kept for user actions. The facade must hand that option to the engine.
describe('plugin mail facade', () => {
  const engine = () => ({ syncFolderOnDemand: vi.fn(async () => {}), removeMessageCopy: vi.fn(async () => 1) });

  it('passes a folder sync\'s options to the engine', async () => {
    const e = engine();
    await createPluginMailFacade(e).syncFolderOnDemand({ id: 'a1' }, 'Todo', { background: true });
    expect(e.syncFolderOnDemand).toHaveBeenCalledWith({ id: 'a1' }, 'Todo', { background: true });
  });

  it('passes a label strip\'s options to the engine', async () => {
    const e = engine();
    await createPluginMailFacade(e).removeMessageCopy('a1', 7, 'Todo', { background: true });
    expect(e.removeMessageCopy).toHaveBeenCalledWith('a1', 7, 'Todo', { background: true });
  });

  it('passes a copy check and the label-store question to the engine', async () => {
    const e = { hasMessageCopy: vi.fn(async () => true), isLabelStore: vi.fn(() => true) };
    const facade = createPluginMailFacade(e);
    expect(await facade.hasMessageCopy({ id: 'a1' }, 55, 'INBOX', '<m@x>', { background: true })).toBe(true);
    expect(e.hasMessageCopy).toHaveBeenCalledWith({ id: 'a1' }, 55, 'INBOX', '<m@x>', { background: true });
    expect(facade.isLabelStore({ id: 'a1' })).toBe(true);
    expect(e.isLabelStore).toHaveBeenCalledWith({ id: 'a1' });
  });
});
