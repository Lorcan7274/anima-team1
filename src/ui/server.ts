/**
 * Ward-list UI, Mercury-style: light surfaces, Inter, sidebar, KPI tiles,
 * card per patient with status-chip checklist rows, audit log.
 *
 * Polls /state every 2s. "Confirm reviewed" on a clinical hold is the human
 * sign-off beat (POST /clear-hold). No dependencies — Node http + one page.
 * Inter loads from Google Fonts; falls back to system-ui offline.
 *
 * Colors follow the dataviz skill's fixed status palette (icon + label,
 * never color alone); text stays in ink tokens, the dot carries the color.
 */
import { createServer } from 'node:http'
import type { BoardState } from '../orchestrator/model.ts'
import { clearHold } from '../orchestrator/run.ts'

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Discharge Desk</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --page:#f9f9f7; --surface:#ffffff; --ink:#0b0b0b; --ink-2:#52514e; --ink-3:#898781;
    --hairline:rgba(11,11,11,0.10); --grid:#e1e0d9;
    --accent:#4a3aa7; --accent-soft:rgba(74,58,167,0.08);
    --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
    --radius:12px;
  }
  *{box-sizing:border-box;margin:0}
  body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--page);color:var(--ink);
       font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased}
  a{color:inherit;text-decoration:none}

  .app{display:grid;grid-template-columns:224px 1fr;min-height:100vh}
  .sidebar{background:var(--surface);border-right:1px solid var(--hairline);padding:20px 14px;
           display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh}
  .brand{display:flex;align-items:center;gap:10px;padding:4px 8px 18px}
  .brand .mark{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#4a3aa7,#7a63d8);
               display:grid;place-items:center;color:#fff;font-weight:700;font-size:13px}
  .brand .name{font-weight:600;font-size:14px}
  .brand .sub{font-size:11px;color:var(--ink-3)}
  .nav-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;color:var(--ink-2);
            font-weight:500;cursor:pointer}
  .nav-item.active{background:var(--accent-soft);color:var(--accent)}
  .nav-item:hover:not(.active){background:#f4f4f1}
  .sidebar .foot{margin-top:auto;padding:10px;font-size:12px;color:var(--ink-3);border-top:1px solid var(--grid)}
  .sidebar .foot b{color:var(--ink-2);font-weight:600}

  .main{padding:28px 36px;max-width:1080px}
  h1{font-size:22px;font-weight:600;letter-spacing:-0.01em}
  .subtitle{color:var(--ink-3);font-size:13px;margin-top:2px}

  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}
  .kpi{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--radius);padding:14px 16px}
  .kpi .label{font-size:12px;color:var(--ink-3);font-weight:500}
  .kpi .value{font-size:26px;font-weight:600;letter-spacing:-0.02em;margin-top:2px}
  .kpi .hint{font-size:11px;color:var(--ink-3)}

  .card{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--radius);
        padding:18px 20px;margin-bottom:14px;box-shadow:0 1px 2px rgba(11,11,11,0.03)}
  .patient-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .avatar{width:34px;height:34px;border-radius:50%;background:#eceaf6;color:var(--accent);
          display:grid;place-items:center;font-weight:600;font-size:13px;flex:none}
  .patient-name{font-weight:600;font-size:15px}
  .patient-meta{color:var(--ink-3);font-size:12px}
  .ready-pill{margin-left:auto;display:flex;align-items:center;gap:10px}
  .ready-pill .count{font-size:12px;color:var(--ink-2);font-weight:500;white-space:nowrap}
  .bar{width:120px;height:6px;border-radius:3px;background:var(--grid);overflow:hidden}
  .bar>i{display:block;height:100%;background:var(--good);border-radius:3px}

  .item{display:flex;align-items:baseline;gap:10px;padding:9px 0;border-top:1px solid var(--grid)}
  .items{margin-top:12px}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;
        font-size:11px;font-weight:600;color:var(--ink-2);background:#f4f4f1;flex:none;min-width:92px;justify-content:center}
  .chip .dot{width:7px;height:7px;border-radius:50%;flex:none}
  .owner{font-size:11px;color:var(--ink-3);min-width:76px;font-weight:500;text-transform:capitalize}
  .item .title{font-weight:500}
  .evidence{color:var(--ink-3);font-size:12px;font-style:italic}
  .err{color:var(--critical);font-size:12px}
  .item .right{margin-left:auto;flex:none}
  button.confirm{font:inherit;font-size:12px;font-weight:600;color:var(--accent);background:var(--surface);
                 border:1px solid var(--accent);border-radius:8px;padding:4px 12px;cursor:pointer}
  button.confirm:hover{background:var(--accent-soft)}

  .log-card h2{font-size:14px;font-weight:600;margin-bottom:10px}
  #log{font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums;
       display:flex;flex-direction:column-reverse;gap:4px;max-height:260px;overflow:auto}
  #log div{border-top:1px solid var(--grid);padding-top:4px}
