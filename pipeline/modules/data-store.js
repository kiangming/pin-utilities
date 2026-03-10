/**
 * pipeline/modules/data-store.js
 * In-memory store with localStorage persistence (mirrors pipeline-data.json).
 * write() overwrites both memory and localStorage — equivalent to overwriting the JSON file.
 */
const PipelineDataStore = (() => {
  const LS_KEY = 'pipeline_data_v1';
  let _d = { fetchedAt:null, sheetUrl:'', release2026:[], release2025:[], close2026:[], close2025:[] };

  function init() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) _d = { ..._d, ...JSON.parse(raw) };
    } catch (_) {}
    return _d;
  }

  function write(newData) {
    _d = { ..._d, ...newData };
    try { localStorage.setItem(LS_KEY, JSON.stringify(_d)); } catch (_) {}
    return _d;
  }

  function get(key)  { return key ? _d[key] : _d; }
  function getAll()  { return _d; }
  function hasData() { return (_d.release2026?.length||0)+(_d.release2025?.length||0) > 0; }
  function clear()   { _d={fetchedAt:null,sheetUrl:'',release2026:[],release2025:[],close2026:[],close2025:[]}; try{localStorage.removeItem(LS_KEY);}catch(_){} }

  return { init, write, get, getAll, hasData, clear };
})();
