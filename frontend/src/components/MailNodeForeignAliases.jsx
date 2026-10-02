import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { foreignNodeAliases, mailboxPrefillFromAlias } from '../utils/mailNode.js';
import ConfirmOverlay from './ConfirmOverlay.jsx';
import DomainMailboxAddForm from './DomainMailboxAddForm.jsx';

const buttonStyle = {
  padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 500, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
};
const primaryButtonStyle = { ...buttonStyle, background: 'var(--accent)', border: 'none', color: 'var(--accent-text)' };
const cellStyle = { padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', fontSize: 12, textAlign: 'left', verticalAlign: 'top' };
const headCellStyle = { ...cellStyle, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' };

// Settings -> Integrations -> "Aliases with another address" (admins only), under "Mail node".
// Owner decision D-16: a mail node mailbox sends only from its own address, and each address is a
// separate, billed mailbox. Aliases with another address saved on node mailboxes before that are
// listed here (the server no longer sends from them) with two actions: create the address as its
// own mailbox (the create form, started from the alias; the alias row goes once the mailbox is
// made) or delete the alias. Nothing happens on its own. The rows come from the account list the
// app already holds, so the section shows only when there is something to do.
export default function MailNodeForeignAliases() {
  const { t } = useTranslation();
  const accounts = useStore((s) => s.accounts);
  const setAccounts = useStore((s) => s.setAccounts);
  const updateAccount = useStore((s) => s.updateAccount);
  const [creating, setCreating] = useState(null); // alias id whose create form is open
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const rows = foreignNodeAliases(accounts);
  if (!rows.length && !notice && !error) return null;

  // The alias leaves the row of its mailbox, here and in the compose From list.
  const dropAlias = (accountId, aliasId) => {
    const owner = useStore.getState().accounts.find((a) => a.id === accountId);
    updateAccount(accountId, { aliases: (owner?.aliases ?? []).filter((a) => a.id !== aliasId) });
  };

  const onCreated = async ({ account, alias }, created) => {
    setAccounts([...useStore.getState().accounts, created]);
    setCreating(null);
    try {
      await api.deleteAlias(account.id, alias.id);
      dropAlias(account.id, alias.id);
      setError(null);
      setNotice(t('admin.foreignAliases.created', { email: created.email_address }));
    } catch (err) {
      // The mailbox exists either way; the alias row stays to be deleted by hand.
      setNotice(null);
      setError(t('admin.foreignAliases.createdAliasKept', { email: created.email_address, error: err.message }));
    }
  };

  const confirmDelete = ({ account, alias }) => {
    setConfirmDialog({
      title: t('admin.foreignAliases.deleteTitle'),
      message: t('admin.foreignAliases.deleteMessage', { email: alias.email, mailbox: account.email_address }),
      confirmLabel: t('common.delete'),
      onConfirm: async () => {
        await api.deleteAlias(account.id, alias.id);
        dropAlias(account.id, alias.id);
        setError(null);
        setNotice(null);
      },
    });
  };

  return (
    <div data-section="node-foreign-aliases" style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{t('admin.foreignAliases.title')}</h3>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, marginBottom: 8, lineHeight: 1.5 }}>
        {t('admin.foreignAliases.description')}
      </div>
      {notice && <div role="status" style={{ fontSize: 12, color: 'var(--green)', marginBottom: 8 }}>{notice}</div>}
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th scope="col" style={headCellStyle}>{t('admin.foreignAliases.columnAddress')}</th>
                <th scope="col" style={headCellStyle}>{t('admin.foreignAliases.columnName')}</th>
                <th scope="col" style={headCellStyle}>{t('admin.foreignAliases.columnMailbox')}</th>
                <th scope="col" style={headCellStyle}>{t('admin.foreignAliases.columnActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ForeignAliasRow
                  key={row.alias.id}
                  row={row}
                  open={creating === row.alias.id}
                  onCreate={() => { setCreating(row.alias.id); setNotice(null); setError(null); }}
                  onCancel={() => setCreating(null)}
                  onCreated={(created) => onCreated(row, created)}
                  onDelete={() => confirmDelete(row)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />
    </div>
  );
}

function ForeignAliasRow({ row, open, onCreate, onCancel, onCreated, onDelete }) {
  const { t } = useTranslation();
  const accounts = useStore((s) => s.accounts);
  const { account, alias } = row;
  return (
    <>
      <tr data-foreign-alias={alias.id}>
        <td style={{ ...cellStyle, overflowWrap: 'anywhere' }}>{alias.email}</td>
        <td style={{ ...cellStyle, overflowWrap: 'anywhere' }}>{alias.name}</td>
        <td style={{ ...cellStyle, overflowWrap: 'anywhere' }}>{account.email_address}</td>
        <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={onCreate}
              disabled={open}
              aria-expanded={open}
              aria-label={t('admin.foreignAliases.createAria', { email: alias.email })}
              style={{ ...primaryButtonStyle, opacity: open ? 0.6 : 1 }}
            >
              {t('admin.foreignAliases.create')}
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label={t('admin.foreignAliases.deleteAria', { email: alias.email })}
              style={buttonStyle}
            >
              {t('common.delete')}
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} style={{ ...cellStyle, padding: '12px 10px 16px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
              {t('admin.foreignAliases.formTitle', { email: alias.email })}
            </div>
            <DomainMailboxAddForm
              accounts={accounts}
              initial={mailboxPrefillFromAlias(alias)}
              onCreated={onCreated}
              onCancel={onCancel}
            />
          </td>
        </tr>
      )}
    </>
  );
}
