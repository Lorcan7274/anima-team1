/**
 * Homeward ward-list UI, Mercury-style: light surfaces, Inter variable font
 * with measured weights (420/480/530), cobalt actions, sidebar, KPI tiles
 * with a live sparkline, patient cards, an Accounts-style Services rail,
 * and the activity log.
 *
 * Polls /state every 2s. Buttons: "Approve plan" (header, staff approval of
 * all proposed items), "Confirm reviewed" (clinical hold sign-off),
 * "Prepare escalation" (blocked_human handover). No dependencies — Node http
 * + one page. Inter loads from Google Fonts; falls back to system-ui offline.
 *
 * Colors follow the dataviz skill's fixed status palette (icon + label,
 * never color alone); text stays in ink tokens, the dot carries the color.
 */
import { createServer } from 'node:http'
import type { BoardState } from '../orchestrator/model.ts'
import { approveAll, clearHold, prepareEscalation } from '../orchestrator/run.ts'

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Homeward</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap" rel="stylesheet">
<style>
  :root{
    --page:#f9f9f7; --surface:#ffffff; --ink:#0b0b0b; --ink-2:#52514e; --ink-3:#898781;
    --hairline:rgba(11,11,11,0.10); --grid:#e1e0d9;
    --accent:#5266eb; --accent-soft:rgba(82,102,235,0.08);
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
  .brand .mark{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#5266eb,#7a8cf0);
               display:grid;place-items:center;color:#fff;font-weight:530;font-size:13px}
  .brand .name{font-weight:480;font-size:14px}
  .brand .sub{font-size:11px;color:var(--ink-3)}
  .nav-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;color:var(--ink-2);
            font-weight:420;cursor:pointer}
  .nav-item.active{background:var(--accent-soft);color:var(--accent);font-weight:480}
  .nav-item:hover:not(.active){background:#f4f4f1}
  .sidebar .foot{margin-top:auto;padding:10px;font-size:12px;color:var(--ink-3);border-top:1px solid var(--grid)}
  .sidebar .foot b{color:var(--ink-2);font-weight:480}

  .main{padding:28px 36px;max-width:1140px}
  .header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px}
  h1{font-size:22px;font-weight:480;letter-spacing:0.01em}
  .subtitle{color:var(--ink-3);font-size:13px;margin-top:2px}
  button.primary{font:inherit;font-size:13px;font-weight:480;color:#fff;background:var(--accent);
                 border:none;border-radius:999px;padding:9px 20px;cursor:pointer;white-space:nowrap}
  button.primary:hover{filter:brightness(1.06)}

  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}
  .kpi{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--radius);padding:14px 16px;
       position:relative;overflow:hidden}
  .kpi .label{font-size:12px;color:var(--ink-3);font-weight:420}
  .kpi .value{font-size:26px;font-weight:530;letter-spacing:-0.01em;margin-top:2px}
  .kpi .hint{font-size:11px;color:var(--ink-3)}
  .kpi.has-spark{padding-bottom:40px}
  .kpi svg{position:absolute;left:0;right:0;bottom:0;width:100%;height:28px;display:block}

  .content{display:grid;grid-template-columns:1fr 300px;gap:14px;align-items:start}
  .card{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--radius);
        padding:18px 20px;margin-bottom:14px;box-shadow:0 1px 2px rgba(11,11,11,0.03)}
  .rail .card{padding:16px 18px}
  .rail h2,.log-card h2{font-size:13px;font-weight:480;margin-bottom:6px}

  .patient-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .avatar{width:34px;height:34px;border-radius:50%;background:rgba(82,102,235,0.10);color:var(--accent);
          display:grid;place-items:center;font-weight:480;font-size:13px;flex:none}
  .patient-name{font-weight:480;font-size:15px}
  .patient-meta{color:var(--ink-3);font-size:12px}
  .ready-pill{margin-left:auto;display:flex;align-items:center;gap:10px}
  .ready-pill .count{font-size:12px;color:var(--ink-2);font-weight:420;white-space:nowrap}
  .bar{width:110px;height:6px;border-radius:3px;background:var(--grid);overflow:hidden}
  .bar>i{display:block;height:100%;background:var(--good);border-radius:3px}

  .items{margin-top:12px}
  .item{display:flex;align-items:baseline;gap:10px;padding:9px 0;border-top:1px solid var(--grid)}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;
        font-size:11px;font-weight:480;color:var(--ink-2);background:#f4f4f1;flex:none;min-width:92px;justify-content:center}
  .chip .dot{width:7px;height:7px;border-radius:50%;flex:none}
  .owner{font-size:11px;color:var(--ink-3);min-width:76px;font-weight:420}
  .item .title{font-weight:420}
  .evidence{color:var(--ink-3);font-size:12px;font-style:italic}
  .err{color:var(--critical);font-size:12px}
  .item .right{margin-left:auto;flex:none}
  button.confirm{font:inherit;font-size:12px;font-weight:480;color:var(--accent);background:var(--surface);
                 border:1px solid var(--accent);border-radius:999px;padding:4px 14px;cursor:pointer}
  button.confirm:hover{background:var(--accent-soft)}
  .escalation{margin-top:6px;padding:8px 10px;border:1px solid var(--hairline);border-left:3px solid var(--accent);
              border-radius:6px;font-size:12px;color:var(--ink-2);background:var(--accent-soft)}

  .svc{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--grid)}
  .svc:first-of-type{border-top:none}
  .svc .ic{width:28px;height:28px;border-radius:50%;background:rgba(82,102,235,0.10);color:var(--accent);
           display:grid;place-items:center;font-size:10px;font-weight:480;flex:none}
  .svc .nm{font-size:13px;font-weight:420}
  .svc .n{margin-left:auto;font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums}
  .svc .n.clear{color:var(--ink-3)}

  #log{font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums;
       display:flex;flex-direction:column-reverse;gap:4px;max-height:300px;overflow:auto}
  #log div{border-top:1px solid var(--grid);padding-top:4px}
