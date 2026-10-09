import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { useStore } from './store/index.js';
import { api } from './utils/api.js';
import { applyTheme, getInitialTheme, resolveSystemTheme, readThemeFollowsSystem } from './themes.js';
import { applyFontSet, effectiveFontSet } from './fonts.js'; // still used for the instant localStorage apply on mount
import { applyLayout } from './layouts.js';
import LoginPage from './components/LoginPage.jsx';
import GoogleLoginPage from './components/GoogleLoginPage.jsx';
import AccessDeniedPage from './components/AccessDeniedPage.jsx';
import { accessRefusalCode, isGoogleAuthMode } from './utils/authMode.js';
import { signOut } from './utils/signOut.js';
import { isDemoMode } from './demo/mode.js';
import { demoRole } from './utils/demoRole.js';
import { needsLanguageChoice } from './utils/language.js';
import { readDeepLink } from './utils/deepLink.js';
import MailApp from './components/MailApp.jsx';
import LockScreen from './components/LockScreen.jsx';

// The demo signs in as the administrator or as an ordinary user (utils/demoRole.js), matching
// what the demo's /auth/me answers.
function demoUser() {
  const plain = demoRole() === 'user';
  return {
    id: plain ? 'demo-colleague' : 'demo-user',
    email: plain ? 'colleague@demo.mailexpert.local' : 'demo@mailexpert.local',
    username: plain ? 'Demo User' : 'Demo Administrator',
    isAdmin: !plain,
    hasLockPin: false,
    locked: false,
    totpEnabled: false,
  };
}

