/**
 * The flow screen: one page for the second laptop. Same Mercury tokens as the
 * ward-round UI, bigger type, built to be read from a metre away.
 *
 * Two journeys, one above the other, same arrivals: "With Homeward" is the
 * live simulator world (people are real records, every move a real action);
 * "Without Homeward" is the same people through the manual-working model with the
 * same number of beds. People are SVG figures that slide between stations;
 * in a ward bed each carries its discharge checklist as dots that turn green
 * as items verify. Polls /state every 1.5 s; POST /pause toggles the loop.
 */
import { createServer } from 'node:http'
import { snapshot, type FlowState } from './engine.ts'

export const FLOW_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Homeward · flow</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap" rel="stylesheet">
<style>
  :root{
    --page:#f9f9f7; --surface:#ffffff; --ink:#0b0b0b; --ink-2:#52514e; --ink-3:#898781;
    --hairline:rgba(11,11,11,0.10); --grid:#e1e0d9;
    --accent:#5266eb; --accent-soft:rgba(82,102,235,0.08);
    --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
    --radius:14px;
  }
  *{box-sizing:border-box;margin:0}
  body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--page);color:var(--ink);
       font-size:15px;line-height:1.4;-webkit-font-smoothing:antialiased;padding:22px 28px 28px}
  .top{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:10px}
  .brand .mark{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#5266eb,#7a8cf0);
               display:grid;place-items:center;color:#fff;font-weight:530;font-size:15px}
  .brand h1{font-size:20px;font-weight:480;letter-spacing:.01em}
  .brand .sub{font-size:12px;color:var(--ink-3)}
  .clock{font-size:30px;font-weight:530;letter-spacing:-.01em;font-variant-numeric:tabular-nums;margin-left:auto}
  .clock small{font-size:12px;font-weight:420;color:var(--ink-3);display:block;letter-spacing:0}
  button.ghost{font:inherit;font-size:12px;font-weight:480;color:var(--ink-2);background:var(--surface);
               border:1px solid var(--hairline);border-radius:999px;padding:7px 16px;cursor:pointer;white-space:nowrap}
  button.ghost:hover{background:#f4f4f1}


  .lane{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--radius);padding:14px 18px 12px;margin-bottom:14px}
  .top+.lane{margin-top:18px}
  .lane-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  .lane-head h2{font-size:16px;font-weight:480}
  .lane-head .tag{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;border-radius:4px;padding:2px 6px}
  .tag.live{background:rgba(12,163,12,.10);color:#0a7a0a}
  .tag.model{background:#efeeea;color:#5c5a55}
  .tag.sim{background:var(--accent-soft);color:var(--accent)}
  .lane-head .mini{margin-left:auto;font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums;display:flex;gap:14px}
  .lane-head .mini b{font-weight:530;color:var(--ink)}
  .journey{position:relative;height:250px;margin-top:10px}
  .station{position:absolute;top:0;bottom:0;border-left:1px dashed var(--grid);padding:0 6px}
  .station:first-child{border-left:0}
  .station .name{font-size:11px;font-weight:480;color:var(--ink-2);display:flex;gap:6px;align-items:baseline;white-space:nowrap}
  .station .name .n{color:var(--ink-3);font-weight:420;font-variant-numeric:tabular-nums}
  .station .name .n.hot{color:var(--critical);font-weight:530}
  .beds{position:absolute;left:6px;right:6px;top:24px;display:grid;gap:6px}
  .bed{border:1px solid var(--grid);border-radius:8px;background:#fbfbf9;position:relative}
  .bed .num{position:absolute;right:4px;bottom:2px;font-size:8px;color:var(--ink-3)}
  .bed.occ{border-color:rgba(82,102,235,.35);background:var(--accent-soft)}
  .fig{position:absolute;width:34px;height:44px;transform:translate(-50%,0);transition:left .9s cubic-bezier(.2,.7,.2,1),top .9s cubic-bezier(.2,.7,.2,1),opacity .4s;
       display:flex;flex-direction:column;align-items:center;gap:1px;cursor:default;opacity:1}
  .fig svg{width:22px;height:22px;display:block}
  .fig .ini{font-size:8.5px;font-weight:530;color:var(--ink-2);letter-spacing:.02em;line-height:1}
  .fig .dots{display:flex;gap:2px;height:5px}
  .fig .dots i{width:5px;height:5px;border-radius:50%;background:#d7d6cf;display:block}
  .fig .dots i.on{background:var(--warning)}
  .fig .dots i.ok{background:var(--good)}
  .fig .dots i.bad{background:var(--critical)}
  .fig .badge{position:absolute;top:-2px;right:1px;width:8px;height:8px;border-radius:50%;background:var(--critical);border:1.5px solid var(--surface)}
  .fig.enter{opacity:0}
  .fig.home svg path,.fig.home svg circle{fill:var(--good)}
  .fig.ward svg path,.fig.ward svg circle{fill:var(--accent)}
  .fig.ae svg path,.fig.ae svg circle{fill:#8f9bb3}
  .fig.take svg path,.fig.take svg circle{fill:var(--serious)}
  .fig.fit svg path,.fig.fit svg circle{fill:#2f49d9}
  .more{position:absolute;font-size:11px;color:var(--ink-3);white-space:nowrap}

  .speed{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--ink-3);background:var(--surface);
         border:1px solid var(--hairline);border-radius:999px;padding:4px 6px 4px 12px}
  .speed button{font:inherit;font-size:12px;font-weight:480;color:var(--ink-2);background:transparent;border:0;
                border-radius:999px;padding:4px 10px;cursor:pointer}
  .speed button:hover{background:#f4f4f1}
  .speed button.on{background:var(--accent);color:#fff}
  .speed .hint{font-size:11px;color:var(--ink-3);padding:0 6px 0 4px}
  .warn{font-size:10px;font-weight:600;letter-spacing:.03em;color:#fff;background:var(--critical);border-radius:4px;padding:2px 6px;white-space:nowrap}
</style></head><body>
<div class="top">
  <div class="brand"><div class="mark">H</div><div><h1>Homeward</h1></div></div>
  <span class="speed" id="speed" title="simulated time per step — a bigger step is faster">Step
    <button data-step="15" onclick="setSpeed(15)">15 min</button><button data-step="30" onclick="setSpeed(30)">30 min</button>
    <button data-step="60" onclick="setSpeed(60)">1 h</button><button data-step="120" onclick="setSpeed(120)">2 h</button><span class="hint">faster &rarr;</span></span>
  <span class="warn" id="warn" style="display:none">Warning: sim server timing out</span>
  <button class="ghost" id="pauseBtn" onclick="togglePause()">Pause</button>
  <div class="clock" id="clock">—<small id="clockSub">sim time since start</small></div>
</div>
<div class="lane">
  <div class="lane-head"><h2>With Homeward</h2><span class="tag live" id="modeTag">live simulator world</span>
    <span class="mini" id="miniAgent"></span></div>
  <div class="journey" id="laneAgent"></div>
</div>
<div class="lane">
  <div class="lane-head"><h2>Without Homeward</h2><span class="tag model">same arrivals, same beds</span>
    <span class="mini" id="miniModel"></span></div>
  <div class="journey" id="laneModel"></div>
</div>
</div>
<script>
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const PERSON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="6.5" r="4.2" fill="#8f9bb3"/><path d="M4 22c0-5 3.6-8.5 8-8.5s8 3.5 8 8.5z" fill="#8f9bb3"/></svg>'
// Station x-ranges as fractions of the journey width.
const STATIONS = [
  { key: 'waiting',   name: 'A&E waiting',      x0: 0,    x1: 0.15 },
  { key: 'assessing', name: 'Assessment',       x0: 0.15, x1: 0.28 },
  { key: 'take',      name: 'Waiting for a bed', x0: 0.28, x1: 0.42 },
  { key: 'ward',      name: 'Ward',             x0: 0.42, x1: 0.84 },
  { key: 'home',      name: 'Home',             x0: 0.84, x1: 1 },
]
const rel = (ms, from) => {
  const m = Math.max(0, Math.round((ms - from) / 60000))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60)
  return (d ? d + 'd ' : '') + h + 'h ' + String(m % 60).padStart(2, '0') + 'm'
}
let last = null
const built = {}
function ensureStations(lane, W) {
  if (lane.dataset.built) return
  lane.dataset.built = '1'
  for (const s of STATIONS) {
    const el = document.createElement('div')
    el.className = 'station'
    el.dataset.key = s.key
    el.style.left = (s.x0 * 100) + '%'
    el.style.width = ((s.x1 - s.x0) * 100) + '%'
    el.innerHTML = '<div class="name">' + s.name + ' <span class="n"></span></div>'
    if (s.key === 'ward') {
      const cols = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(W * 1.6))))
      const grid = document.createElement('div')
      grid.className = 'beds'
      grid.style.gridTemplateColumns = 'repeat(' + cols + ',1fr)'
      grid.style.gridAutoRows = Math.max(44, Math.floor(210 / Math.ceil(W / cols))) + 'px'
      for (let n = 1; n <= W; n++) grid.innerHTML += '<div class="bed" data-bed="' + n + '"><span class="num">' + n + '</span></div>'
      el.appendChild(grid)
    }
    lane.appendChild(el)
  }
}
// Layout one lane: returns nothing, moves figures in place.
function layoutLane(laneId, people, stageOf, bedOf, W, now, live) {
  const lane = document.getElementById(laneId)
  ensureStations(lane, W)
  const width = lane.clientWidth || 1000
  const seen = new Set()
  const byStation = {}
  for (const p of people) { const st = stageOf(p); (byStation[st] = byStation[st] || []).push(p) }
  const counts = {}
  for (const s of STATIONS) {
    const list = byStation[s.key] || []
    counts[s.key] = list.length
    const nameEl = lane.querySelector('.station[data-key="' + s.key + '"] .n')
    nameEl.textContent = list.length ? String(list.length) : ''
    nameEl.classList.toggle('hot', s.key === 'take' && list.length > 0)
    const x0 = s.x0 * width + 8, x1 = s.x1 * width - 8
    const cell = 38, rowH = 50
    const cols = Math.max(1, Math.floor((x1 - x0) / cell))
    const maxRows = 4
    const shown = s.key === 'home' ? list.slice(-cols * maxRows) : list.slice(0, cols * maxRows)
    if (s.key === 'ward') {
      const beds = lane.querySelectorAll('.bed')
      beds.forEach((b) => b.classList.remove('occ'))
    }
    shown.forEach((p, idx) => {
      const id = laneId + ':' + p.attendanceId
      seen.add(id)
      let el = built[id]
      if (!el) {
        el = document.createElement('div')
        el.className = 'fig enter'
        el.innerHTML = PERSON + '<span class="ini">' + esc(p.initials) + '</span><span class="dots"></span>'
        el.style.left = '-40px'; el.style.top = '30px'
        lane.appendChild(el)
        built[id] = el
        requestAnimationFrame(() => el.classList.remove('enter'))
      }
      let left, top
      if (s.key === 'ward') {
        const bed = lane.querySelector('.bed[data-bed="' + bedOf(p) + '"]')
        if (bed) {
          bed.classList.add('occ')
          left = bed.offsetLeft + bed.parentElement.offsetLeft + bed.offsetWidth / 2 + s.x0 * width + 6
          top = bed.parentElement.offsetTop + bed.offsetTop + Math.max(0, (bed.offsetHeight - 44) / 2)
        } else { left = x0 + 16; top = 30 }
      } else {
        left = x0 + 16 + (idx % cols) * cell
        top = 26 + Math.floor(idx / cols) * rowH
      }
      el.style.left = left.toFixed(0) + 'px'
      el.style.top = top.toFixed(0) + 'px'
      const inWard = s.key === 'ward'
      const fit = inWard && live && p.fitAt !== undefined && now >= p.fitAt
      el.className = 'fig ' + (s.key === 'home' ? 'home' : inWard ? (fit ? 'fit' : 'ward') : s.key === 'take' ? 'take' : 'ae')
      const dots = el.querySelector('.dots')
      if (inWard && live) {
        dots.innerHTML = (p.items || []).map((i) => '<i class="' + (i.state === 'verified' ? 'ok' : i.state === 'failed' ? 'bad' : (i.state === 'awaiting_verification' || i.state === 'resolving') ? 'on' : '') + '"></i>').join('')
      } else dots.innerHTML = ''
      el.querySelector('.badge')?.remove()
      if (live && p.error && s.key !== 'home') el.insertAdjacentHTML('beforeend', '<span class="badge"></span>')
      el.title = p.name + ' · ' + esc(p.complaint) + ' · acuity ' + p.acuity +
        (inWard ? (live ? (fit ? ' · medically fit, discharge checklist running' : ' · being treated, fit in ' + rel(p.fitAt, now)) : ' · in a bed (model)') : '') +
        (s.key === 'home' ? ' · home' + (p.homeFrom === 'ae' ? ' from A&E' : ' from the ward') : '') +
        (live && p.error ? ' · last action failed, retrying: ' + p.error : '') +
        (inWard && live && (p.items || []).length ? ' · ' + (p.items || []).filter((i) => i.state === 'verified').length + ' of ' + p.items.length + ' items verified' : '')
    })
    const moreId = laneId + ':more:' + s.key
    let more = built[moreId]
    if (!more) { more = document.createElement('div'); more.className = 'more'; lane.appendChild(more); built[moreId] = more }
    const hidden = list.length - shown.length
    more.textContent = hidden > 0 ? '+' + hidden + ' more' : ''
    more.style.left = (x0 + 8) + 'px'; more.style.top = (26 + maxRows * rowH) + 'px'
  }
  for (const id of Object.keys(built)) {
    if (id.startsWith(laneId + ':') && !id.includes(':more:') && !seen.has(id)) { built[id].remove(); delete built[id] }
  }
  return counts
}
function render(s) {
  last = s
  const W = s.params.wardSize
  document.getElementById('clock').innerHTML = (s.startedAt ? '+' + rel(s.simNow, s.startedAt) : '—') + '<small id="clockSub">sim time since start · tick ' + s.tick + ' · ' + s.params.stepMinutes + ' sim-min per tick</small>'
  document.getElementById('pauseBtn').textContent = s.paused ? 'Resume' : 'Pause'
  const mt = document.getElementById('modeTag')
  if (s.mode === 'offline') { mt.className = 'tag sim'; mt.textContent = 'simulated · verified simulator timings'; mt.title = 'Local stand-in for the simulator: results 120 min, visits 90, watch reading 10, letters and tasks at once' }
  else { mt.className = 'tag live'; mt.textContent = 'live simulator world' }
  // Any timed-out or failed simulator call in the recent trace, or a person whose last action failed.
  const timingOut = (s.trace || []).slice(-12).some((t) => !t.ok) || (s.patients || []).some((p) => p.error && p.flow !== 'home')
  document.getElementById('warn').style.display = timingOut ? '' : 'none'
  const c = s.counters
  const ppl = s.patients
  layoutLane('laneAgent', ppl, (p) => p.flow, (p) => p.bed, W, s.simNow, true)
  const m = s.model.people
  layoutLane('laneModel', ppl, (p) => (m[p.attendanceId] || { stage: p.flow }).stage, (p) => (m[p.attendanceId] || {}).bed, W, s.simNow, false)
  document.getElementById('miniAgent').innerHTML = '<span>beds <b>' + c.occupied + '/' + W + '</b></span><span>waiting for a bed <b>' + c.waitingForBed + '</b></span><span>home <b>' + c.home + '</b></span>'
  document.querySelectorAll('#speed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.step) === s.params.stepMinutes))
  document.getElementById('miniModel').innerHTML = '<span>beds <b>' + c.modelOccupied + '/' + W + '</b></span><span>waiting for a bed <b>' + c.modelWaitingForBed + '</b></span><span>home <b>' + c.modelHome + '</b></span>'
}
async function tick() { try { render(await (await fetch('/state')).json()) } catch {} }
async function togglePause() { await fetch('/pause', { method: 'POST' }); tick() }
async function setSpeed(step) { await fetch('/speed?step=' + step, { method: 'POST' }); tick() }
window.addEventListener('resize', () => { if (last) render(last) })
setInterval(tick, 1500); tick()
</script></body></html>`

export function startFlowUi(state: FlowState, opts: { port?: number; replay?: boolean } = {}): void {
  const port = opts.port ?? 4700
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/state') {
      res.setHeader('content-type', 'application/json')
      try { res.end(JSON.stringify(snapshot(state))) } catch (err) { res.statusCode = 500; res.end(JSON.stringify({ error: String((err as Error).message) })) }
    } else if (url.pathname === '/speed' && req.method === 'POST') {
      const step = Number(url.searchParams.get('step'))
      if (step >= 5 && step <= 720) state.params.stepMinutes = step // takes effect next tick
      res.end(String(state.params.stepMinutes))
    } else if (url.pathname === '/pause' && req.method === 'POST') {
      if (!opts.replay) state.paused = !state.paused
      res.end(state.paused ? 'paused' : 'running')
    } else {
      res.setHeader('content-type', 'text/html')
      res.end(FLOW_PAGE)
    }
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`port ${port} is busy (an older run?) — retrying every 2s`)
      setTimeout(() => server.listen(port, '127.0.0.1'), 2000)
    } else throw err
  })
  server.listen(port, '127.0.0.1', () => console.log(`flow screen: http://localhost:${port} (localhost only)`))
}