</style></head><body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="mark">H</div>
      <div><div class="name">Homeward</div><div class="sub">discharge coordination</div></div></div>
    <div class="nav-item active">Ward round</div>
    <div class="nav-item" onclick="document.getElementById('audit').scrollIntoView({behavior:'smooth'})">Activity</div>
    <div class="foot">world <b id="world">—</b><br>sim clock <b id="clock">—</b></div>
  </aside>
  <main class="main">
    <div class="header">
      <div><h1>Ward round</h1>
        <div class="subtitle">Barriers detected from the record · resolved in the owning service · verified after time moves</div></div>
      <button class="primary" id="approveBtn" style="display:none" onclick="approve()">Approve plan</button>
    </div>
    <div class="kpis" id="kpis"></div>
    <div class="content">
      <div id="board"></div>
      <div class="rail">
        <div class="card"><h2>Services</h2><div id="services"></div></div>
        <div class="card log-card" id="audit"><h2>Activity</h2><div id="log"></div></div>
      </div>
    </div>
  </main>
</div>
<script>
const META = {
  proposed:               { label: 'Proposed',   color: 'var(--serious)' },
  approved:               { label: 'Approved',   color: 'var(--warning)' },
  resolving:              { label: 'Working',    color: 'var(--warning)' },
  awaiting_verification:  { label: 'Verifying',  color: 'var(--warning)' },
  verified:               { label: 'Verified',   color: 'var(--good)' },
  failed:                 { label: 'Failed',     color: 'var(--critical)' },
  clinical_hold:          { label: 'Clinical hold', color: 'var(--accent)' },
  blocked_human:          { label: 'Human decision', color: 'var(--ink-2)' },
}
const SERVICES = {
  gp: 'GP Records', hospital: 'Hospital EPR', pharmacy: 'Pharmacy', community: 'Community Care',
  diagnostics: 'Diagnostics', wearables: 'Home Health', clinician: 'Clinician',
}
const OWNER_LABEL = {
  gp: 'GP', hospital: 'Hospital', pharmacy: 'Pharmacy', community: 'Community',
  diagnostics: 'Diagnostics', wearables: 'Home Health', clinician: 'Clinician',
}
const OPEN = ['proposed','approved','resolving','awaiting_verification','failed']
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const q = (s) => esc(String(s ?? '').replace(/"/g, ''))
const chip = (state) => {
  const m = META[state] || { label: state, color: 'var(--ink-3)' }
  return '<span class="chip"><span class="dot" style="background:' + m.color + '"></span>' + m.label + '</span>'
}
const history = []
const spark = () => {
  if (history.length < 2) return ''
  const max = Math.max(...history, 1)
  const pts = history.map((v, i) =>
    (i / (history.length - 1) * 100).toFixed(1) + ',' + (26 - (v / max) * 22).toFixed(1)).join(' ')
  return '<svg viewBox="0 0 100 30" preserveAspectRatio="none">' +
    '<polygon points="0,30 ' + pts + ' 100,30" fill="rgba(82,102,235,0.10)"/>' +
    '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>'
}
const kpi = (label, value, hint, extra) =>
  '<div class="kpi' + (extra ? ' has-spark' : '') + '"><div class="label">' + label + '</div><div class="value">' + value + '</div>' +
  (hint ? '<div class="hint">' + hint + '</div>' : '') + (extra || '') + '</div>'

function render(s) {
  document.getElementById('world').textContent = s.world
  document.getElementById('clock').textContent = new Date(s.simNow).toISOString().slice(0, 16).replace('T', ' ')
  const all = s.patients.flatMap((p) => p.items)
  const ready = s.patients.filter((p) => p.items.length && p.items.every((i) => i.state === 'verified')).length
  const open = all.filter((i) => OPEN.includes(i.state)).length
  const human = all.filter((i) => i.state === 'clinical_hold' || i.state === 'blocked_human').length
  if (history[history.length - 1] !== open) history.push(open)
  if (history.length > 60) history.shift()
  document.getElementById('kpis').innerHTML =
    kpi('On the ward', s.patients.length, 'tracked patients') +
    kpi('Ready to discharge', ready, 'every item verified') +
    kpi('Open barriers', open, 'agent is working these', spark()) +
    kpi('Awaiting a human', human, 'holds + external decisions')

  const proposed = all.filter((i) => i.state === 'proposed').length
  const btn = document.getElementById('approveBtn')
  btn.style.display = proposed ? '' : 'none'
  btn.textContent = 'Approve plan (' + proposed + ')'

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
        '<span class="owner">' + (OWNER_LABEL[i.owner] || esc(i.owner)) + '</span>' +
        '<span><span class="title">' + esc(i.title) + '</span>' +
        ((i.evidence || [])[0] ? ' <span class="evidence">&ldquo;' + q(i.evidence[0].quote) + '&rdquo;</span>' : '') +
        (i.state === 'proposed' && i.proposedAction ? ' <span class="evidence">&rarr; ' + esc(i.proposedAction) + '</span>' : '') +
        (i.error ? ' <span class="err">' + esc(i.error) + '</span>' : '') +
        (i.escalation
          ? '<div class="escalation"><b>Escalated to ' + esc(i.escalation.responsibleTeam) + '</b> — ' +
            esc(i.escalation.nextAction) + '<br>' + esc(i.escalation.note) + ' <i>Case remains blocked.</i></div>'
          : '') + '</span>' +
        (i.state === 'clinical_hold'
          ? '<span class="right"><button class="confirm" onclick="clearHold(\\'' + i.id + '\\')">Confirm reviewed</button></span>'
          : '') +
        (i.state === 'blocked_human' && !i.escalation
          ? '<span class="right"><button class="confirm" onclick="escalate(\\'' + i.id + '\\')">Prepare escalation</button></span>'
          : '') +
        '</div>').join('') +
      ((p.insights || []).length
        ? p.insights.map((n) =>
            '<div class="item"><span class="chip"><span class="dot" style="background:var(--accent)"></span>Agent noted</span>' +
            '<span class="owner">reading</span><span><span class="title">' + esc(n.title) + '</span>' +
            (n.quote ? ' <span class="evidence">&ldquo;' + q(n.quote) + '&rdquo;</span>' : '') +
            ' <span class="evidence">(non-blocking)</span></span></div>').join('')
        : '') + '</div></div>'
  }).join('')

  document.getElementById('services').innerHTML = Object.entries(SERVICES).map(([key, name]) => {
    const n = all.filter((i) => i.owner === key && i.state !== 'verified').length
    const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('')
    return '<div class="svc"><span class="ic">' + initials + '</span><span class="nm">' + name + '</span>' +
      '<span class="n' + (n ? '' : ' clear') + '">' + (n ? n + ' open' : 'clear') + '</span></div>'
  }).join('')

  document.getElementById('log').innerHTML = (s.log || []).slice(-40).map((l) => '<div>' + esc(l) + '</div>').join('')
}
async function tick() { try { render(await (await fetch('/state')).json()) } catch {} }
async function clearHold(id) { await fetch('/clear-hold?item=' + encodeURIComponent(id), { method: 'POST' }); tick() }
async function approve() { await fetch('/approve', { method: 'POST' }); tick() }
async function escalate(id) { await fetch('/escalate?item=' + encodeURIComponent(id), { method: 'POST' }); tick() }
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
    } else if (url.pathname === '/approve' && req.method === 'POST') {
      const n = approveAll(board, 'Demo coordinator', url.searchParams.get('patient') || undefined)
      res.end(String(n))
    } else if (url.pathname === '/escalate' && req.method === 'POST') {
      prepareEscalation(board, url.searchParams.get('item') ?? '').then((ok) => {
        res.statusCode = ok ? 200 : 404
        res.end(ok ? 'escalated' : 'not found')
      })
    } else {
      res.setHeader('content-type', 'text/html')
      res.end(PAGE)
    }
  }).listen(port)
  console.log(`ward list: http://localhost:${port}`)
}
