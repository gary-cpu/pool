import { useState, useEffect, useCallback, useRef } from "react";

// ─── Google API Config ────────────────────────────────────────────────────────
const CLIENT_ID   = "343857247815-5re082rh5a3uur7u26ms1tfupb65gjae.apps.googleusercontent.com";
const SHEET_ID    = "1Ju1uThvyVtDxwnqwMhLoNlxluxBufb7MgtO0j5QzCo4";
const SHEET_RANGE = "Water Quality";
const SCOPES      = "https://www.googleapis.com/auth/spreadsheets";
const SHEET_COLUMNS = ["Date","pH","Free Chlorine (ppm)","Combined Chlorine (ppm)","Alkalinity (ppm)","Cyanuric Acid (ppm)","Water Temp (°C)","Comments"];

// ─── Field Definitions ────────────────────────────────────────────────────────
const FIELDS = [
  { key: "date",     label: "Date",             type: "date",   unit: "",    min: null, max: null,  ideal: null },
  { key: "ph",       label: "pH",               type: "number", unit: "",    min: 6.8,  max: 8.0,   ideal: [7.3, 7.5] },
  { key: "freeCl",   label: "Free Chlorine",    type: "number", unit: "ppm", min: 0,    max: 10,    ideal: [0.5, 1.0] },
  { key: "comboCl",  label: "Combined Chlorine",type: "number", unit: "ppm", min: 0,    max: 5,     ideal: [0, 0.5] },
  { key: "alk",      label: "Alkalinity",       type: "number", unit: "ppm", min: 60,   max: 200,   ideal: [80, 150] },
  { key: "cya",      label: "Cyanuric Acid",    type: "number", unit: "ppm", min: 0,    max: 200,   ideal: [30, 50] },
  { key: "temp",     label: "Water Temp",       type: "number", unit: "°C",  min: 0,    max: 45,    ideal: null },
  { key: "comments", label: "Comments",         type: "text",   unit: "",    min: null, max: null,  ideal: null },
];

const DATA_FIELDS = FIELDS.filter(f => f.key !== "date" && f.key !== "comments");
const TREND_COLOR = { ph:"#38bdf8", freeCl:"#4ade80", comboCl:"#fb923c", alk:"#a78bfa", cya:"#f472b6", temp:"#fbbf24" };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().split("T")[0]; }

function statusFor(field, value) {
  if (!field.ideal || value === "" || value === null) return "neutral";
  const v = parseFloat(value);
  if (isNaN(v)) return "neutral";
  const [lo, hi] = field.ideal;
  if (v >= lo && v <= hi) return "good";
  if (v >= (field.min ?? lo - 1) && v <= (field.max ?? hi + 1)) return "warn";
  return "bad";
}

function deltaInfo(delta) {
  if (delta === null || delta === undefined || isNaN(delta)) return null;
  if (Math.abs(delta) < 0.001) return { icon: "→", color: "#94a3b8", label: "No change" };
  if (delta > 0) return { icon: "↑", color: "#f97316", label: `+${delta.toFixed(2)}` };
  return { icon: "↓", color: "#38bdf8", label: `${delta.toFixed(2)}` };
}

