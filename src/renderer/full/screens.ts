/**
 * The docked screens: system map, route, hold, tech, ship, codex, settings.
 *
 * Presentation only. Every mutation goes out as a named command and comes back
 * as a fresh catalog — the renderer holds no authoritative state, which is what
 * keeps the widget and the full view from ever disagreeing.
 */
import { formatDuration, formatNumber } from '../../sim/numbers.js';
import type { FullSnapshot } from '../../sim/snapshot.js';
import { api } from './api.js';

export type ScreenId = 'map' | 'route' | 'hold' | 'tech' | 'ship' | 'codex' | 'settings';

interface Ctx {
  snap: FullSnapshot;
  catalog: Record<string, any>;
  content: Record<string, any>;
  refresh: () => void;
  notify: (text: string) => void;
}

const esc = (s: string): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const fmt = (n: number, notation: string): string =>
  formatNumber(n, { mode: notation === 'scientific' ? 'scientific' : 'short' });

export function renderScreen(id: ScreenId, root: HTMLElement, ctx: Ctx): void {
  root.innerHTML = SCREENS[id](ctx);
  wire(root, ctx);
}

const SCREENS: Record<ScreenId, (ctx: Ctx) => string> = {
  map: (ctx) => {
    const zones = ctx.content.zones as any[];
    const planets = ctx.content.planets as any[];
    const progress = ctx.snap.route;
    const cards = planets
      .map((planet) => {
        const owned = zones.filter((z) => z.planetId === planet.id);
        const rows = owned
          .map((z) => {
            const p = (ctx.catalog.zoneProgress ?? {})[z.id] ?? {};
            const discovered = p.discovered ?? false;
            const cleared = p.cleared ?? false;
            return `
              <div class="card ${discovered ? '' : 'locked'} ${cleared ? 'done' : ''}">
                <div class="row">
                  <span class="title">${esc(z.name)}</span>
                  <span class="pill" style="color:${z.accent}">T${z.tier} · ${z.kind}</span>
                </div>
                <div class="meta">${esc(z.subtitle)} — ${esc(z.flavor)}</div>
                <div class="meta">Gate: ${z.gate.kills} kills · ${z.gate.deposits} deposits · ${z.gate.scans} scans</div>
                <div class="row">
                  <span class="label">${cleared ? 'Cleared' : discovered ? 'Uncleared' : 'Uncharted'}</span>
                  <span style="display:flex;gap:6px">
                    <button data-cmd="land" data-zone="${z.id}" ${discovered ? '' : 'disabled'}>Land</button>
                    <button data-cmd="assign-route" data-zone="${z.id}" ${cleared ? '' : 'disabled'}
                      class="${progress.routeZone === z.id ? 'active' : ''}">Route</button>
                  </span>
                </div>
              </div>`;
          })
          .join('');
        return `
          <h2 style="margin-top:26px">${esc(planet.name)} <span style="color:var(--dust)">— ${esc(planet.epithet)}</span></h2>
          <p class="blurb">${esc(planet.flavor)}</p>
          <div class="grid cols2">${rows}</div>`;
      })
      .join('');
    return `<h2>System</h2><p class="blurb">Travel is a map node and a short transition. The budget goes into what is at the other end.</p>${cards}`;
  },

  route: (ctx) => {
    const r = ctx.snap.route;
    const assigned = r.routeZone !== null;
    return `
      <h2>Route</h2>
      <p class="blurb">
        The ship runs a cleared zone on its own, whether you are aboard, on the ground, or away entirely.
        Materials scale with time. Data does not — that is the lever that keeps active sessions worth showing up for.
        New bosses never auto-clear.
      </p>
      <div class="grid cols2">
        <div class="card">
          <div class="row"><span class="title">${esc(r.routeZoneName)}</span>
            <span class="pill" style="color:${r.accent}">${assigned ? 'Running' : 'Idle'}</span></div>
          <div class="bar"><i style="width:${(r.cycleProgress * 100).toFixed(1)}%;background:${r.accent}"></i></div>
          <div class="meta">${r.cycles} cycles completed</div>
          <div class="row"><span class="label">Materials</span><span>${fmt(r.materialsPerHour, ctx.snap.notation)}/h</span></div>
          <div class="row"><span class="label">Data</span><span>${fmt(r.dataPerHour, ctx.snap.notation)}/h</span></div>
          <div class="row"><span class="label">Hold</span><span>${r.holdUsed}/${r.holdMax}</span></div>
          ${assigned ? '<button data-cmd="clear-route">Recall the ship</button>' : '<div class="meta">Clear a zone by hand to unlock it as a route.</div>'}
        </div>
        <div class="card">
          <div class="title">Idle rules</div>
          <div class="meta">
            Idle loot is capped at Refined. Marked and better need hands on the sticks.<br />
            A full hold never stalls a route — overflow is scrapped into materials and the widget says so.<br />
            Offline accrual is capped at ${ctx.catalog.offlineCapHours ?? 48} hours, raised by tech.
          </div>
          <div class="row"><span class="label">Last offline</span><span>${
            ctx.catalog.lastOffline
              ? `${formatDuration(ctx.catalog.lastOffline.elapsedMs)} · ${ctx.catalog.lastOffline.cycles} cycles`
              : '—'
          }</span></div>
          <button data-cmd="parity-check">Verify offline maths</button>
          <div class="meta" id="parity-out"></div>
        </div>
      </div>`;
  },

  hold: (ctx) => {
    const items = (ctx.catalog.inventory ?? []) as any[];
    const rarities = ctx.content.rarities as Record<string, any>;
    const rows = items
      .slice()
      .sort((a, b) => b.power - a.power)
      .map(
        (i) => `
        <tr class="${i.equipped >= 0 ? 'equipped' : ''}">
          <td>
            <span style="color:${rarities[i.rarity]?.color ?? '#fff'}">${esc(i.name)}</span>
            ${i.signature ? '<span class="pill" style="color:var(--accent);margin-left:6px">Signature</span>' : ''}
            ${i.locked ? '<span class="pill" style="margin-left:6px">Locked</span>' : ''}
            <div class="meta">${i.affixes.map((a: any) => esc(a.label)).join(' · ') || '—'}</div>
          </td>
          <td>${esc(ctx.content.damageLabels[i.damageType] ?? i.damageType)}</td>
          <td class="num">${i.ilvl}</td>
          <td class="num">${fmt(i.dps, ctx.snap.notation)}</td>
          <td class="num">
            <button data-cmd="equip" data-uid="${i.uid}">${i.equipped >= 0 ? `Slot ${i.equipped + 1}` : 'Equip'}</button>
            <button data-cmd="toggle-lock" data-uid="${i.uid}">${i.locked ? 'Unlock' : 'Lock'}</button>
            <button data-cmd="breakdown" data-uid="${i.uid}" ${i.locked || i.equipped >= 0 ? 'disabled' : ''}>Scrap ${i.breakdown}</button>
          </td>
        </tr>`,
      )
      .join('');
    return `
      <h2>Hold</h2>
      <p class="blurb">${items.length} of ${ctx.snap.hold.max} slots. Equipping puts a weapon in the active slot; 1/2/3 swaps between them on the ground.</p>
      <table><thead><tr><th>Item</th><th>Type</th><th class="num">ilvl</th><th class="num">DPS</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="meta">Empty.</td></tr>'}</tbody></table>`;
  },

  tech: (ctx) => {
    const nodes = (ctx.catalog.tech ?? []) as any[];
    const cards = nodes
      .map(
        (n) => `
        <div class="card ${n.unlocked ? 'done' : n.available ? '' : 'locked'}">
          <div class="row"><span class="title">${esc(n.name)}</span><span class="pill">${n.cost} data</span></div>
          <div class="meta">${esc(n.description)}</div>
          ${n.requires.length ? `<div class="meta">Requires: ${n.requires.map(esc).join(', ')}</div>` : ''}
          <button data-cmd="buy-tech" data-id="${n.id}" ${n.unlocked || !n.available || !n.affordable ? 'disabled' : ''}>
            ${n.unlocked ? 'Translated' : 'Translate'}
          </button>
        </div>`,
      )
      .join('');
    return `<h2>Tech</h2><p class="blurb">Funded entirely by data, which idle routes barely produce. Everything here is a reason to fly the mission yourself.</p><div class="grid cols3">${cards}</div>`;
  },

  ship: (ctx) => {
    const ups = (ctx.catalog.upgrades ?? []) as any[];
    const p = ctx.catalog.prestige ?? {};
    const materials = ctx.content.materials as Record<string, string>;
    const cards = ups
      .map(
        (u) => `
        <div class="card">
          <div class="row"><span class="title">${esc(u.name)}</span><span class="pill">${u.rank}/${u.maxRank}</span></div>
          <div class="meta">${esc(u.description)}</div>
          <div class="meta">${
            u.cost.length ? u.cost.map((c: any) => `${c.amount} ${materials[c.tier]}`).join(' · ') : 'Maximum rank'
          }</div>
          <button data-cmd="buy-upgrade" data-id="${u.id}" ${u.rank >= u.maxRank || !u.affordable ? 'disabled' : ''}>Install</button>
        </div>`,
      )
      .join('');
    return `
      <h2>Ship</h2>
      <p class="blurb">The materials sink. Late ranks still want tier-1 Slag, so the first zone never stops being worth a route.</p>
      <div class="grid cols3">${cards}</div>
      <h2 style="margin-top:34px">Reset</h2>
      <p class="blurb">
        One prestige axis. Resetting keeps a permanent multiplier and a marker, and costs you everything else.
        It should be a decision you weigh, not a lap you run — so it unlocks late and pays out on depth, not on time served.
      </p>
      <div class="grid cols2">
        <div class="card">
          <div class="row"><span class="title">Current</span><span class="pill">${(p.multiplier ?? 1).toFixed(2)}x</span></div>
          <div class="meta">Resets: ${p.count ?? 0}${p.marker ? ` · Marker: ${esc(p.marker)}` : ''}</div>
          <div class="meta">Requires character level ${p.requirement ?? 25}. You are ${ctx.snap.level}.</div>
        </div>
        <div class="card">
          <div class="row"><span class="title">If you reset now</span><span class="pill" style="color:var(--accent)">+${(p.gain ?? 0).toFixed(2)}</span></div>
          <div class="meta">Keeps: codex, settings, lifetime statistics, the multiplier. Loses: level, gear, hold, tech, ship ranks, zone clears.</div>
          <button class="primary" data-cmd="prestige" ${p.available ? '' : 'disabled'}>Reset</button>
        </div>
      </div>`;
  },

  codex: (ctx) => {
    const known = new Set((ctx.catalog.codex ?? []) as string[]);
    const bosses = ctx.content.bosses as any[];
    const cards = bosses
      .map((b) => {
        const has = known.has(`codex-${b.id}`);
        return `
          <div class="card ${has ? 'done' : 'locked'}">
            <div class="title">${has ? esc(b.name) : 'Unrecorded'}</div>
            <div class="meta">${has ? esc(b.epithet) : 'Kill it and the ship writes the entry.'}</div>
            ${
              has
                ? b.phases
                    .map((ph: any, i: number) => `<div class="meta"><b>Phase ${i + 1} — ${esc(ph.name)}.</b> ${esc(ph.briefing)}</div>`)
                    .join('')
                : ''
            }
          </div>`;
      })
      .join('');
    const s = ctx.catalog.stats ?? {};
    return `
      <h2>Codex</h2>
      <p class="blurb">Boss entries are data. They are also the only place the game explains a fight in words.</p>
      <div class="grid cols2">${cards}</div>
      <h2 style="margin-top:34px">Log</h2>
      <div class="grid cols3">
        ${statCard('Kills', s.kills)}${statCard('Bosses down', s.bossKills)}${statCard('Boss attempts', s.bossAttempts)}
        ${statCard('Downed', s.deaths)}${statCard('Shots fired', s.shotsFired)}${statCard('Weak-point hits', s.weakPointHits)}
        ${statCard('Items found', s.itemsDropped)}${statCard('Items scrapped', s.itemsBrokenDown)}
        ${statCard('Active : idle', `${ratio(s.activeTicks, s.idleTicks)}`)}
      </div>`;
  },

  settings: (ctx) => {
    const s = ctx.catalog.settings ?? {};
    return `
      <h2>Settings</h2>
      <p class="blurb">No energy timers, no dailies, no dark patterns. The only knobs here are about comfort.</p>
      <div class="grid cols2">
        <div class="card">
          <div class="title">Widget</div>
          <label class="meta">Corner
            <select data-set="widgetCorner">
              ${['tl', 'tr', 'bl', 'br'].map((c) => `<option value="${c}" ${s.widgetCorner === c ? 'selected' : ''}>${c.toUpperCase()}</option>`).join('')}
            </select>
          </label>
          <label class="meta">Opacity <input type="range" min="0.3" max="1" step="0.02" value="${s.widgetOpacity}" data-set="widgetOpacity" /></label>
          <label class="meta">Frame rate <input type="range" min="0" max="15" step="1" value="${s.widgetFps}" data-set="widgetFps" /> <span>${s.widgetFps === 0 ? 'state only' : `${s.widgetFps} fps`}</span></label>
          <label class="meta"><input type="checkbox" data-set="widgetClickThrough" ${s.widgetClickThrough ? 'checked' : ''} /> Click-through</label>
          <label class="meta"><input type="checkbox" data-set="alertChimes" ${s.alertChimes ? 'checked' : ''} /> Alert chimes (off by default)</label>
        </div>
        <div class="card">
          <div class="title">Audio</div>
          <label class="meta"><input type="checkbox" data-set="audioEnabled" ${s.audioEnabled !== false ? 'checked' : ''} /> Sound</label>
          <label class="meta">Volume <input type="range" min="0" max="1" step="0.05" value="${s.masterVolume ?? 0.8}" data-set="masterVolume" /></label>
          <div class="meta">
            Everything is synthesised at runtime — no sample files, for the same reason there are no art assets.
            Sparse and low, drone-forward. The corner widget stays silent unless you opt into alert chimes.
          </div>
        </div>
        <div class="card">
          <div class="title">Display</div>
          <label class="meta">Notation
            <select data-set="notation">
              <option value="short" ${s.notation === 'short' ? 'selected' : ''}>Short (K / M / B / aa)</option>
              <option value="scientific" ${s.notation === 'scientific' ? 'selected' : ''}>Scientific</option>
            </select>
          </label>
          <label class="meta"><input type="checkbox" data-set="telemetryOptIn" ${s.telemetryOptIn ? 'checked' : ''} /> Share anonymous telemetry (opt-in)</label>
          <div class="meta">Session length, boss attempt and clear rates, idle-to-active ratio, drop-off points. Nothing else, and nothing at all unless this is ticked.</div>
          <button data-cmd="save">Save now</button>
        </div>
      </div>`;
  },
};