export default function App() {
  const { user, setUser, loadPreferences, isLocked, setLocked } = useStore();
  const [checking, setChecking] = useState(true);
  const [authConfig, setAuthConfig] = useState(null);
  const [accessDenied, setAccessDenied] = useState(null);
  const [retrying, setRetrying] = useState(false);

  // A signed-in user means the refusal no longer applies (access restored, another account
  // signed in): drop the no-access screen so it cannot outlive the state it describes.
  useEffect(() => { if (user) setAccessDenied(null); }, [user]);

  // "Try again" on the no-access screen: ask the server who this session is now. Allowed ->
  // the app; refused again -> the screen stays (with the fresh code); no session at all -> the
  // sign-in form.
  const retryAccess = useCallback(async () => {
    setRetrying(true);
    try {
      const data = await api.me();
      setUser(data.user);
      setAccessDenied(null);
      if (data.user?.locked) setLocked(true);
      else {
        setLocked(false);
        await loadPreferences();
      }
    } catch (err) {
      setAccessDenied(accessRefusalCode(err));
    } finally {
      setRetrying(false);
    }
  }, [loadPreferences, setUser, setLocked]);

  // "Use another account": the regular sign-out, which also ends a Cloudflare Access / SSO
  // session when the server returns an end-session URL, then lands on the sign-in screen.
  const switchAccount = useCallback(() => signOut({ setUser }), [setUser]);

  // Register service worker on first mount — independent of auth state.
  // The SW itself does nothing until the user explicitly grants push permission.
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) =>
        console.warn('Service worker registration failed:', err)
      );
    }
  }, []);

  useEffect(() => {
    const onExpired = () => { setUser(null); setLocked(false); };
    const onLocked = () => setLocked(true);
    const onDenied = (e) => { setUser(null); setLocked(false); setAccessDenied(e.detail?.code || 'not_allowed'); };
    window.addEventListener('mailexpert:session_expired', onExpired);
    window.addEventListener('mailexpert:locked', onLocked);
    window.addEventListener('mailexpert:access_denied', onDenied);
    return () => {
      window.removeEventListener('mailexpert:session_expired', onExpired);
      window.removeEventListener('mailexpert:locked', onLocked);
      window.removeEventListener('mailexpert:access_denied', onDenied);
    };
  }, [setUser, setLocked]);

  useEffect(() => {
    // Apply localStorage immediately so there's no flash while we check auth. "как в системе"
    // defaults on, so a fresh browser — and the login screen itself, before any user or server
    // prefs — tracks the OS light/dark setting rather than always landing on Daylight.
    const bootTheme = readThemeFollowsSystem()
      ? resolveSystemTheme()
      : (localStorage.getItem('mailexpert_theme') || getInitialTheme());
    applyTheme(bootTheme);
    applyFontSet(effectiveFontSet(bootTheme, localStorage.getItem('mailexpert_font') || 'default'));
    const savedListWidth = Number(localStorage.getItem('mailexpert_list_width')) || undefined;
    applyLayout(localStorage.getItem('mailexpert_layout') || 'comfortable', savedListWidth);

    if (isDemoMode) {
      // The demo is about conversations: it opens threaded unless this browser chose otherwise.
      if (localStorage.getItem('mailexpert_threaded_view') === null) useStore.getState().setThreadedView(true);
      // The demo does not load the server-style preferences (loadPreferences): this browser's own
      // choices, kept in localStorage, are what applies. One exception is below.
      if (needsLanguageChoice({ stored: localStorage.getItem('mailexpert_language') })) useStore.getState().setLanguagePickerOpen(true);
      setUser(demoUser());
      setLocked(false);
      // Theme, font, and layout were applied above from localStorage. The exception: which
      // mailboxes are pinned is read once from the demo adapter's preferences, the first time this
      // browser opens the demo, so the sidebar shows pins at once. It goes through the same
      // adapter every other call uses (api.js hands demo mode to it, imported up front); after
      // that the pins live in localStorage, kept by the store, and are written back to the
      // adapter's preferences by pinning and unpinning.
      if (localStorage.getItem('mailexpert_pinned_accounts') === null) {
        api.getPreferences()
          .then((prefs) => { if (Array.isArray(prefs?.pinnedAccounts)) useStore.getState().setPinnedAccounts(prefs.pinnedAccounts); })
          .catch(() => {});
      }
      setChecking(false);
      return;
    }

    // Handle OAuth popup callback. Google adds oauth_result on success and
    // oauth_provider on error; Microsoft sends neither, so both stay undefined.
    const params = new URLSearchParams(window.location.search);
    const oauthSuccess = params.get('oauth_success');
    const oauthError = params.get('oauth_error');
    if ((oauthSuccess || oauthError) && window.opener) {
      if (oauthSuccess) {
        window.opener.postMessage({
          type: 'oauth_success', provider: oauthSuccess,
          result: params.get('oauth_result') || undefined, notice: params.get('oauth_notice') || undefined,
        }, window.location.origin);
      } else {
        // oauth_account: the Microsoft mailbox to reconnect by device code instead (redirect_not_configured).
        window.opener.postMessage({ type: 'oauth_error', error: oauthError, provider: params.get('oauth_provider') || undefined, account: params.get('oauth_account') || undefined }, window.location.origin);
      }
      window.close();
      return;
    }

    // The sign-in screen depends on the server's mode; an unreachable config means local.
    const configLoaded = api.authConfig()
      .then(setAuthConfig)
      .catch(() => setAuthConfig({ mode: 'local' }));
    const userLoaded = api.me()
      .then(async (data) => {
        setUser(data.user);
        // Server is authoritative for the screen lock (#235). Reconcile the overlay:
        // show it if the session is locked; clear a stale client lock otherwise. Skip
        // loading prefs while locked (the API is 423'd until unlock).
        if (data.user?.locked) {
          setLocked(true);
          return;
        }
        if (localStorage.getItem('mailexpert_locked') === '1') setLocked(false);
        // Load server preferences after confirming auth — overwrites localStorage so
        // settings survive cache clears and stay consistent across devices.
        await loadPreferences();
      })
      .catch(() => {
        const params = new URLSearchParams(window.location.search);
        const deepLink = readDeepLink(params);
        if (deepLink) {
          sessionStorage.setItem('mailexpert_deep_link_id', deepLink.ref);
          if (deepLink.accountId) sessionStorage.setItem('mailexpert_deep_link_account', deepLink.accountId);
          else sessionStorage.removeItem('mailexpert_deep_link_account');
        }
        const resetToken = params.get('reset_token');
        if (resetToken) sessionStorage.setItem('mailexpert_reset_token', resetToken);
        setUser(null);
        // Clear any stale client lock so a locked session that has since expired
        // doesn't strand the user back on the lock screen after they re-login (#235).
        setLocked(false);
      });
    Promise.all([configLoaded, userLoaded]).finally(() => setChecking(false));
  }, [loadPreferences, setUser, setLocked]);

  if (checking) {
    return (
      <div style={{
        height: 'var(--app-height, 100svh)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'var(--bg-primary)'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%',
            border: '2px solid var(--border)',
            borderTopColor: 'var(--accent)',
            animation: 'spin 0.8s linear infinite'
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return <AccessDeniedPage code={accessDenied} retrying={retrying} onRetry={retryAccess} onSwitchAccount={switchAccount} />;
  }

  const loginPage = isGoogleAuthMode(authConfig) ? <GoogleLoginPage config={authConfig} /> : <LoginPage />;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : loginPage} />
      <Route path="/register" element={user ? <Navigate to="/" replace /> : loginPage} />
      <Route path="/*" element={user ? (isLocked ? <LockScreen /> : <MailApp />) : <Navigate to="/login" replace />} />
    </Routes>
  );
}
