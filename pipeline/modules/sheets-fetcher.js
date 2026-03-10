/**
 * pipeline/modules/sheets-fetcher.js
 * Fetch + parse Google Sheets data. Timeout from google-auth.json fetchTimeoutMs.
 */
const SheetsFetcher = (() => {
  const API = 'https://sheets.googleapis.com/v4/spreadsheets';
  let _appCfg = null, _auth = null;

  function init(appCfg, auth) { _appCfg = appCfg; _auth = auth; }

  function extractId(urlOrId) {
    const m = urlOrId.match(/\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : urlOrId.trim();
  }

  async function _fetchTab(sheetId, tabName, token, timeoutMs) {
    const range = encodeURIComponent(`'${tabName}'!A1:P${_appCfg.fetchRangeRows || 300}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}/${sheetId}/values/${range}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 401) throw new Error('AUTH_EXPIRED');
      if (!res.ok) throw new Error(`Sheets API ${res.status}`);
      return (await res.json()).values || [];
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Timeout after ${timeoutMs}ms for "${tabName}"`);
      throw e;
    }
  }

  async function _fetchWithFallback(sheetId, names, token, ms) {
    for (const name of names.filter(Boolean)) {
      try {
        const rows = await _fetchTab(sheetId, name, token, ms);
        if (rows.length) return rows;
      } catch (e) { if (e.message === 'AUTH_EXPIRED') throw e; }
    }
    return [];
  }

  async function fetchAll(sheetUrl, onProgress) {
    const sheetId = extractId(sheetUrl);
    const token   = await _auth.ensureToken();
    const ms      = _appCfg.fetchTimeoutMs || 30000;
    const tabs    = _appCfg.sheetTabs || {};

    const tabMap = {
      release2026: [tabs.release2026, 'List game release 2026'],
      release2025: [tabs.release2025, 'List game release 2025'],
      close2026:   [tabs.close2026,   'List game close 2026'],
      close2025:   [tabs.close2025,   'List game close 2025'],
    };

    const result = { fetchedAt: new Date().toISOString(), sheetUrl,
      release2026:[], release2025:[], close2026:[], close2025:[] };

    const keys = Object.keys(tabMap);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      onProgress?.({ step: i+1, total: keys.length, tab: key });
      const rows = await _fetchWithFallback(sheetId, tabMap[key], token, ms);
      result[key] = key.startsWith('close') ? _parseClose(rows) : _parseRelease(rows);
    }
    return result;
  }

  /* ── parsers ── */
  function _pd(v) {
    if (!v || v===''||v==='-') return null;
    const s = String(v).trim();
    if (s==='TBU'||s==='TBD') return 'TBU';
    if (/no.?cbt/i.test(s)) return 'No CBT';
    const d = new Date(s);
    return isNaN(d) ? s : d.toISOString().slice(0,10);
  }
  function _pm(raw) {
    if (!raw||raw==='TBU'||raw==='-') return [];
    return String(raw).split(/[,;、\n]/).map(m=>m.trim().toUpperCase()).filter(m=>m&&m.length>=2&&m.length<=12);
  }
  function _ps(s) {
    if (!s||s.startsWith('=')) return 'On Process';
    const l = s.toLowerCase();
    if (l.includes('released')) return 'Released';
    if (l.includes('terminated')) return 'Terminated';
    if (l.includes('cancelled')) return 'Cancelled';
    if (l.includes('pending')) return 'Pending';
    if (l.includes('closed')) return 'Closed';
    if (l.includes('closing')) return 'Closing';
    return s.trim() || 'On Process';
  }

  function _parseRelease(rows) {
    if (!rows.length) return [];
    const hi = rows.findIndex(r => /sản phẩm|^game$/i.test(String(r[0]||'')));
    const data = [];
    for (let i = (hi>=0?hi+1:3); i<rows.length; i++) {
      const r = rows[i]; if (!r||!String(r[0]||'').trim()) continue;
      data.push({
        name: String(r[0]).trim(), faCode: String(r[1]||'').trim(),
        alias: String(r[2]||'').trim(), owner: String(r[3]||'').trim(),
        ranking: String(r[4]||'').trim().toUpperCase(), status: _ps(r[5]),
        cbtFrom: _pd(r[7]), cbtTo: _pd(r[8]), cbtPlatform: String(r[9]||'').trim(),
        obDate: _pd(r[11]), obPlatform: String(r[12]||'').trim(),
        markets: _pm(r[13]), kickstart: _pd(r[14]), note: String(r[15]||'').trim(),
      });
    }
    return data;
  }

  function _parseClose(rows) {
    if (!rows.length) return [];
    const hi = rows.findIndex(r => /fa.?code/i.test(String(r[0]||''))||/product/i.test(String(r[2]||'')));
    const data = [];
    for (let i=(hi>=0?hi+1:1); i<rows.length; i++) {
      const r=rows[i]; if(!r||(!r[0]&&!r[2])) continue;
      const name = String(r[2]||r[0]||'').trim(); if(!name) continue;
      data.push({
        faCode:String(r[0]||'').trim(), alias:String(r[1]||'').trim(), name,
        markets:_pm(r[3]), productType:String(r[4]||'').trim(), status:_ps(r[5]),
        owner:String(r[6]||'').trim(), releaseDate:_pd(r[7]),
        closeDate:_pd(r[8]), paymentClose:_pd(r[9]),
      });
    }
    return data;
  }

  return { init, fetchAll, extractId };
})();
