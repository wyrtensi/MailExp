import { api } from './api.js';

// Mailbox and session state that can reference the signed-out user's accounts or folders.
// Appearance and localization prefs (theme, font, layout, language) are deliberately NOT
// cleared: keeping them means the login screen and the next visit keep the last-used look
// instead of snapping back to the default dark theme (#208). They are re-synced from the
// account's server-side preferences after login.
export const SIGN_OUT_CLEARED_KEYS = [
  'mailexpert_notification_sound', 'mailexpert_custom_sound', 'mailexpert_custom_sound_name',
  'mailexpert_page_size', 'mailexpert_scroll_mode',
  'mailexpert_threaded_view', 'mailexpert_plaintext_email',
  'mailexpert_hover_quick_actions', 'mailexpert_swipe_actions',
  'mailexpert_expanded_accounts', 'mailexpert_collapsed_folders', 'mailexpert_pinned_accounts',
  'mailexpert_sort_accounts_by_latest',
];

// Signing out from the sidebar and from the lock screen. When the session signed in through
// an SSO provider with RP-initiated logout enabled (or through Cloudflare Access), the server
// returns the end-session URL and the browser goes there, ending that session too (#310);
// otherwise it goes to /login. A failed request still signs out locally.
export async function signOut({
  setUser, storage = localStorage, logout = api.logout,
  navigate = (url) => { window.location.href = url; },
}) {
  const res = await logout().catch(() => ({}));
  for (const key of SIGN_OUT_CLEARED_KEYS) storage.removeItem(key);
  setUser(null);
  navigate(res?.endSessionUrl || '/login');
}
