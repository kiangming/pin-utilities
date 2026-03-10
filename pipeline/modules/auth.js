/**
 * pipeline/modules/auth.js
 * Google OAuth 2.0 via Google Identity Services (GIS).
 * Handles sign-in, silent refresh, session persistence, expiry detection.
 */
const PipelineAuth = (() => {
  let _cfg = null;
  let _tokenClient = null;
  let _accessToken = null;
  let _tokenExpiry = null;
  let _onReAuthNeeded = null;

  async function init(cfg, onReAuthNeeded) {
    _cfg = cfg;
    _onReAuthNeeded = onReAuthNeeded;
    // Restore token from sessionStorage
    try {
      const raw = sessionStorage.getItem(_cfg.sessionStorageKey || 'pipeline_gauth_token');
      if (raw) {
        const p = JSON.parse(raw);
        if (p.token && p.expiry && Date.now() < p.expiry) {
          _accessToken = p.token;
          _tokenExpiry = p.expiry;
        }
      }
    } catch (_) {}
  }

  function _loadGIS() {
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load Google Identity Services.'));
      document.head.appendChild(s);
    });
  }

  function _requestToken(prompt = '') {
    return new Promise((resolve, reject) => {
      if (!_cfg?.clientId) {
        reject(new Error('Google Client ID not configured in pipeline/config/google-auth.json'));
        return;
      }
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: _cfg.clientId,
        scope: (_cfg.scopes || []).join(' '),
        callback: (resp) => {
          if (resp.error) { reject(new Error('Google sign-in error: ' + resp.error)); return; }
          const buf = _cfg.tokenExpiryBufferSec ?? 120;
          _accessToken = resp.access_token;
          _tokenExpiry = Date.now() + (resp.expires_in - buf) * 1000;
          try {
            sessionStorage.setItem(
              _cfg.sessionStorageKey || 'pipeline_gauth_token',
              JSON.stringify({ token: _accessToken, expiry: _tokenExpiry })
            );
          } catch (_) {}
          resolve(_accessToken);
        },
      });
      _tokenClient.requestAccessToken({ prompt });
    });
  }

  async function signIn()  { await _loadGIS(); return _requestToken('consent'); }

  async function refresh() {
    await _loadGIS();
    try { return await _requestToken(''); }
    catch (e) {
      _accessToken = null; _tokenExpiry = null;
      try { sessionStorage.removeItem(_cfg?.sessionStorageKey || 'pipeline_gauth_token'); } catch (_) {}
      if (_onReAuthNeeded) _onReAuthNeeded();
      throw e;
    }
  }

  async function ensureToken() {
    if (_accessToken && _tokenExpiry && Date.now() < _tokenExpiry) return _accessToken;
    if (_tokenClient) return refresh();
    if (_onReAuthNeeded) _onReAuthNeeded();
    throw new Error('AUTH_EXPIRED');
  }

  function isSignedIn() { return !!_accessToken && Date.now() < (_tokenExpiry || 0); }

  function signOut() {
    const tok = _accessToken;
    _accessToken = null; _tokenExpiry = null; _tokenClient = null;
    try { sessionStorage.removeItem(_cfg?.sessionStorageKey || 'pipeline_gauth_token'); } catch (_) {}
    try { if (window.google?.accounts?.oauth2 && tok) google.accounts.oauth2.revoke(tok, () => {}); } catch (_) {}
  }

  return { init, signIn, refresh, ensureToken, isSignedIn, signOut };
})();
