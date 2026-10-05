import React from 'react';
import { claimReloadInto, fetchServerBuild, isStaleBuildError } from '../utils/staleBuild.js';
import { BOUNDARY_TEXT, currentBoundaryLanguage } from '../utils/boundaryText.js';

// Catches render-time exceptions so a single thrown error cannot blank the whole app.
//
// Without this, React 18 unmounts the entire tree when any component throws during render,
// leaving an empty <div id="root"> — a white screen carrying no information at all. That is
// the failure users report as "the app stopped responding and I see a blank page" (#441),
// and it is unactionable: the person seeing it cannot say what broke, and neither can we.
//
// Deliberately dependency-free. It imports nothing but React and the dependency-free
// utils/staleBuild.js and utils/boundaryText.js (its own small en/ru dictionary), uses inline
// styles with literal fallbacks behind every CSS variable, and never touches the store, i18n or
// the API client — because any of those may be exactly what failed. A fallback that can itself throw is not a fallback.
//
// Not a substitute for fixing the underlying error. It converts an undiagnosable blank page
// into a readable message the user can send us.
//
// One error is not a bug: a tab opened before a server update fails to load the screens it
// fetches on demand (utils/staleBuild.js). That reloads into the new version by itself, but only
// once GET /api/version answers a build other than the one this page runs: never into the
// browser's offline page or the edge's maintenance page, and never when the server runs this very
// build (the file is really missing, a reload would not help). An update applied from the panel
// restarts the server, so it keeps asking for about a minute before it hands the reload to the
// user, and it reloads into a given build once per tab.
const PROBE_ATTEMPTS = 20;
const PROBE_INTERVAL_MS = 3000;
// The build this bundle was made from (Dockerfile VITE_BUILD_SHA); the server answers its own.
const RUNNING_BUILD = import.meta.env?.VITE_BUILD_SHA || 'dev';
const sessionStore = () => { try { return window.sessionStorage; } catch { return null; } };

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    // staleBuild: null, or 'reloading' while it checks the server and reloads, or 'manual'.
    this.state = { error: null, copied: false, staleBuild: null };
  }

  static getDerivedStateFromError(error) {
    return { error, staleBuild: isStaleBuildError(error) ? 'reloading' : null };
  }

  componentDidCatch(error, info) {
    // Keep the full component stack in the console for anyone with devtools open; the UI
    // below shows only the message, which is what a user can reasonably be asked to relay.
    console.error('Unhandled render error:', error, info?.componentStack);
    if (isStaleBuildError(error)) this.reloadIntoNewBuild();
  }

  async reloadIntoNewBuild() {
    const {
      probeServer = fetchServerBuild,
      runningBuild = RUNNING_BUILD,
      storage = sessionStore(),
      reloadPage = () => window.location.reload(),
      probeAttempts = PROBE_ATTEMPTS,
      probeIntervalMs = PROBE_INTERVAL_MS,
    } = this.props;
    for (let attempt = 0; attempt < probeAttempts; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, probeIntervalMs));
      const serverBuild = await probeServer().catch(() => null);
      if (!serverBuild) continue;
      // The same build: the file is missing from the build itself, a reload brings no new app.
      if (serverBuild === runningBuild) break;
      // Claimed only once the server has answered, so time spent offline (or waiting out a
      // restart) does not use up the one automatic reload into that build.
      if (claimReloadInto(storage, serverBuild)) {
        reloadPage();
        return;
      }
      break;
    }
    this.setState({ staleBuild: 'manual' });
  }

  handleCopy = () => {
    const { error } = this.state;
    const details = [
      `MailExpert error: ${error?.message || String(error)}`,
      `URL: ${window.location?.href || 'unknown'}`,
      `User agent: ${navigator?.userAgent || 'unknown'}`,
      error?.stack ? `\n${error.stack}` : '',
    ].join('\n');
    // navigator.clipboard is undefined outside a secure context (plain http:// on a LAN, a
    // common self-hosted setup). Optional chaining short-circuits the whole chain in that
    // case, so `.then` is simply never reached and nothing throws. The explicit promise
    // check below is belt-and-braces for the one case chaining does NOT cover: a
    // non-conformant writeText that returns something other than a Promise. Standard
    // browsers never do that, but this handler lives on the page users see when
    // something has already gone wrong, so it does not get to assume anything.
    const write = navigator.clipboard?.writeText?.(details);
    if (write && typeof write.then === 'function') {
      write
        .then(() => this.setState({ copied: true }))
        .catch(() => { /* clipboard refused — the message is on screen to copy by hand */ });
    }
  };

  render() {
    const { error, copied, staleBuild } = this.state;
    if (!error) return this.props.children;
    const text = BOUNDARY_TEXT[this.props.lang ?? currentBoundaryLanguage()] ?? BOUNDARY_TEXT.en;

    const button = {
      padding: '8px 16px', fontSize: 14, borderRadius: 7, cursor: 'pointer',
      border: '1px solid var(--border, #d0d0d0)',
      background: 'var(--bg-tertiary, #f2f2f2)',
      color: 'var(--text-primary, #1a1a1a)',
    };

    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, boxSizing: 'border-box',
        background: 'var(--bg-primary, #ffffff)',
        color: 'var(--text-primary, #1a1a1a)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{ maxWidth: 520, width: '100%' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>
            {staleBuild ? text.updatedTitle : text.errorTitle}
          </h1>
          <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary, #555)' }}>
            {staleBuild === 'reloading' && text.reloading}
            {staleBuild === 'manual' && text.manual}
            {!staleBuild && text.errorBody}
          </p>

          <pre style={{
            margin: '0 0 16px', padding: '10px 12px', borderRadius: 7, fontSize: 12.5,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowX: 'auto',
            background: 'var(--bg-tertiary, #f2f2f2)',
            border: '1px solid var(--border-subtle, #e2e2e2)',
            color: 'var(--text-primary, #1a1a1a)',
          }}>
            {error?.message || String(error)}
          </pre>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ ...button, background: 'var(--accent, #6366f1)', color: '#fff', borderColor: 'transparent' }}
            >
              {text.reload}
            </button>
            <button type="button" onClick={this.handleCopy} style={button}>
              {copied ? text.copied : text.copy}
            </button>
          </div>

          <p style={{ margin: '16px 0 0', fontSize: 12.5, color: 'var(--text-tertiary, #888)' }}>
            {text.footer}
          </p>
        </div>
      </div>
    );
  }
}