function statCard(label: string, value: unknown): string {
  return `<div class="card"><div class="label">${label}</div><div class="title">${value ?? 0}</div></div>`;
}

function ratio(a = 0, b = 0): string {
  const total = a + b;
  if (total === 0) return '—';
  return `${Math.round((a / total) * 100)}% / ${Math.round((b / total) * 100)}%`;
}

function wire(root: HTMLElement, ctx: Ctx): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cmd = btn.dataset.cmd!;
      if (cmd === 'save') {
        await api.save();
        ctx.notify('Saved.');
        return;
      }
      const payload: Record<string, unknown> = {};
      if (btn.dataset.zone) payload.zoneId = btn.dataset.zone;
      if (btn.dataset.uid) payload.uid = Number(btn.dataset.uid);
      if (btn.dataset.id) payload.id = btn.dataset.id;
      const result = await api.command(cmd, payload);
      if (cmd === 'parity-check') {
        const out = root.querySelector('#parity-out');
        if (out) out.textContent = result.message;
      }
      if (result.message) ctx.notify(result.message);
      ctx.refresh();
    });
  });

  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-set]').forEach((el) => {
    const apply = async () => {
      const key = el.dataset.set!;
      let value: unknown;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') value = el.checked;
      else if (el instanceof HTMLInputElement && el.type === 'range') value = Number(el.value);
      else value = el.value;
      await api.command('update-settings', { settings: { [key]: value } });
      ctx.refresh();
    };
    el.addEventListener('change', apply);
  });
}
