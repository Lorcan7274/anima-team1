/**
 * Homeward ward-list UI, Mercury-style: light surfaces, Inter variable font
 * with measured weights (420/480/530), cobalt actions, sidebar, KPI tiles
 * with a live sparkline, collapsible patient cards, a patient-centred barrier
 * graph, an Accounts-style Services rail,
 * and the activity log.
 *
 * Polls /state every 2s. Buttons: "Approve plan" (header, staff approval of
 * all proposed items), "Confirm reviewed" (clinical hold sign-off),
 * "Prepare escalation" (blocked_human handover). Each KPI tile opens a modal
 * over a blurred backdrop listing the items behind that number with what the
 * agent planned, did, verified, and the evidence it quoted. No dependencies — Node http
 * + one page. Inter loads from Google Fonts; falls back to system-ui offline.
 *
 * Colors follow the dataviz skill's fixed status palette (icon + label,
 * never color alone); text stays in ink tokens, the dot carries the color.
 */
import { createServer } from 'node:http'
import type { BoardState } from '../orchestrator/model.ts'
import { approveAll, clearHold, prepareEscalation } from '../orchestrator/run.ts'

export const PAGE = `<!doctype html>
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
  button.ghost{font:inherit;font-size:12px;font-weight:480;color:var(--ink-2);background:var(--surface);
               border:1px solid var(--hairline);border-radius:999px;padding:8px 16px;cursor:pointer;white-space:nowrap}
  button.ghost:hover{background:#f4f4f1}
  .wire{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;display:flex;gap:8px;align-items:baseline;
        padding:5px 0;border-top:1px solid var(--grid);color:var(--ink-2)}
  .wire .m{min-width:38px;font-weight:600}
  .wire .m.post{color:var(--accent)}
  .wire .bad{color:var(--critical)}
  .wire .k{color:var(--ink-3)}
  .wire code{background:#f4f4f1;border-radius:4px;padding:0 4px}

  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}
  .kpi{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--radius);padding:14px 16px;
       position:relative;overflow:hidden}
  .kpi .label{font-size:12px;color:var(--ink-3);font-weight:420}
  .kpi .value{font-size:26px;font-weight:530;letter-spacing:-0.01em;margin-top:2px}
  .kpi .hint{font-size:11px;color:var(--ink-3)}
  .kpi.has-spark{padding-bottom:40px}
  .kpi{cursor:pointer;transition:border-color .12s,box-shadow .12s}
  .kpi:hover,.kpi:focus-visible{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);outline:none}
  .kpi .more{position:absolute;top:12px;right:14px;font-size:11px;color:var(--ink-3)}

  .modal-backdrop{position:fixed;inset:0;z-index:50;display:none;place-items:center;padding:24px;
                  background:rgba(11,11,11,0.28);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
  .modal-backdrop.open{display:grid}
  .modal{background:var(--surface);border:1px solid var(--hairline);border-radius:14px;width:min(760px,100%);
         max-height:84vh;overflow:auto;padding:20px 24px 24px;box-shadow:0 20px 60px rgba(11,11,11,0.18)}
  .modal-head{display:flex;align-items:center;gap:12px;margin-bottom:4px}
  .modal-head h2{font-size:17px;font-weight:480}
  .modal-head .sub{color:var(--ink-3);font-size:12px;margin-top:2px}
  .modal-head button{margin-left:auto}
  .modal .group{margin-top:16px}
  .modal .group h3{font-size:13px;font-weight:480;display:flex;gap:8px;align-items:baseline}
  .modal .group h3 span{color:var(--ink-3);font-size:11px;font-weight:420}
  .mi{padding:10px 0;border-top:1px solid var(--grid)}
  .mi .row{display:flex;align-items:baseline;gap:10px}
  .mi .detail{margin:6px 0 0 0;padding-left:8px;border-left:2px solid var(--grid);font-size:12px;color:var(--ink-2)}
  .mi .detail>div{margin-top:3px}
  .mi .detail b{font-weight:480;color:var(--ink)}
  .mi .detail code{font:inherit;font-size:11px;color:var(--ink-3)}
  .mi .trace{color:var(--ink-3);font-variant-numeric:tabular-nums}
  .modal .empty{color:var(--ink-3);font-size:13px;padding:18px 0}
  .kpi svg{position:absolute;left:0;right:0;bottom:0;width:100%;height:28px;display:block}

  .content{display:grid;grid-template-columns:1fr 300px;gap:14px;align-items:start}
  .card{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--radius);
        padding:18px 20px;margin-bottom:14px;box-shadow:0 1px 2px rgba(11,11,11,0.03)}
  .rail .card{padding:16px 18px}
  .rail h2,.log-card h2{font-size:13px;font-weight:480;margin-bottom:6px}

  .patient-card{padding:0;overflow:hidden;transition:border-color .16s}
  .patient-card.expanded{border-color:rgba(11,11,11,0.16)}
  .patient-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;width:100%;padding:16px 18px;
                border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
  .patient-head:hover{background:#fbfbf9}
  .patient-head:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .avatar{width:34px;height:34px;border-radius:50%;background:rgba(82,102,235,0.10);color:var(--accent);
          display:grid;place-items:center;font-weight:480;font-size:13px;flex:none}
  .patient-name{font-weight:480;font-size:15px}
  .patient-meta{color:var(--ink-3);font-size:12px}
  .ready-pill{margin-left:auto;display:flex;align-items:center;gap:10px}
  .ready-pill .count{font-size:12px;color:var(--ink-2);font-weight:420;white-space:nowrap}
  .bar{width:110px;height:6px;border-radius:3px;background:var(--grid);overflow:hidden}
  .bar>i{display:block;height:100%;background:var(--good);border-radius:3px}
  .chevron{width:20px;height:20px;display:grid;place-items:center;color:var(--ink-3);font-size:14px;line-height:1;
           transition:transform .16s,color .16s;flex:none}
  .patient-card.expanded .chevron{transform:rotate(180deg);color:var(--ink)}

  .items{margin-top:12px}
  .item{display:flex;align-items:baseline;gap:10px;padding:9px 0;border-top:1px solid var(--grid);cursor:pointer}
  .item:hover{background:#fbfbf9}
  .tag{font-size:9px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;border-radius:4px;
       padding:1px 5px;vertical-align:1px;white-space:nowrap}
  .tag.rec{background:#f4f4f1;color:var(--ink-3)}
  .tag.ai{background:var(--accent-soft);color:var(--accent)}
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

  .graph-wrap{border-top:1px solid var(--grid);padding:16px 18px 18px;background:var(--surface)}
  .graph-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:8px}
  .graph-title{font-size:12px;font-weight:480;color:var(--ink-2)}
  .legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;color:var(--ink-3);font-size:10px}
  .legend span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
  .legend i{width:7px;height:7px;border-radius:50%;display:block}
  .dependency-graph{height:430px;position:relative;isolation:isolate;overflow:hidden}
  .dependency-lines{position:absolute;inset:0;width:100%;height:100%;z-index:0;overflow:visible}
  .dependency-lines line{stroke-width:1;vector-effect:non-scaling-stroke;opacity:.26}
  .graph-hub{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;width:58px;height:58px;
             border-radius:50%;background:var(--surface);border:1px solid rgba(82,102,235,.52);display:grid;place-items:center}
  .graph-hub .person{position:relative;width:11px;height:11px;border:1.5px solid var(--accent);border-radius:50%;margin-top:-9px}
  .graph-hub .person:after{content:"";position:absolute;width:23px;height:12px;left:-7.5px;top:15px;border:1.5px solid var(--accent);
                           border-bottom:0;border-radius:14px 14px 0 0}
  .graph-node{--node-color:var(--ink-3);position:absolute;transform:translate(-50%,-50%);z-index:2;width:166px;min-height:62px;
              border:1px solid var(--hairline);border-left:3px solid var(--node-color);border-radius:10px;background:var(--surface);
              padding:10px 12px;cursor:pointer;text-align:left;transition:background .12s,border-color .12s}
  .graph-node:hover,.graph-node:focus-visible{background:#fafaf8;border-color:rgba(11,11,11,.20);border-left-color:var(--node-color);outline:none}
  .graph-node .node-top{display:flex;align-items:center;justify-content:space-between;gap:7px;margin-bottom:5px}
  .graph-node .node-owner{font-size:9px;font-weight:600;letter-spacing:.055em;text-transform:uppercase;color:var(--ink-3)}
  .graph-node .node-title{font-size:12px;line-height:1.3;font-weight:480}
  .graph-node .node-action{margin-top:7px;font:inherit;font-size:10px;font-weight:530;color:var(--accent);background:transparent;
                           border:0;padding:0;cursor:pointer}
  .graph-node.not-started{--node-color:#a5a39c}
  .graph-node.in-progress{--node-color:var(--warning)}
  .graph-node.stuck{--node-color:var(--critical)}
  .graph-node.completed{--node-color:var(--good)}
  .graph-insights{border-top:1px solid var(--grid);margin-top:6px;padding-top:10px;font-size:11px;color:var(--ink-2)}
  .graph-insights b{font-weight:480;color:var(--ink)}

  @media(max-width:900px){
    .app{grid-template-columns:1fr}.sidebar{display:none}.main{padding:22px 18px}.content{grid-template-columns:1fr}.rail{display:none}
    .kpis{grid-template-columns:repeat(2,1fr)}.dependency-graph{height:auto;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-top:104px}
    .dependency-lines{display:none}.graph-hub{top:18px;transform:translateX(-50%)}
    .graph-node{position:relative!important;left:auto!important;top:auto!important;transform:none!important;width:auto;min-height:62px}
  }
  @media(max-width:560px){.dependency-graph{grid-template-columns:1fr}.graph-toolbar{align-items:flex-start;flex-direction:column}.ready-pill .bar{display:none}}

  .svc{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--grid)}
  .svc:first-of-type{border-top:none}
  .svc .ic{width:28px;height:28px;border-radius:50%;background:rgba(82,102,235,0.10);color:var(--accent);
           display:grid;place-items:center;font-size:10px;font-weight:480;flex:none}
  .svc .nm{font-size:13px;font-weight:420}
  .svc .n{margin-left:auto;font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums}
  .svc .n.clear{color:var(--ink-3)}

  .status{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-2);
          background:var(--surface);border:1px solid var(--hairline);border-radius:999px;padding:6px 14px}
  .status.quiet{color:var(--ink-3)}
  .spin{width:13px;height:13px;border:2px solid var(--accent-soft);border-top-color:var(--accent);
        border-radius:50%;animation:spin .8s linear infinite;flex:none}
  @keyframes spin{to{transform:rotate(360deg)}}
  .loading-hero{display:flex;flex-direction:column;align-items:center;gap:16px;padding:110px 0;color:var(--ink-2)}
  .loading-hero .spin{width:34px;height:34px;border-width:3px}
  .loading-hero .what{font-size:14px;font-weight:480}
  .loading-hero .why{font-size:12px;color:var(--ink-3)}
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
      <span id="status"></span>
      <button class="ghost" onclick="openModal('trace')">Full trace</button>
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
<div class="modal-backdrop" id="modal" onclick="if (event.target === this) closeModal()">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="modal-head"><div><h2 id="modalTitle"></h2><div class="sub" id="modalSub"></div></div>
      <button class="confirm" onclick="closeModal()">Close</button></div>
    <div id="modalBody"></div>
  </div>
</div>
<script>
const META = {
  proposed:               { label: 'Not started', color: '#a5a39c' },
  approved:               { label: 'In progress', color: 'var(--warning)' },
  resolving:              { label: 'Working',    color: 'var(--warning)' },
  awaiting_verification:  { label: 'Verifying',  color: 'var(--warning)' },
  verified:               { label: 'Completed',  color: 'var(--good)' },
  failed:                 { label: 'Stuck',      color: 'var(--critical)' },
  clinical_hold:          { label: 'Clinical hold', color: 'var(--critical)' },
  blocked_human:          { label: 'Human decision', color: 'var(--critical)' },
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
const GRAPH_STATE = {
  proposed:              { key: 'not-started', label: 'Not started', color: '#a5a39c' },
  approved:              { key: 'in-progress', label: 'In progress', color: 'var(--warning)' },
  resolving:             { key: 'in-progress', label: 'In progress', color: 'var(--warning)' },
  awaiting_verification: { key: 'in-progress', label: 'In progress', color: 'var(--warning)' },
  failed:                { key: 'stuck', label: 'Stuck', color: 'var(--critical)' },
  clinical_hold:         { key: 'stuck', label: 'Stuck', color: 'var(--critical)' },
  blocked_human:         { key: 'stuck', label: 'Stuck', color: 'var(--critical)' },
  verified:              { key: 'completed', label: 'Completed', color: 'var(--good)' },
}
const graphState = (state) => GRAPH_STATE[state] || GRAPH_STATE.proposed
let expandedPatientId = null
let initialExpansionSet = false
function togglePatient(id) {
  expandedPatientId = expandedPatientId === id ? null : id
  if (lastState) render(lastState)
}
const taskTitle = (item) => {
  const id = item.id.toLowerCase()
  if (id.endsWith('clinical-hold')) return 'Clinical review'
  if (id.endsWith('medicines')) return 'Discharge medicines'
  if (id.endsWith('bloods')) return 'Blood monitoring'
  if (id.endsWith('device')) return 'Home monitoring'
  if (id.endsWith('visit')) return 'Home support visit'
  if (id.endsWith('summary')) return 'Discharge summary'
  if (id.endsWith('follow-up')) return 'GP follow-up'
  if (id.endsWith('care-package')) return 'Care package'
  return item.title
}
function graphForPatient(p) {
  const count = Math.max(p.items.length, 1)
  const positions = p.items.map((_, index) => {
    const angle = (-Math.PI / 2) + (index * Math.PI * 2 / count)
    return { x: 50 + Math.cos(angle) * 33, y: 50 + Math.sin(angle) * 36 }
  })
  const lines = p.items.map((i, index) => {
    const pos = positions[index]
    return '<line x1="50%" y1="50%" x2="' + pos.x.toFixed(2) + '%" y2="' + pos.y.toFixed(2) +
      '%" style="stroke:' + graphState(i.state).color + '" />'
  }).join('')
  const nodes = p.items.map((i, index) => {
    const pos = positions[index]
    const state = graphState(i.state)
    const label = taskTitle(i)
    const action = i.state === 'clinical_hold'
      ? '<button class="node-action" data-id="' + esc(i.id) + '" onclick="event.stopPropagation();clearHold(this.dataset.id)">Confirm reviewed</button>'
      : (i.state === 'blocked_human' && !i.escalation
        ? '<button class="node-action" data-id="' + esc(i.id) + '" onclick="event.stopPropagation();escalate(this.dataset.id)">Prepare escalation</button>'
        : '')
    return '<div class="graph-node ' + state.key + '" role="button" tabindex="0" data-id="' + esc(i.id) + '" ' +
      'aria-label="' + q((OWNER_LABEL[i.owner] || i.owner) + ': ' + label + '. ' + state.label) + '" title="' + q(i.title) + '" ' +
      'style="left:' + pos.x.toFixed(2) + '%;top:' + pos.y.toFixed(2) + '%" ' +
      'onclick="itemStory(this.dataset.id)" onkeydown="if(event.keyCode===13||event.keyCode===32){event.preventDefault();itemStory(this.dataset.id)}">' +
      '<div class="node-top"><span class="node-owner">' + (OWNER_LABEL[i.owner] || esc(i.owner)) + '</span></div>' +
      '<div class="node-title">' + esc(label) + '</div>' + action + '</div>'
  }).join('')
  const insights = (p.insights || []).length
    ? '<div class="graph-insights"><b>Agent observations:</b> ' + p.insights.map((n) => esc(n.title)).join(' · ') + '</div>'
    : ''
  return '<div class="graph-wrap"><div class="graph-toolbar"><span class="graph-title">Discharge dependencies</span>' +
    '<span class="legend"><span><i style="background:#a5a39c"></i>Not started</span>' +
    '<span><i style="background:var(--warning)"></i>In progress</span>' +
    '<span><i style="background:var(--critical)"></i>Stuck</span>' +
    '<span><i style="background:var(--good)"></i>Completed</span></span></div>' +
    '<div class="dependency-graph"><svg class="dependency-lines" aria-hidden="true">' + lines + '</svg>' +
    '<div class="graph-hub" aria-hidden="true"><span class="person"></span></div>' + nodes + '</div>' + insights + '</div>'
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
const kpi = (key, label, value, hint, extra) =>
  '<div class="kpi' + (extra ? ' has-spark' : '') + '" role="button" tabindex="0" onclick="openModal(\\'' + key + '\\')" ' +
  'onkeydown="if (event.key === \\'Enter\\' || event.key === \\' \\') { event.preventDefault(); openModal(\\'' + key + '\\') }">' +
  '<span class="more">details</span><div class="label">' + label + '</div><div class="value">' + value + '</div>' +
  (hint ? '<div class="hint">' + hint + '</div>' : '') + (extra || '') + '</div>'

// --- KPI detail modal: what the agent is doing behind each number ------------
const CATS = {
  ward:  { title: 'On the ward',        sub: 'every tracked patient and their full checklist',
           patients: (s) => s.patients, items: (p) => p.items },
  ready: { title: 'Ready to discharge', sub: 'patients with every item verified',
           patients: (s) => s.patients.filter((p) => p.items.length && p.items.every((i) => i.state === 'verified')), items: (p) => p.items },
  open:  { title: 'Open barriers',      sub: 'items the agent is proposing, working or verifying',
           patients: (s) => s.patients, items: (p) => p.items.filter((i) => OPEN.includes(i.state)) },
  human: { title: 'Awaiting a human',   sub: 'clinical holds and external decisions automation must not touch',
           patients: (s) => s.patients, items: (p) => p.items.filter((i) => i.state === 'clinical_hold' || i.state === 'blocked_human') },
}
let lastState = null
let openKey = null
const when = (ms) => ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : ''
const itemDetail = (i, log) => {
  const d = []
  if (i.proposedAction && (i.state === 'proposed' || i.state === 'approved')) d.push('<b>Plan:</b> ' + esc(i.proposedAction))
  if (i.approval) d.push('<b>Approved</b> by ' + esc(i.approval.by) + (i.approval.at ? ' at ' + when(i.approval.at) : ''))
  if (i.humanReason) d.push('<b>Why a human:</b> ' + esc(i.humanReason))
  if (i.resolution) d.push('<b>Agent did:</b> ' + esc(i.resolution.action) + ' &rarr; <code>' + esc(i.resolution.resourceId) + '</code>' +
    (i.resolution.atSimTime ? ' at ' + when(i.resolution.atSimTime) : '') + ' <code>key ' + esc(i.resolution.idempotencyKey) + '</code>')
  if (i.verification) d.push('<b>' + (i.verification.passed ? 'Verified:' : 'Checked, not yet:') + '</b> ' + esc(i.verification.observed) +
    (i.verification.atSimTime ? ' at ' + when(i.verification.atSimTime) : ''))
  if (i.error) d.push('<b class="err">Error:</b> <span class="err">' + esc(i.error) + '</span>')
  if (i.escalation) d.push('<b>Escalated to</b> ' + esc(i.escalation.responsibleTeam) + ' &mdash; ' + esc(i.escalation.nextAction) + '<br>' + esc(i.escalation.note))
  for (const e of i.evidence || []) d.push('<span class="evidence">&ldquo;' + q(e.quote) + '&rdquo;</span> <code>' + esc(e.site) + ' ' + esc(e.resourceId) + '</code>')
  const logLines = (log || []).filter((l) => l.includes(i.id)).slice(-3)
  for (const l of logLines) d.push('<span class="trace">' + esc(l) + '</span>')
  const wire = ((lastState && lastState.trace) || []).filter((t) => t.idempotencyKey && t.idempotencyKey.includes(i.id)).slice(-6)
  for (const t of wire) d.push(wireRow(t, false))
  return d.length ? '<div class="detail">' + d.map((x) => '<div>' + x + '</div>').join('') + '</div>' : ''
}
const wireRow = (t, withPayload) =>
  '<div class="wire"><span class="k">' + new Date(t.at).toTimeString().slice(0, 8) + '</span>' +
  '<span class="m' + (t.method === 'POST' ? ' post' : '') + '">' + esc(t.method) + '</span>' +
  '<span>' + esc(t.path.split('?')[0]) + '</span>' +
  (t.action ? '<code>' + esc(t.action) + '</code>' : '') +
  '<span class="' + (t.ok ? 'k' : 'bad') + '">' + (t.status || 'ERR') + '</span>' +
  (t.got ? '<span class="k">&rarr; ' + esc(t.got) + '</span>' : '') + '</div>' +
  (withPayload && t.sent
    ? '<div class="wire" style="border-top:none;padding-top:0"><span class="k">sent</span><code style="white-space:pre-wrap;word-break:break-all">' + esc(t.sent) + '</code></div>' +
      (t.idempotencyKey ? '<div class="wire" style="border-top:none;padding-top:0"><span class="k">key</span><code>' + esc(t.idempotencyKey) + '</code></div>' : '')
    : '')

function renderModal() {
  if (!lastState) return
  const s0 = lastState
  if (openKey === 'activity') {
    document.getElementById('modalTitle').textContent = s0.busy ? 'Working…' : 'Current activity'
    document.getElementById('modalSub').textContent = s0.phase || ''
    const recent = (s0.trace || []).slice(-15).reverse()
    document.getElementById('modalBody').innerHTML =
      '<div class="group"><h3>Most recent simulator calls <span>newest first · live</span></h3>' +
      (recent.length ? recent.map(wireRow).join('') : '<div class="empty">No calls yet.</div>') + '</div>' +
      '<div class="group"><h3>Recent activity log</h3>' +
      (s0.log || []).slice(-8).reverse().map((l) => '<div class="wire">' + esc(l) + '</div>').join('') + '</div>'
    return
  }
  if (openKey === 'trace') {
    const all = s0.trace || []
    const writes = all.filter((t) => t.method !== 'GET')
    document.getElementById('modalTitle').textContent = 'Full agent trace'
    document.getElementById('modalSub').textContent =
      all.length + ' simulator calls · ' + writes.length + ' writes · grouped by patient and task · every request, payload, idempotency key and response'
    const claimed = new Set()
    const forItem = (i) => all.filter((t) => t.idempotencyKey && t.idempotencyKey.includes(i.id)).map((t) => { claimed.add(t); return t })
    const html = []
    for (const p0 of s0.patients) {
      const parts = []
      for (const i of p0.items) {
        const rows = forItem(i)
        if (!rows.length) continue
        parts.push('<div class="mi"><div class="row">' + chip(i.state) + '<span class="owner">' + (OWNER_LABEL[i.owner] || esc(i.owner)) + '</span>' +
          '<span class="title">' + esc(i.title) + '</span></div>' + rows.map((t) => wireRow(t, true)).join('') + '</div>')
      }
      const reads = all.filter((t) => !claimed.has(t) && t.method === 'GET' &&
        (t.path.includes(p0.patientId) || (t.sent || '').includes(p0.patientId)))
      reads.forEach((t) => claimed.add(t))
      if (parts.length || reads.length) {
        html.push('<div class="group"><h3>' + esc(p0.name) + ' <span>' + esc(p0.patientId) + '</span></h3>' + parts.join('') +
          (reads.length ? '<div class="mi"><div class="row"><span class="owner">reads</span><span class="title">' + reads.length + ' record reads for this patient</span></div>' +
            reads.map((t) => wireRow(t, false)).join('') + '</div>' : '') + '</div>')
      }
    }
    const rest = all.filter((t) => !claimed.has(t))
    if (rest.length) {
      html.push('<div class="group"><h3>Run &amp; world <span>world setup, clock, un-attributed calls</span></h3>' +
        rest.map((t) => wireRow(t, t.method !== 'GET')).join('') + '</div>')
    }
    document.getElementById('modalBody').innerHTML = html.join('') || '<div class="empty">No calls yet.</div>'
    return
  }
  if (openKey && openKey.startsWith('item:')) {
    const id = openKey.slice(5)
    let found = null
    for (const p1 of s0.patients) { const i1 = p1.items.find((x) => x.id === id); if (i1) found = { p: p1, i: i1 } }
    if (!found) return
    const { p: p1, i } = found
    document.getElementById('modalTitle').textContent = i.title
    document.getElementById('modalSub').innerHTML = esc(p1.name) + ' · ' + (OWNER_LABEL[i.owner] || esc(i.owner)) + ' · ' + chip(i.state)
    const parts = []
    parts.push('<div class="group"><h3>1 · Detected from the record <span class="tag rec">record</span></h3>' +
      ((i.evidence || []).map((e) => '<div class="wire"><span class="evidence">&ldquo;' + q(e.quote) + '&rdquo;</span>' +
        '<code>' + esc(e.site) + ' ' + esc(e.resourceId) + '</code></div>').join('') || '<div class="empty">Rule-detected from structured state.</div>') + '</div>')
    parts.push('<div class="group"><h3>2 · Plan &amp; approval</h3>' +
      (i.proposedAction ? '<div class="wire">' + esc(i.proposedAction) + '</div>' : '') +
      (i.approval ? '<div class="wire">Approved by ' + esc(i.approval.by) + '</div>' : '<div class="empty">Not yet approved.</div>') +
      (i.humanReason ? '<div class="wire">' + esc(i.humanReason) + '</div>' : '') + '</div>')
    const wire = (s0.trace || []).filter((t) => t.idempotencyKey && t.idempotencyKey.includes(i.id))
    parts.push('<div class="group"><h3>3 · What the agent sent &amp; what the service replied <span>' + wire.length + ' calls</span></h3>' +
      (wire.length ? wire.map((t) => wireRow(t, true)).join('') : '<div class="empty">No actions yet.</div>') + '</div>')
    if (i.generated) parts.push('<div class="group"><h3>4 · Drafting provenance</h3><div class="wire">' +
      (i.generated === 'model' ? '<span class="tag ai">AI</span> content written by the live model' : '<span class="err">⚠ canned fallback — model unavailable</span>') + '</div></div>')
    if (i.verification) parts.push('<div class="group"><h3>' + (i.generated ? 5 : 4) + ' · Independent verification</h3><div class="wire">' +
      (i.verification.passed ? '✓ ' : '✗ ') + esc(i.verification.observed) + '</div></div>')
    if (i.escalation) parts.push('<div class="group"><h3>Escalation <span class="tag ai">AI</span></h3><div class="wire">' +
      esc(i.escalation.responsibleTeam) + ' — ' + esc(i.escalation.nextAction) + '</div><div class="wire">' + esc(i.escalation.note) + '</div></div>')
    document.getElementById('modalBody').innerHTML = parts.join('')
    return
  }
  const cat = CATS[openKey]
  if (!cat) return
  const s = lastState
  document.getElementById('modalTitle').textContent = cat.title
  document.getElementById('modalSub').textContent = cat.sub
  const groups = cat.patients(s).map((p) => ({ p, items: cat.items(p) })).filter((g) => openKey === 'ward' || openKey === 'ready' || g.items.length)
  document.getElementById('modalBody').innerHTML = groups.length ? groups.map((g) =>
    '<div class="group"><h3>' + esc(g.p.name) + ' <span>' + esc(g.p.patientId) + ' · ' + esc(g.p.stage ?? '?') +
    (g.p.location ? ' · ' + esc(g.p.location) : '') + ' · ' + g.items.filter((i) => i.state === 'verified').length + ' of ' + g.items.length + ' verified</span></h3>' +
    (g.items.length ? g.items.map((i) =>
      '<div class="mi"><div class="row">' + chip(i.state) + '<span class="owner">' + (OWNER_LABEL[i.owner] || esc(i.owner)) + '</span>' +
      '<span class="title">' + esc(i.title) + '</span></div>' + itemDetail(i, s.log) + '</div>').join('')
      : '<div class="empty">No items in this category for this patient.</div>') + '</div>').join('')
    : '<div class="empty">Nothing here right now.</div>'
}
function openModal(key) {
  openKey = key
  renderModal()
  document.getElementById('modal').classList.add('open')
  document.querySelector('#modal button').focus()
}
function closeModal() {
  openKey = null
  document.getElementById('modal').classList.remove('open')
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openKey) closeModal() })

function render(s) {
  lastState = s
  document.getElementById('world').textContent = s.world
  document.getElementById('clock').textContent = s.simNow ? new Date(s.simNow).toISOString().slice(0, 16).replace('T', ' ') : '—'
  document.getElementById('status').innerHTML = s.busy
    ? '<span class="status" role="button" style="cursor:pointer" onclick="openModal(\\'activity\\')"><span class="spin"></span>' + esc(s.phase || 'Calling the simulator…') + '</span>'
    : (s.phase ? '<span class="status quiet" role="button" style="cursor:pointer" onclick="openModal(\\'activity\\')">' + esc(s.phase) + '</span>' : '')
  if (!s.patients.length) {
    document.getElementById('kpis').innerHTML = ''
    document.getElementById('board').innerHTML =
      '<div class="card"><div class="loading-hero"><span class="spin"></span>' +
      '<div class="what">' + esc(s.phase || 'Setting up the demo world…') + '</div>' +
      '<div class="why">Live calls against the NHS-SIM simulator — the ward list appears as records load.</div></div></div>'
    document.getElementById('services').innerHTML = ''
    document.getElementById('log').innerHTML = (s.log || []).slice(-10).map((l) => '<div>' + esc(l) + '</div>').join('')
    return
  }
  const all = s.patients.flatMap((p) => p.items)
  const ready = s.patients.filter((p) => p.items.length && p.items.every((i) => i.state === 'verified')).length
  const open = all.filter((i) => OPEN.includes(i.state)).length
  const human = all.filter((i) => i.state === 'clinical_hold' || i.state === 'blocked_human').length
  if (history[history.length - 1] !== open) history.push(open)
  if (history.length > 60) history.shift()
  document.getElementById('kpis').innerHTML =
    kpi('ward', 'On the ward', s.patients.length, 'tracked patients') +
    kpi('ready', 'Ready to discharge', ready, 'every item verified') +
    kpi('open', 'Open barriers', open, 'agent is working these', spark()) +
    kpi('human', 'Awaiting a human', human, 'holds + external decisions')
  if (openKey) renderModal()

  const proposed = all.filter((i) => i.state === 'proposed').length
  const btn = document.getElementById('approveBtn')
  btn.style.display = proposed ? '' : 'none'
  btn.textContent = 'Approve plan (' + proposed + ')'

  if (!initialExpansionSet && s.patients.length) {
    expandedPatientId = s.patients[0].patientId
    initialExpansionSet = true
  }
  if (expandedPatientId && !s.patients.some((p) => p.patientId === expandedPatientId)) expandedPatientId = null
  document.getElementById('board').innerHTML = s.patients.map((p) => {
    const done = p.items.filter((i) => i.state === 'verified').length
    const pct = p.items.length ? Math.round((100 * done) / p.items.length) : 0
    const initials = esc(p.name).split(' ').map((w) => w[0]).slice(0, 2).join('')
    const expanded = expandedPatientId === p.patientId
    return '<section class="card patient-card' + (expanded ? ' expanded' : '') + '">' +
      '<button type="button" class="patient-head" data-patient="' + esc(p.patientId) + '" aria-expanded="' + expanded + '" ' +
      'aria-controls="patient-graph-' + esc(p.patientId) + '" onclick="togglePatient(this.dataset.patient)">' +
      '<div class="avatar">' + initials + '</div>' +
      '<div><div class="patient-name">' + esc(p.name) + '</div>' +
      '<div class="patient-meta">' + esc(p.patientId) + ' · ' + esc(p.stage ?? '?') +
      (p.location ? ' · ' + esc(p.location) : '') + ' · ' + esc((p.conditions || []).join(', ')) + '</div></div>' +
      '<div class="ready-pill"><span class="count">' + done + ' of ' + p.items.length + ' verified</span>' +
      '<span class="bar"><i style="width:' + pct + '%"></i></span><span class="chevron" aria-hidden="true">⌄</span></div></button>' +
      (expanded ? '<div id="patient-graph-' + esc(p.patientId) + '">' + graphForPatient(p) + '</div>' : '') + '</section>'
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
function itemStory(id) { openModal('item:' + id) }
async function clearHold(id) { await fetch('/clear-hold?item=' + encodeURIComponent(id), { method: 'POST' }); tick() }
async function approve() { await fetch('/approve', { method: 'POST' }); tick() }
async function escalate(id) {
  const btn = event?.target
  if (btn) { btn.textContent = 'Drafting…'; btn.disabled = true }
  await fetch('/escalate?item=' + encodeURIComponent(id), { method: 'POST' })
  tick()
}
setInterval(tick, 1500); tick()
</script></body></html>`

export function startUi(board: BoardState, port = 4600): void {
  const server = createServer((req, res) => {
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
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`port ${port} is busy (an older run?) — retrying every 2s; this run's UI will take over as soon as it frees up`)
      setTimeout(() => server.listen(port, '127.0.0.1'), 2000)
    } else throw err
  })
  server.listen(port, '127.0.0.1', () => console.log(`ward list: http://localhost:${port} (localhost only)`))
}
