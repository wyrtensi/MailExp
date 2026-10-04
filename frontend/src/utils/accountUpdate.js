// The PUT /api/accounts/:id body the account settings form sends. The server settings (hosts,
// ports, TLS, sign-in) are an administrator's to change (backend routes/accounts.js refuses them
// from anyone else), so for other users the form leaves them out entirely: a resent null SMTP
// password would count as clearing the stored one.
export function accountUpdateFromForm(form, { isAdmin = false } = {}) {
  const updates = {
    name: form.name,
    sender_name: form.sender_name || null,
    color: form.color,
    signature: form.signature || null,
    categorization_enabled: !!form.categorization_enabled,
  };
  if (!isAdmin) return updates;
  Object.assign(updates, {
    imap_host: form.imap_host, imap_port: form.imap_port, imap_skip_tls_verify: !!form.imap_skip_tls_verify,
    smtp_host: form.smtp_host, smtp_port: form.smtp_port, smtp_tls: form.smtp_tls,
  });
  if (form.auth_pass) updates.auth_pass = form.auth_pass;
  if (form.auth_user) updates.auth_user = form.auth_user;
  // Separate SMTP credentials (optional). A username sends both (a blank password on
  // edit keeps the stored one); a blank username clears both back to the IMAP login.
  if (form.smtp_auth_user) {
    updates.smtp_auth_user = form.smtp_auth_user;
    if (form.smtp_auth_pass) updates.smtp_auth_pass = form.smtp_auth_pass;
  } else {
    updates.smtp_auth_user = null;
    updates.smtp_auth_pass = null;
  }
  return updates;
}
