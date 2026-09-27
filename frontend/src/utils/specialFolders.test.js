import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTrashOrJunkFolder } from './specialFolders.js';

describe('isTrashOrJunkFolder', () => {
  it('matches by special_use, the way Gmail\'s [Gmail]/Trash and [Gmail]/Spam resolve', () => {
    const folders = [
      { path: '[Gmail]/Trash', name: 'Trash', special_use: '\\Trash' },
      { path: '[Gmail]/Spam', name: 'Spam', special_use: '\\Junk' },
      { path: 'INBOX', name: 'INBOX', special_use: null },
    ];
    assert.equal(isTrashOrJunkFolder('[Gmail]/Trash', folders), true);
    assert.equal(isTrashOrJunkFolder('[Gmail]/Spam', folders), true);
    assert.equal(isTrashOrJunkFolder('INBOX', folders), false);
  });

  it('falls back to the multilingual name heuristic when special_use is absent', () => {
    const folders = [
      { path: 'Deleted Items', name: 'Deleted Items', special_use: null },
      { path: 'Courrier indésirable', name: 'Courrier indésirable', special_use: null },
      { path: 'Archive', name: 'Archive', special_use: null },
    ];
    assert.equal(isTrashOrJunkFolder('Deleted Items', folders), true);
    assert.equal(isTrashOrJunkFolder('Courrier indésirable', folders), true);
    assert.equal(isTrashOrJunkFolder('Archive', folders), false);
  });

  it('falls back to the raw path when the folder is not in the synced list yet', () => {
    assert.equal(isTrashOrJunkFolder('Trash', []), true);
    assert.equal(isTrashOrJunkFolder('Junk', []), true);
    assert.equal(isTrashOrJunkFolder('Projects/Trashcan Ideas', []), true); // matches the heuristic, same as the server would
    assert.equal(isTrashOrJunkFolder('INBOX', []), false);
  });

  it('is false for no folder', () => {
    assert.equal(isTrashOrJunkFolder(null, []), false);
    assert.equal(isTrashOrJunkFolder(undefined, []), false);
    assert.equal(isTrashOrJunkFolder('', []), false);
  });
});
