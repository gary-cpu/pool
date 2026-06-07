import { useState, useEffect, useCallback } from "react";

// ─── Supabase Config ──────────────────────────────────────────────────────────
const SUPABASE_URL = "https://evdgpuasmcnxljeupwxv.supabase.co";
const SUPABASE_KEY = "sb_publishable_5rEfGQJeFFmWS__aXcD1Jw_uWa3-Cri";
const TABLE        = "water_quality";

async function sbFetch(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        method === "POST" ? "return=representation" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.hint || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// ─── Field Definitions ────────────────────────────────────────────────────────
const FIELDS = [
  { key: "date",      label: "Date",              type: "date",   unit: "",    ideal: null },
  { key: "ph",        label: "pH",                type: "number", unit: "",    min: 6.8, max: 8.0,  ideal: [7.3, 7.5] },
  { key: "free_cl",   label: "Free Chlorine",     type: "number", unit: "ppm", min: 0,   max: 10,   ideal: [0.5, 1.0] },
  { key: "combo_cl",  label: "Combined Chlorine", type: "number", unit: "ppm", min: 0,   max: 5,    ideal: [0, 0.5] },
  { key: "alk",       label: "Alkalinity",        type: "number", unit: "ppm", min: 60,  max: 200,  ideal: [80, 150] },
  { key: "cya",       label: "Cyanuric Acid",     type: "number", unit: "ppm", min: 0,   max: 200,  ideal: [30, 50] },
  { key: "temp",      label: "Water Temp",        type: "number", unit: "°C",  min: 0,   max: 45,   ideal: null },
  { key: "comments",  label: "Comments",          type: "text",   unit: "",    ideal: null },
];

const DATA_FIELDS  = FIELDS.filter(f => f.type === "number");
const TREND_COLOR  = { ph:"#38bdf8", free_cl:"#4ade80", combo_cl:"#fb923c", alk:"#a78bfa", cya:"#f472b6", temp:"#fbbf24" };
const STATUS_COLOR = { good:"#22c55e", warn:"#f59e0b", bad:"#ef4444", neutral:"#94a3b8" };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().split("T")[0]; }