// ─── Sparkline ────────────────────────────────────────────────────────────────
function Sparkline({ data, color }) {
  const vals = (data || []).map(Number).filter(v => !isNaN(v));
  if (vals.length < 2) return <span style={{fontSize:11,color:"#475569"}}>—</span>;
  const w=80, h=30, pad=3;
  const mn=Math.min(...vals), mx=Math.max(...vals), range=mx-mn||1;
  const pts = vals.map((v,i) => {
    const x = pad + (i/(vals.length-1))*(w-2*pad);
    const y = h - pad - ((v-mn)/range)*(h-2*pad);
    return `${x},${y}`;
  }).join(" ");
  const last = pts.split(" ").pop().split(",");
  return (
    <svg width={w} height={h} style={{display:"block"}}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
      <circle cx={last[0]} cy={last[1]} r="3" fill={color}/>
    </svg>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function PoolTester() {
  const [gapiReady,   setGapiReady]   = useState(false);
  const [signedIn,    setSignedIn]    = useState(false);
  const [authError,   setAuthError]   = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [view,        setView]        = useState("form");
  const [form,        setForm]        = useState({ date: today() });
  const [saving,      setSaving]      = useState(false);
  const [saveError,   setSaveError]   = useState(null);
  const [history,     setHistory]     = useState([]);
  const [loadingHist, setLoadingHist] = useState(false);
  const [lastRow,     setLastRow]     = useState(null);
  const [toast,       setToast]       = useState(null);
  const tokenClientRef = useRef(null);

  // ── Load gapi.client (for Sheets calls) + GIS (for OAuth) ───────────────
  useEffect(() => {
    // 1. Load gapi.client
    const gapiScript = document.createElement("script");
    gapiScript.src = "https://apis.google.com/js/api.js";
    gapiScript.onload = () => {
      window.gapi.load("client", async () => {
        try {
          await window.gapi.client.init({});
          await window.gapi.client.load("https://sheets.googleapis.com/$discovery/rest?version=v4");
          setGapiReady(true);
        } catch(e) {
          setAuthError("Failed to load Sheets API: " + (e.message || JSON.stringify(e)));
        }
      });
    };
    gapiScript.onerror = () => setAuthError("Failed to load Google API.");
    document.head.appendChild(gapiScript);

    // 2. Load GIS token client
    const gisScript = document.createElement("script");
    gisScript.src = "https://accounts.google.com/gsi/client";
    gisScript.onload = () => {
      tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (resp) => {
          if (resp.error) {
            setAuthError("Auth error: " + resp.error);
            return;
          }
          // Set the token on gapi.client so Sheets calls are authenticated
          window.gapi.client.setToken({ access_token: resp.access_token });
          setAccessToken(resp.access_token);
          setSignedIn(true);
          setAuthError(null);
        },
      });
    };
    gisScript.onerror = () => setAuthError("Failed to load Google Identity Services.");
    document.head.appendChild(gisScript);
  }, []);

  // ── Fetch history ────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    if (!signedIn || !gapiReady) return;
    setLoadingHist(true);
    try {
      const res = await window.gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_RANGE}!A2:H500`,
      });
      const rows = res.result.values || [];
      const parsed = rows.map(r => ({
        date: r[0]||"", ph: r[1]||"", freeCl: r[2]||"",
        comboCl: r[3]||"", alk: r[4]||"", cya: r[5]||"",
        temp: r[6]||"", comments: r[7]||"",
      }));
      setHistory(parsed);
      if (parsed.length > 0) setLastRow(parsed[parsed.length - 1]);
    } catch(e) {
      showToast("⚠️ Could not load history: " + (e.result?.error?.message || e.message), "err");
    } finally {
      setLoadingHist(false);
    }
  }, [signedIn, gapiReady]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // ── Sign in / out ────────────────────────────────────────────────────────
  function signIn() {
    setAuthError(null);
    if (!tokenClientRef.current) { setAuthError("Auth not ready yet, please wait a moment."); return; }
    tokenClientRef.current.requestAccessToken({ prompt: "consent" });
  }

  function signOut() {
    if (accessToken) window.google?.accounts?.oauth2?.revoke(accessToken, () => {});
    window.gapi.client.setToken(null);
    setAccessToken(null);
    setSignedIn(false);
    setHistory([]);
    setLastRow(null);
  }

  // ── Form helpers ─────────────────────────────────────────────────────────
  function setField(key, val) {
    setForm(f => ({ ...f, [key]: val }));
    setSaveError(null);
  }

  function getDelta(key) {
    if (!lastRow || !form[key] || form[key] === "") return null;
    const prev = parseFloat(lastRow[key]);
    const curr = parseFloat(form[key]);
    if (isNaN(prev) || isNaN(curr)) return null;
    return curr - prev;
  }

  function showToast(msg, type="ok") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  // ── Save row ─────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!signedIn) { setSaveError("Please sign in first."); return; }
    setSaving(true);
    setSaveError(null);
    try {
      // Write header if A1 is empty
      const headerCheck = await window.gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_RANGE}!A1:H1`,
      });
      if (!headerCheck.result.values?.length) {
        await window.gapi.client.sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${SHEET_RANGE}!A1`,
          valueInputOption: "RAW",
          resource: { values: [SHEET_COLUMNS] },
        });
      }
      const row = [
        form.date    || today(),
        form.ph      || "",
        form.freeCl  || "",
        form.comboCl || "",
        form.alk     || "",
        form.cya     || "",
        form.temp    || "",
        form.comments|| "",
      ];
      await window.gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_RANGE}!A1`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        resource: { values: [row] },
      });
      const newEntry = { date:row[0], ph:row[1], freeCl:row[2], comboCl:row[3], alk:row[4], cya:row[5], temp:row[6], comments:row[7] };
      setLastRow(newEntry);
      setHistory(h => [...h, newEntry]);
      showToast("✓ Saved to Google Sheets!", "ok");
      setForm({ date: today() });
      setView("trends");
    } catch(e) {
      const msg = e.result?.error?.message || e.message || "Unknown error";
      setSaveError("Save failed: " + msg);
    } finally {
      setSaving(false);
    }
  }

  // ─── Styles ───────────────────────────────────────────────────────────────
  const css = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body { font-family: 'DM Sans', sans-serif; background: #0c1824; color: #e2e8f0; min-height: 100vh; overscroll-behavior: none; }
    .app { max-width: 430px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; background: #0f2030; position: relative; overflow: hidden; }

    .water-bg { position: absolute; top: 0; left: 0; right: 0; height: 200px; background: linear-gradient(180deg, #0a3d62 0%, #0f2030 100%); overflow: hidden; z-index: 0; }
    .wave { position: absolute; bottom: 0; left: -50%; width: 200%; height: 80px; background: rgba(56,189,248,0.08); border-radius: 50% 50% 0 0; animation: wave 5s ease-in-out infinite; }
    .wave:nth-child(2) { background: rgba(56,189,248,0.05); animation: wave 7s ease-in-out infinite reverse; bottom: 10px; }
    @keyframes wave { 0%,100% { transform: translateX(0) scaleY(1); } 50% { transform: translateX(5%) scaleY(1.1); } }

    .header { position: relative; z-index: 1; padding: 52px 24px 20px; display: flex; justify-content: space-between; align-items: flex-start; }
    .header-title { font-size: 24px; font-weight: 600; letter-spacing: -0.5px; color: #f0f9ff; }
    .header-sub { font-size: 13px; color: #7dd3fc; margin-top: 3px; }
    .header-btn { background: rgba(56,189,248,0.15); border: 1px solid rgba(56,189,248,0.3); color: #7dd3fc; border-radius: 20px; padding: 6px 14px; font-size: 13px; cursor: pointer; font-family: 'DM Sans', sans-serif; transition: all 0.2s; }
    .header-btn:hover { background: rgba(56,189,248,0.25); }

    .tab-bar { position: relative; z-index: 1; display: flex; margin: 0 24px 20px; background: rgba(255,255,255,0.05); border-radius: 12px; padding: 4px; }
    .tab { flex: 1; padding: 8px; text-align: center; font-size: 14px; font-weight: 500; border-radius: 9px; cursor: pointer; transition: all 0.2s; color: #64748b; border: none; background: transparent; font-family: 'DM Sans', sans-serif; }
    .tab.active { background: #0ea5e9; color: white; box-shadow: 0 2px 8px rgba(14,165,233,0.4); }

    .scroll-body { position: relative; z-index: 1; flex: 1; overflow-y: auto; padding: 0 16px 120px; -webkit-overflow-scrolling: touch; }

    .auth-card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; padding: 32px 24px; text-align: center; margin: 24px 0; }
    .auth-icon { font-size: 48px; margin-bottom: 16px; }
    .auth-title { font-size: 18px; font-weight: 600; color: #f0f9ff; margin-bottom: 8px; }
    .auth-sub { font-size: 14px; color: #64748b; margin-bottom: 24px; line-height: 1.5; }
    .btn-google { background: white; color: #1e293b; border: none; border-radius: 12px; padding: 14px 24px; font-size: 15px; font-weight: 600; cursor: pointer; width: 100%; font-family: 'DM Sans', sans-serif; display: flex; align-items: center; justify-content: center; gap: 10px; transition: transform 0.1s; }
    .btn-google:active { transform: scale(0.98); }

    .section-label { font-size: 11px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: #475569; margin: 20px 0 10px 4px; }

    .field-row { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px 16px; margin-bottom: 8px; display: flex; align-items: center; gap: 12px; transition: border-color 0.2s; }
    .field-row:focus-within { border-color: rgba(14,165,233,0.5); background: rgba(14,165,233,0.05); }
    .field-meta { flex: 1; min-width: 0; }
    .field-label { font-size: 13px; color: #94a3b8; font-weight: 500; }
    .field-ideal { font-size: 11px; color: #475569; margin-top: 1px; font-family: 'DM Mono', monospace; }
    .field-right { display: flex; align-items: center; gap: 8px; }
    .field-input { background: transparent; border: none; outline: none; font-size: 22px; font-weight: 600; font-family: 'DM Mono', monospace; color: #f0f9ff; width: 80px; text-align: right; -moz-appearance: textfield; }
    .field-input::-webkit-outer-spin-button, .field-input::-webkit-inner-spin-button { -webkit-appearance: none; }
    .field-input::placeholder { color: #334155; }
    .field-unit { font-size: 12px; color: #475569; min-width: 28px; }

    .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .status-dot.good   { background: #22c55e; box-shadow: 0 0 6px #22c55e88; }
    .status-dot.warn   { background: #f59e0b; box-shadow: 0 0 6px #f59e0b88; }
    .status-dot.bad    { background: #ef4444; box-shadow: 0 0 6px #ef444488; }
    .status-dot.neutral { background: #334155; }

    .delta-badge { font-size: 11px; font-family: 'DM Mono', monospace; font-weight: 500; }

    .comments-input { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px 16px; width: 100%; color: #e2e8f0; font-size: 15px; font-family: 'DM Sans', sans-serif; resize: none; outline: none; transition: border-color 0.2s; min-height: 80px; }
    .comments-input:focus { border-color: rgba(14,165,233,0.5); background: rgba(14,165,233,0.05); }
    .comments-input::placeholder { color: #334155; }

    .date-input { background: transparent; border: none; outline: none; color: #f0f9ff; font-size: 15px; font-family: 'DM Sans', sans-serif; font-weight: 500; width: 100%; color-scheme: dark; }

    .save-btn { position: fixed; bottom: 0; left: 50%; transform: translateX(-50%); width: 100%; max-width: 430px; padding: 16px 24px 32px; background: linear-gradient(to top, #0f2030 60%, transparent); z-index: 10; }
    .btn-save { width: 100%; padding: 16px; border-radius: 16px; border: none; font-size: 16px; font-weight: 600; font-family: 'DM Sans', sans-serif; cursor: pointer; transition: all 0.2s; background: linear-gradient(135deg, #0ea5e9, #0284c7); color: white; box-shadow: 0 4px 20px rgba(14,165,233,0.4); }
    .btn-save:active { transform: scale(0.98); }
    .btn-save:disabled { background: #1e293b; color: #475569; box-shadow: none; cursor: default; }

    .error-msg { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 10px; padding: 10px 14px; font-size: 13px; color: #fca5a5; margin-top: 8px; }

    .trend-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 16px; margin-bottom: 10px; }
    .trend-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; }
    .trend-name { font-size: 14px; font-weight: 500; color: #94a3b8; }
    .trend-value { font-size: 26px; font-weight: 700; font-family: 'DM Mono', monospace; }
    .trend-prev { font-size: 12px; color: #475569; margin-top: 2px; }
    .trend-range { font-size: 11px; color: #334155; font-family: 'DM Mono', monospace; margin-top: 4px; }

    .toast { position: fixed; top: 60px; left: 50%; transform: translateX(-50%); z-index: 100; background: #1e293b; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 500; color: #f0f9ff; box-shadow: 0 8px 32px rgba(0,0,0,0.4); animation: slideDown 0.3s ease; white-space: nowrap; }
    .toast.ok  { border-color: rgba(34,197,94,0.4); }
    .toast.err { border-color: rgba(239,68,68,0.4); }
    @keyframes slideDown { from { opacity:0; transform: translateX(-50%) translateY(-10px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }

    .empty-state { text-align: center; padding: 48px 24px; color: #475569; font-size: 14px; }
    .empty-icon { font-size: 40px; margin-bottom: 12px; }
    .loading-spinner { text-align:center; padding: 32px; color: #475569; }
  `;

  const statusColors = { good:"#22c55e", warn:"#f59e0b", bad:"#ef4444", neutral:"#94a3b8" };

  return (
    <>
      <style>{css}</style>
      <div className="app">

        {/* Water BG */}
        <div className="water-bg">
          <div className="wave"/><div className="wave"/>
        </div>

        {/* Toast */}
        {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}

        {/* Header */}
        <div className="header">
          <div>
            <div className="header-title">🏊 Pool Log</div>
            <div className="header-sub">14,200 gal · {new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>
          </div>
          {signedIn
            ? <button className="header-btn" onClick={signOut}>Sign out</button>
            : <button className="header-btn" onClick={signIn}>Sign in</button>
          }
        </div>

        {/* Tabs */}
        <div className="tab-bar">
          <button className={`tab ${view==="form"?"active":""}`}   onClick={()=>setView("form")}>📋 Log Test</button>
          <button className={`tab ${view==="trends"?"active":""}`} onClick={()=>setView("trends")}>📈 Trends</button>
        </div>

        <div className="scroll-body">

          {authError && <div className="error-msg" style={{marginBottom:12}}>⚠️ {authError}</div>}

          {/* ── FORM VIEW ──────────────────────────────────────────────── */}
          {view === "form" && (
            <>
              {!signedIn ? (
                <div className="auth-card">
                  <div className="auth-icon">🔐</div>
                  <div className="auth-title">Connect Google Sheets</div>
                  <div className="auth-sub">Sign in to save readings directly to your spreadsheet. Your data stays in your own Google account.</div>
                  <button className="btn-google" onClick={signIn}>
                    <svg width="18" height="18" viewBox="0 0 18 18">
                      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
                      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/>
                      <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.548 0 9s.348 2.825.957 4.039l3.007-2.332z"/>
                      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
                    </svg>
                    Sign in with Google
                  </button>
                </div>
              ) : (
                <>
                  <div className="section-label">Test Date</div>
                  <div className="field-row">
                    <div className="field-meta"><div className="field-label">Date</div></div>
                    <input type="date" className="date-input" value={form.date||today()} onChange={e=>setField("date",e.target.value)}/>
                  </div>

                  <div className="section-label">Chemical Readings</div>
                  {FIELDS.filter(f=>f.type==="number").map(field => {
                    const status = statusFor(field, form[field.key]);
                    const d = deltaInfo(getDelta(field.key));
                    return (
                      <div className="field-row" key={field.key}>
                        <div className={`status-dot ${status}`}/>
                        <div className="field-meta">
                          <div className="field-label">{field.label}</div>
                          {field.ideal && <div className="field-ideal">Ideal: {field.ideal[0]}–{field.ideal[1]} {field.unit}</div>}
                        </div>
                        <div className="field-right">
                          {d && <span className="delta-badge" style={{color:d.color}}>{d.icon} {d.label}</span>}
                          <input
                            type="number"
                            className="field-input"
                            placeholder="—"
                            value={form[field.key]||""}
                            onChange={e=>setField(field.key,e.target.value)}
                            inputMode="decimal"
                            step="0.1"
                          />
                          <span className="field-unit">{field.unit}</span>
                        </div>
                      </div>
                    );
                  })}

                  <div className="section-label">Notes</div>
                  <textarea
                    className="comments-input"
                    placeholder="Add observations, treatments, or actions…"
                    value={form.comments||""}
                    onChange={e=>setField("comments",e.target.value)}
                    rows={3}
                  />

                  {saveError && <div className="error-msg">⚠️ {saveError}</div>}
                  <div style={{height:80}}/>
                </>
              )}
            </>
          )}

          {/* ── TRENDS VIEW ────────────────────────────────────────────── */}
          {view === "trends" && (
            <>
              {!signedIn && (
                <div className="empty-state">
                  <div className="empty-icon">🔐</div>
                  Sign in to see your trends
                  <br/><br/>
                  <button className="btn-google" style={{maxWidth:240,margin:"0 auto"}} onClick={signIn}>
                    Sign in with Google
                  </button>
                </div>
              )}

              {signedIn && loadingHist && (
                <div className="loading-spinner">⏳ Loading history…</div>
              )}

              {signedIn && !loadingHist && history.length === 0 && (
                <div className="empty-state">
                  <div className="empty-icon">📊</div>
                  No data yet — log your first test!
                </div>
              )}

              {signedIn && !loadingHist && history.length > 0 && (
                <>
                  {DATA_FIELDS.map(field => {
                    const vals = history.map(r=>r[field.key]).filter(v=>v!==""&&!isNaN(parseFloat(v)));
                    const latest = vals.length>0 ? parseFloat(vals[vals.length-1]) : null;
                    const prev   = vals.length>1 ? parseFloat(vals[vals.length-2]) : null;
                    const d      = deltaInfo(latest!==null&&prev!==null ? latest-prev : null);
                    const status = statusFor(field, latest);
                    const color  = TREND_COLOR[field.key]||"#38bdf8";
                    return (
                      <div className="trend-card" key={field.key}>
                        <div className="trend-header">
                          <div>
                            <div className="trend-name">{field.label}</div>
                            <div className="trend-value" style={{color:statusColors[status]}}>
                              {latest!==null ? latest.toFixed(1) : "—"}
                              <span style={{fontSize:14,fontWeight:400,color:"#475569",marginLeft:4}}>{field.unit}</span>
                            </div>
                            {d && prev!==null && (
                              <div className="trend-prev" style={{color:d.color}}>
                                {d.icon} {d.label} from {prev.toFixed(1)}
                              </div>
                            )}
                          </div>
                          <div style={{textAlign:"right"}}>
                            <Sparkline data={vals} color={color}/>
                            {field.ideal && <div className="trend-range">Ideal {field.ideal[0]}–{field.ideal[1]}</div>}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  <div className="section-label">Recent Entries</div>
                  {[...history].reverse().slice(0,5).map((row,i) => (
                    <div key={i} style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:12,padding:"12px 14px",marginBottom:6}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                        <span style={{fontSize:13,fontWeight:600,color:"#7dd3fc"}}>{row.date}</span>
                        {row.comments && <span style={{fontSize:11,color:"#475569",maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{row.comments}</span>}
                      </div>
                      <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                        {DATA_FIELDS.filter(f=>f.key!=="comments"&&row[f.key]!=="").map(f=>(
                          <div key={f.key} style={{fontSize:12}}>
                            <span style={{color:"#475569"}}>{f.label.split(" ")[0]}: </span>
                            <span style={{color:"#e2e8f0",fontFamily:"'DM Mono',monospace",fontWeight:500}}>{row[f.key]}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div style={{height:40}}/>
                </>
              )}
            </>
          )}
        </div>

        {/* Save button */}
        {view === "form" && signedIn && (
          <div className="save-btn">
            <button className="btn-save" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save to Google Sheets"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