</style></head><body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="mark">DD</div>
      <div><div class="name">Discharge Desk</div><div class="sub">neighbourhood coordination</div></div></div>
    <div class="nav-item active">Ward list</div>
    <div class="nav-item" onclick="document.getElementById('audit').scrollIntoView({behavior:'smooth'})">Audit log</div>
    <div class="foot">world <b id="world">—</b><br>sim clock <b id="clock">—</b></div>
  </aside>
  <main class="main">
    <h1 id="greeting">Ward list</h1>
    <div class="subtitle">Barriers detected from the record · resolved in the owning service · verified after time moves</div>
    <div class="kpis" id="kpis"></div>
    <div id="board"></div>
    <div class="card log-card" id="audit"><h2>Audit log</h2><div id="log"></div></div>
  </main>
</div>
<script>
const META = {
  detected:               { label: 'Barrier',    color: 'var(--serious)' },
  resolving:              { label: 'Working',    color: 'var(--warning)' },
  awaiting_verification:  { label: 'Verifying',  color: 'var(--warning)' },
  verified:               { label: 'Verified',   color: 'var(--good)' },
  failed:                 { label: 'Failed',     color: 'var(--critical)' },
  clinical_hold:          { label: 'Clinician',  color: 'var(--accent)' },
  blocked_human:          { label: 'Human decision', color: 'var(--ink-2)' },
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const chip = (state) => {
  const m = META[state] || { label: state, color: 'var(--ink-3)' }
  return '<span class="chip"><span class="dot" style="background:' + m.color + '"></span>' + m.label + '</span>'
}
const kpi = (label, value, hint) =>
  '<div class="kpi"><div class="label">' + label + '</div><div class="value">' + value + '</div>' +
  (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>'

function render(s) {
  document.getElementById('world').textContent = s.world
  document.getElementById('clock').textContent = new Date(s.simNow).toISOString().slice(0, 16).replace('T', ' ')
  const all = s.patients.flatMap((p) => p.items)
  const ready = s.patients.filter((p) => p.items.length && p.items.every((i) => i.state === 'verified')).length
  const open = all.filter((i) => ['detected','resolving','awaiting_verification','failed'].includes(i.state)).length
  const human = all.filter((i) => i.state === 'clinical_hold' || i.state === 'blocked_human').length
  document.getElementById('kpis').innerHTML =
    kpi('On the ward', s.patients.length, 'tracked patients') +
    kpi('Ready to discharge', ready, 'every item verified') +
    kpi('Open barriers', open, 'agent is working these') +
    kpi('Awaiting a human', human, 'holds + external decisions')

  document.getElementById('board').innerHTML = s.patients.map((p) => {
    const done = p.items.filter((i) => i.state === 'verified').length
    const pct = p.items.length ? Math.round((100 * done) / p.items.length) : 0
    const initials = esc(p.name).split(' ').map((w) => w[0]).slice(0, 2).join('')
    return '<div class="card">' +
      '<div class="patient-head"><div class="avatar">' + initials + '</div>' +
      '<div><div class="patient-name">' + esc(p.name) + '</div>' +
      '<div class="patient-meta">' + esc(p.patientId) + ' · ' + esc(p.stage ?? '?') +
      (p.location ? ' · ' + esc(p.location) : '') + ' · ' + esc((p.conditions || []).join(', ')) + '</div></div>' +
      '<div class="ready-pill"><span class="count">' + done + ' of ' + p.items.length + ' verified</span>' +
      '<span class="bar"><i style="width:' + pct + '%"></i></span></div></div>' +
      '<div class="items">' + p.items.map((i) =>
        '<div class="item">' + chip(i.state) +
        '<span class="owner">' + esc(i.owner) + '</span>' +
        '<span><span class="title">' + esc(i.title) + '</span>' +
        ((i.evidence || [])[0] ? ' <span class="evidence">&ldquo;' + esc(i.evidence[0].quote) + '&rdquo;</span>' : '') +
        (i.error ? ' <span class="err">' + esc(i.error) + '</span>' : '') + '</span>' +
        (i.state === 'clinical_hold'
          ? '<span class="right"><button class="confirm" onclick="clearHold(\\'' + i.id + '\\')">Confirm reviewed</button></span>'
          : '') +
        '</div>').join('') + '</div></div>'
  }).join('')

  document.getElementById('log').innerHTML = (s.log || []).slice(-40).map((l) => '<div>' + esc(l) + '</div>').join('')
}
async function tick() { try { render(await (await fetch('/state')).json()) } catch {} }
async function clearHold(id) { await fetch('/clear-hold?item=' + encodeURIComponent(id), { method: 'POST' }); tick() }
setInterval(tick, 2000); tick()
</script></body></html>`

export function startUi(board: BoardState, port = 4600): void {
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/state') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(board))
    } else if (url.pathname === '/clear-hold' && req.method === 'POST') {
      const ok = clearHold(board, url.searchParams.get('item') ?? '', 'Demo clinician')
      res.statusCode = ok ? 200 : 404
      res.end(ok ? 'cleared' : 'not found')
    } else {
      res.setHeader('content-type', 'text/html')
      res.end(PAGE)
    }
  }).listen(port)
  console.log(`ward list: http://localhost:${port}`)
}