function statusFor(field, value) {
  if (!field.ideal || value === "" || value === null || value === undefined) return "neutral";
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
  const [view,        setView]        = useState("form");
  const [form,        setForm]        = useState({ date: today() });
  const [saving,      setSaving]      = useState(false);
  const [saveError,   setSaveError]   = useState(null);
  const [history,     setHistory]     = useState([]);
  const [loadingHist, setLoadingHist] = useState(true);
  const [lastRow,     setLastRow]     = useState(null);
  const [toast,       setToast]       = useState(null);

  // ── Load history on mount ────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    setLoadingHist(true);
    try {
      const rows = await sbFetch("GET", `${TABLE}?order=date.asc&limit=200`);
      setHistory(rows || []);
      if (rows && rows.length > 0) setLastRow(rows[rows.length - 1]);
    } catch(e) {
      showToast("⚠️ Could not load history: " + e.message, "err");
    } finally {
      setLoadingHist(false);
    }
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

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
    setSaving(true);
    setSaveError(null);
    try {
      const row = { date: form.date || today() };
      DATA_FIELDS.forEach(f => {
        const v = parseFloat(form[f.key]);
        if (!isNaN(v)) row[f.key] = v;
      });
      if (form.comments?.trim()) row.comments = form.comments.trim();

      const result = await sbFetch("POST", TABLE, row);
      const saved = Array.isArray(result) ? result[0] : result;
      setHistory(h => [...h, saved]);
      setLastRow(saved);
      showToast("✓ Saved!", "ok");
      setForm({ date: today() });
      setView("trends");
    } catch(e) {
      setSaveError("Save failed: " + e.message);
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

    .tab-bar { position: relative; z-index: 1; display: flex; margin: 0 24px 20px; background: rgba(255,255,255,0.05); border-radius: 12px; padding: 4px; }
    .tab { flex: 1; padding: 8px; text-align: center; font-size: 14px; font-weight: 500; border-radius: 9px; cursor: pointer; transition: all 0.2s; color: #64748b; border: none; background: transparent; font-family: 'DM Sans', sans-serif; }
    .tab.active { background: #0ea5e9; color: white; box-shadow: 0 2px 8px rgba(14,165,233,0.4); }

    .scroll-body { position: relative; z-index: 1; flex: 1; overflow-y: auto; padding: 0 16px 120px; -webkit-overflow-scrolling: touch; }

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
    .status-dot.good    { background: #22c55e; box-shadow: 0 0 6px #22c55e88; }
    .status-dot.warn    { background: #f59e0b; box-shadow: 0 0 6px #f59e0b88; }
    .status-dot.bad     { background: #ef4444; box-shadow: 0 0 6px #ef444488; }
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
    .trend-name { font-size: 14px; font-weight: 500; color: #94a3b8; }
    .trend-value { font-size: 26px; font-weight: 700; font-family: 'DM Mono', monospace; }
    .trend-prev { font-size: 12px; margin-top: 2px; }
    .trend-range { font-size: 11px; color: #334155; font-family: 'DM Mono', monospace; margin-top: 4px; }

    .toast { position: fixed; top: 60px; left: 50%; transform: translateX(-50%); z-index: 100; background: #1e293b; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 500; color: #f0f9ff; box-shadow: 0 8px 32px rgba(0,0,0,0.4); animation: slideDown 0.3s ease; white-space: nowrap; }
    .toast.ok  { border-color: rgba(34,197,94,0.4); }
    .toast.err { border-color: rgba(239,68,68,0.4); }
    @keyframes slideDown { from { opacity:0; transform: translateX(-50%) translateY(-10px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }

    .empty-state { text-align: center; padding: 48px 24px; color: #475569; font-size: 14px; }
    .empty-icon { font-size: 40px; margin-bottom: 12px; }
    .history-row { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 12px 14px; margin-bottom: 6px; }
    .history-date { font-size: 13px; font-weight: 600; color: #7dd3fc; margin-bottom: 6px; }
    .history-vals { display: flex; gap: 12px; flex-wrap: wrap; }
    .history-val { font-size: 12px; }
    .history-val span:first-child { color: #475569; }
    .history-val span:last-child { color: #e2e8f0; font-family: 'DM Mono', monospace; font-weight: 500; }
  `;

  return (
    <>
      <style>{css}</style>
      <div className="app">

        <div className="water-bg">
          <div className="wave"/><div className="wave"/>
        </div>

        {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}

        <div className="header">
          <div>
            <div className="header-title">🏊 Pool Log</div>
            <div className="header-sub">14,200 gal · {new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>
          </div>
        </div>

        <div className="tab-bar">
          <button className={`tab ${view==="form"?"active":""}`}   onClick={()=>setView("form")}>📋 Log Test</button>
          <button className={`tab ${view==="trends"?"active":""}`} onClick={()=>setView("trends")}>📈 Trends</button>
        </div>

        <div className="scroll-body">

          {/* ── FORM VIEW ──────────────────────────────────────────── */}
          {view === "form" && (
            <>
              <div className="section-label">Test Date</div>
              <div className="field-row">
                <div className="field-meta"><div className="field-label">Date</div></div>
                <input type="date" className="date-input" value={form.date||today()} onChange={e=>setField("date",e.target.value)}/>
              </div>

              <div className="section-label">Chemical Readings</div>
              {DATA_FIELDS.map(field => {
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

          {/* ── TRENDS VIEW ────────────────────────────────────────── */}
          {view === "trends" && (
            <>
              {loadingHist && (
                <div className="empty-state"><div className="empty-icon">⏳</div>Loading…</div>
              )}

              {!loadingHist && history.length === 0 && (
                <div className="empty-state">
                  <div className="empty-icon">📊</div>
                  No data yet — log your first test!
                </div>
              )}

              {!loadingHist && history.length > 0 && (
                <>
                  {DATA_FIELDS.map(field => {
                    const vals = history.map(r => r[field.key]).filter(v => v !== null && v !== undefined && !isNaN(parseFloat(v)));
                    const latest = vals.length > 0 ? parseFloat(vals[vals.length-1]) : null;
                    const prev   = vals.length > 1 ? parseFloat(vals[vals.length-2]) : null;
                    const d      = deltaInfo(latest !== null && prev !== null ? latest - prev : null);
                    const status = statusFor(field, latest);
                    const color  = TREND_COLOR[field.key] || "#38bdf8";
                    return (
                      <div className="trend-card" key={field.key}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                          <div>
                            <div className="trend-name">{field.label}</div>
                            <div className="trend-value" style={{color:STATUS_COLOR[status]}}>
                              {latest !== null ? latest.toFixed(1) : "—"}
                              <span style={{fontSize:14,fontWeight:400,color:"#475569",marginLeft:4}}>{field.unit}</span>
                            </div>
                            {d && prev !== null && (
                              <div className="trend-prev" style={{color:d.color}}>{d.icon} {d.label} from {prev.toFixed(1)}</div>
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
                    <div key={i} className="history-row">
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div className="history-date">{row.date}</div>
                        {row.comments && <span style={{fontSize:11,color:"#475569",maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{row.comments}</span>}
                      </div>
                      <div className="history-vals">
                        {DATA_FIELDS.filter(f => row[f.key] !== null && row[f.key] !== undefined).map(f => (
                          <div key={f.key} className="history-val">
                            <span>{f.label.split(" ")[0]}: </span>
                            <span>{parseFloat(row[f.key]).toFixed(1)}</span>
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

        {view === "form" && (
          <div className="save-btn">
            <button className="btn-save" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save Reading"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
