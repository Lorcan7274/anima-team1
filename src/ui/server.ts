/**
 * Minimal ward-list UI: one page, polls /state every 2s, renders red/amber/
 * green rows. The "Confirm" button on a clinical hold is the human sign-off
 * beat. No dependencies — Node http + inline HTML.
 *
 * TODO(team): make it pretty. Structure and data flow are the point here.
 */
import { createServer } from 'node:http'
import type { BoardState } from '../orchestrator/model.ts'
import { clearHold } from '../orchestrator/run.ts'

const COLORS: Record<string, string> = {
  detected: '#c0392b',
  resolving: '#e67e22',
  awaiting_verification: '#e67e22',
  verified: '#27ae60',
  clinical_hold: '#8e44ad',
  blocked_human: '#2c3e50',
  failed: '#c0392b',
}

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>Discharge desk</title>
<style>
  body{font-family:system-ui,sans-serif;margin:2rem;background:#f7f7f5}
  h1{font-size:1.3rem} .patient{background:#fff;border-radius:8px;padding:1rem;margin:1rem 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .item{display:flex;gap:.6rem;align-items:baseline;padding:.35rem 0;border-top:1px solid #eee}
  .dot{width:.7rem;height:.7rem;border-radius:50%;flex:none;position:relative;top:.08rem}
  .owner{color:#888;font-size:.8rem;min-width:6.5rem} .evidence{color:#666;font-size:.8rem;font-style:italic}
  .state{font-size:.75rem;color:#555;margin-left:auto;white-space:nowrap}
  button{border:1px solid #8e44ad;background:#fff;color:#8e44ad;border-radius:4px;cursor:pointer}
  #log{font-family:ui-monospace,monospace;font-size:.75rem;color:#555;white-space:pre-wrap;background:#fff;padding:1rem;border-radius:8px}
</style>
<h1>Neighbourhood discharge desk — <span id="world"></span> <small id="clock"></small></h1>
<div id="board"></div>
<h2 style="font-size:1rem">Audit log</h2><div id="log"></div>
<script>
const COLORS = ${JSON.stringify(COLORS)}
async function tick(){
  const s = await (await fetch('/state')).json()
  document.getElementById('world').textContent = s.world
  document.getElementById('clock').textContent = new Date(s.simNow).toISOString().slice(0,16).replace('T',' ') + ' (sim)'
  document.getElementById('board').innerHTML = s.patients.map(p => \`
    <div class="patient"><strong>\${p.name}</strong> · \${p.patientId} · \${p.stage ?? '?'} \${p.location ? '· ' + p.location : ''}
      <span style="color:#888">· \${(p.conditions||[]).join(', ')}</span>
      \${p.items.map(i => \`<div class="item">
        <span class="dot" style="background:\${COLORS[i.state]}"></span>
        <span class="owner">\${i.owner}</span> <span>\${i.title}</span>
        \${(i.evidence||[])[0] ? '<span class="evidence">“' + i.evidence[0].quote + '”</span>' : ''}
        <span class="state">\${i.state}\${i.error ? ' — ' + i.error : ''}
          \${i.state === 'clinical_hold' ? '<button onclick="clearHold(\\'' + i.id + '\\')">Confirm reviewed</button>' : ''}
        </span></div>\`).join('')}
    </div>\`).join('')
  document.getElementById('log').textContent = (s.log || []).slice(-25).join('\\n')
}
async function clearHold(id){ await fetch('/clear-hold?item=' + id, {method:'POST'}); tick() }
setInterval(tick, 2000); tick()
</script>`

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
