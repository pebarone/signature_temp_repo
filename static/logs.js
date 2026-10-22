// logs.js
// Visualizador do log de auditoria do dia: consome /logs/stream (SSE, uma linha do arquivo por mensagem).
(() => {
  'use strict';

  const MAX_ROWS = 2000;       // linhas no DOM (as mais recentes que passam nos filtros)
  const MAX_ENTRIES = 20000;   // eventos mantidos em memória
  const BUCKETS = 60;          // minutos no gráfico de volume
  const NEAR_BOTTOM_PX = 40;

  // [2026-10-22T14:32:10.123Z] INFO: mensagem (aceita também os formatos antigos "| LEVEL |" e "LEVEL mensagem")
  const LINE_RE = /^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?(?: UTC)?\]?\s*(?:\|\s*)?(INFO|WARN|WARNING|ERROR|DEBUG|EVENT|VERBOSE|HTTP|SILLY)\b\s*[:|]?\s?(.*)$/i;
  const ATTR_RE = /^\s*→\s*([^:]{1,40}):\s?(.*)$/;          // "  → Event: ..." (linhas filhas)
  const AGREEMENT_RE = /\bCBJCHBCA[A-Za-z0-9_-]{16,}/g;     // ID de acordo do Adobe Sign (todas as ocorrências)
  const AGREEMENT_ONE = /\bCBJCHBCA[A-Za-z0-9_-]{16,}/;
  const PREFIX_ID_RE = /^\[([A-Za-z0-9_-]{16,})\]\s*/;      // "[<id>] ..." do pipeline de reconciliação

  const LEVEL_LABEL = { INFO: 'Info', WARN: 'Aviso', ERROR: 'Erro', DEBUG: 'Debug' };
  const SOURCE_RULES = [
    [/^\[poll\]/i, 'poller'],
    [/^\[(START|AUTH)/i, 'start'],
    [/^\[STORAGE\]/i, 'storage'],
    [/^webhook/i, 'webhook'],
    [/^(Signature request|Signature requested|Falha na etapa start)/i, 'start'],
    [/oauth|^token saved/i, 'oauth'],
    [/^(Bad request on|Unhandled error on)/i, 'http'],
    [PREFIX_ID_RE, 'reconciliação']
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    conn: $('connPill'), connText: $('connText'), alert: $('connAlert'), retry: $('retryBtn'),
    fileName: $('fileName'), theme: $('themeBtn'),
    statTotal: $('statTotal'), statRate: $('statRate'), statErrors: $('statErrors'), statErrorsPct: $('statErrorsPct'),
    statWarns: $('statWarns'), statWarnsPct: $('statWarnsPct'), statLast: $('statLast'), statLastAt: $('statLastAt'),
    chart: $('volumeChart'), tip: $('chartTip'),
    search: $('searchInput'), tabs: $('levelTabs'), source: $('sourceFilter'),
    wrap: $('wrapBtn'), follow: $('followBtn'), pause: $('pauseBtn'), pauseText: $('pauseText'), clear: $('clearBtn'),
    viewport: $('viewport'), rows: $('rows'), emptyWaiting: $('emptyWaiting'), emptyFiltered: $('emptyFiltered'),
    resetFilters: $('resetFiltersBtn'), jump: $('jumpBtn'), jumpText: $('jumpText'), info: $('resultInfo'),
    sheet: $('sheet'), sheetMeta: $('sheetMeta'), sheetTitle: $('sheetTitle'), sheetBody: $('sheetBody'),
    prev: $('prevBtn'), next: $('nextBtn'), copyRaw: $('copyRawBtn')
  };

  const state = {
    entries: [],
    byId: new Map(),
    nextId: 1,
    rawLines: [],        // linhas do arquivo atual, para descartar o replay após reconexão
    replayAt: -1,
    fileDay: '',
    queue: [],
    held: [],            // linhas recebidas durante a pausa (não se perdem)
    paused: false,
    follow: true,
    level: '',
    source: '',
    query: '',
    matchCount: 0,
    unseen: 0,
    selectedId: null,
    counts: { total: 0, INFO: 0, WARN: 0, ERROR: 0 },
    minutes: new Map(),  // minuto (epoch/60000) -> { INFO, WARN, ERROR }
    sources: new Map(),  // origem -> quantidade
    everOpened: false,
    conn: 'connecting'
  };
  const rowEls = new Map();
  let es = null;
  let frame = 0;

  // ---------- Utilidades ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtInt = (n) => n.toLocaleString('pt-BR');
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const levelGroup = (lvl) => (lvl === 'ERROR' || lvl === 'WARN' ? lvl : 'INFO');
  // Os IDs do Adobe compartilham o prefixo "CBJCHBCAABAA": o final é o que distingue um acordo do outro
  const shortId = (id) => (id.length > 22 ? `${id.slice(0, 4)}…${id.slice(-10)}` : id);

  function normLevel(l) {
    const u = l.toUpperCase();
    if (u === 'WARNING') return 'WARN';
    if (u === 'EVENT') return 'INFO';
    if (u === 'VERBOSE' || u === 'HTTP' || u === 'SILLY') return 'DEBUG';
    return u;
  }

  function sourceOf(message) {
    for (const [re, name] of SOURCE_RULES) if (re.test(message)) return name;
    return 'sistema';
  }

  function timeUtc(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
  }

  function relative(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 5) return 'agora';
    if (s < 60) return `há ${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60);
    return h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} d`;
  }

  // Destaca a busca sobre texto já escapado
  function hl(text) {
    const q = state.query;
    if (!q) return esc(text);
    const lower = text.toLowerCase();
    let out = '';
    let i = 0;
    let j;
    while ((j = lower.indexOf(q, i)) !== -1) {
      out += `${esc(text.slice(i, j))}<mark>${esc(text.slice(j, j + q.length))}</mark>`;
      i = j + q.length;
    }
    return out + esc(text.slice(i));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* sem clipboard */ }
      ta.remove();
      return ok;
    }
  }

  // ---------- Parsing ----------
  function makeEntry(line, m) {
    const ts = m ? Date.parse(`${m[1]}Z`) : NaN;
    const level = m ? normLevel(m[2]) : 'INFO';
    let message = m ? m[3] : line.trim();
    let agreement = null;
    let prefixed = false;
    const p = PREFIX_ID_RE.exec(message);
    if (p && p[1].length >= 20) {
      agreement = p[1];
      prefixed = true;
      message = message.slice(p[0].length);
    }
    const source = sourceOf(m ? m[3] : message);
    if (!agreement) agreement = (AGREEMENT_ONE.exec(message) || [null])[0];
    return { id: state.nextId++, ts, level, source, message, agreement, prefixed, attrs: [], extra: [], raw: [line], search: null };
  }

  // Devolve { entry, isNew }
  function ingest(line) {
    const m = LINE_RE.exec(line);
    const last = state.entries[state.entries.length - 1];
    if (!m && last) {
      const a = ATTR_RE.exec(line);
      if (a) last.attrs.push({ key: a[1].trim(), value: a[2].trim() });
      else last.extra.push(line.replace(/^\s*→\s?/, '').replace(/\s+$/, ''));
      last.raw.push(line);
      last.search = null;
      if (!last.agreement) last.agreement = (AGREEMENT_ONE.exec(line) || [null])[0];
      return { entry: last, isNew: false };
    }
    const entry = makeEntry(line, m);
    state.entries.push(entry);
    state.byId.set(entry.id, entry);
    count(entry, +1);
    return { entry, isNew: true };
  }

  function count(entry, sign) {
    const g = levelGroup(entry.level);
    state.counts.total += sign;
    state.counts[g] += sign;
    state.sources.set(entry.source, (state.sources.get(entry.source) || 0) + sign);
    if (Number.isFinite(entry.ts)) {
      const k = Math.floor(entry.ts / 60000);
      const b = state.minutes.get(k) || { INFO: 0, WARN: 0, ERROR: 0 };
      b[g] += sign;
      state.minutes.set(k, b);
    }
  }

  function trimEntries() {
    const extra = state.entries.length - MAX_ENTRIES;
    if (extra <= 0) return;
    for (const e of state.entries.splice(0, extra)) {
      count(e, -1);
      state.byId.delete(e.id);
      if (rowEls.has(e.id)) { rowEls.get(e.id).remove(); rowEls.delete(e.id); }
      if (matches(e)) state.matchCount--;
    }
  }

  // ---------- Filtros ----------
  function matches(e) {
    if (state.level && levelGroup(e.level) !== state.level) return false;
    if (state.source && e.source !== state.source) return false;
    if (state.query) {
      if (e.search === null) e.search = e.raw.join('\n').toLowerCase();
      if (!e.search.includes(state.query)) return false;
    }
    return true;
  }

  const hasFilters = () => Boolean(state.level || state.source || state.query);

  // ---------- Renderização das linhas ----------
  function idChip(id, inline = false) {
    const cls = `id-chip${inline ? ' is-inline' : ''}${state.query && id.toLowerCase().includes(state.query) ? ' is-match' : ''}`;
    return `<button type="button" class="${cls}" data-q="${esc(id)}" title="Filtrar por ${esc(id)}">${esc(shortId(id))}</button>`;
  }

  function messageHtml(e) {
    let html = e.prefixed ? idChip(e.agreement) : '';
    // IDs de acordo no meio da mensagem viram chips clicáveis
    let i = 0;
    AGREEMENT_RE.lastIndex = 0;
    let m;
    let body = '';
    while ((m = AGREEMENT_RE.exec(e.message))) {
      body += `<span class="msg-text">${hl(e.message.slice(i, m.index))}</span>${idChip(m[0], true)}`;
      i = m.index + m[0].length;
    }
    body += `<span class="msg-text">${hl(e.message.slice(i))}</span>`;
    html += body;
    for (const a of e.attrs) {
      const v = AGREEMENT_ONE.test(a.value) ? esc(shortId(a.value)) : hl(a.value);
      html +=`<span class="kv-chip"><span class="k">${hl(a.key)}</span><span class="v">${v}</span></span>`;
    }
    if (e.extra.length) html += `<span class="more-chip">+${e.extra.length} ${e.extra.length === 1 ? 'linha' : 'linhas'}</span>`;
    return html;
  }

  function rowHtml(e) {
    const lvl = LEVEL_LABEL[e.level] || e.level;
    const badge = e.level === 'INFO' ? 'badge' : `badge badge-${e.level.toLowerCase()}`;
    return `<span class="c-time" title="${Number.isFinite(e.ts) ? new Date(e.ts).toISOString() : ''}">${timeUtc(e.ts)}</span>`
      + `<span class="c-level"><span class="${badge}"><span class="dot"></span>${esc(lvl)}</span></span>`
      + `<span class="c-source">${esc(e.source)}</span>`
      + `<span class="c-msg">${messageHtml(e)}</span>`;
  }

  function buildRow(e, animate) {
    const el = document.createElement('div');
    el.className = `row lvl-${e.level}${animate ? ' is-new' : ''}${e.id === state.selectedId ? ' is-selected' : ''}`;
    el.dataset.id = e.id;
    el.innerHTML = rowHtml(e);
    rowEls.set(e.id, el);
    return el;
  }

  function trimDom() {
    while (els.rows.childElementCount > MAX_ROWS) {
      const first = els.rows.firstElementChild;
      rowEls.delete(Number(first.dataset.id));
      first.remove();
    }
  }

  function renderAll() {
    els.rows.textContent = '';
    rowEls.clear();
    const matched = state.entries.filter(matches);
    state.matchCount = matched.length;
    const frag = document.createDocumentFragment();
    for (const e of matched.slice(-MAX_ROWS)) frag.appendChild(buildRow(e, false));
    els.rows.appendChild(frag);
    state.unseen = 0;
    if (state.follow) scrollToEnd();
    updateChrome();
  }

  function appendRows(list) {
    if (!list.length) return;
    const frag = document.createDocumentFragment();
    const animate = list.length < 50;   // a carga inicial do arquivo chega de uma vez, sem animação
    for (const e of list) frag.appendChild(buildRow(e, animate));
    els.rows.appendChild(frag);
    trimDom();
    if (!state.follow) state.unseen += list.length;
    else if (!holdScroll()) scrollToEnd();
  }

  // Com o ponteiro sobre a lista (ou o painel aberto) a rolagem fica parada, para a linha não fugir do clique
  let hovering = false;
  const holdScroll = () => hovering || !els.sheet.hidden;

  // Linha filha chegou depois da raiz: atualiza a linha (ou a inclui/remove se o filtro mudou de resultado)
  function refreshRow(e) {
    const el = rowEls.get(e.id);
    const ok = matches(e);
    if (el && ok) { el.innerHTML = rowHtml(e); return; }
    if (el && !ok) { el.remove(); rowEls.delete(e.id); state.matchCount--; return; }
    if (!el && ok && e === state.entries[state.entries.length - 1]) { state.matchCount++; appendRows([e]); }
  }

  // ---------- Fluxo de dados ----------
  function receive(line) {
    if (state.replayAt >= 0) {
      // Após reconectar, o servidor reenvia o arquivo do dia desde o início: descarta o prefixo já visto
      if (state.replayAt < state.rawLines.length && state.rawLines[state.replayAt] === line) { state.replayAt++; return; }
      if (state.replayAt < state.rawLines.length) state.rawLines.length = state.replayAt;
      state.replayAt = -1;
    }
    trackFile(line);
    state.rawLines.push(line);
    if (state.paused) { state.held.push(line); setConn(state.conn); return; }
    state.queue.push(line);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  // O arquivo de auditoria vira à meia-noite UTC; a data da linha indica o arquivo de origem
  function trackFile(line) {
    const d = /^\[?(\d{4}-\d{2}-\d{2})T/.exec(line);
    if (!d || d[1] === state.fileDay) return;
    if (state.fileDay && d[1] > state.fileDay) state.rawLines = [];
    if (!state.fileDay || d[1] > state.fileDay) {
      state.fileDay = d[1];
      els.fileName.textContent = `audit-${d[1]}.log`;
    }
  }

  function flush() {
    frame = 0;
    const lines = state.queue;
    state.queue = [];
    const added = [];
    const addedSet = new Set();
    const updated = new Set();
    for (const line of lines) {
      const { entry, isNew } = ingest(line);
      if (isNew) { added.push(entry); addedSet.add(entry); } else if (!addedSet.has(entry)) updated.add(entry);
    }
    trimEntries();
    updated.forEach(refreshRow);
    const visible = added.filter(matches);
    state.matchCount += visible.length;
    appendRows(visible);
    updateChrome();
    drawChart();
  }

  function connect() {
    if (es) es.close();
    setConn('connecting');
    es = new EventSource('/logs/stream');
    es.onopen = () => {
      if (state.everOpened) state.replayAt = 0;
      state.everOpened = true;
      setConn('live');
    };
    es.onmessage = (ev) => receive(ev.data);
    es.onerror = () => setConn(es.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
  }

  function setConn(conn) {
    state.conn = conn;
    const shown = state.paused && conn === 'live' ? 'paused' : conn;
    const held = state.held.length;
    const text = {
      connecting: 'Conectando…',
      live: 'Ao vivo',
      reconnecting: 'Reconectando…',
      offline: 'Desconectado',
      paused: held ? `Pausado · ${fmtInt(held)} na fila` : 'Pausado'
    }[shown];
    els.conn.dataset.state = shown;
    els.connText.textContent = text;
    els.alert.hidden = conn !== 'offline';
  }

  // ---------- Scroll / acompanhamento ----------
  const nearBottom = () => els.viewport.scrollHeight - els.viewport.scrollTop - els.viewport.clientHeight < NEAR_BOTTOM_PX;

  function scrollToEnd() {
    els.viewport.scrollTop = els.viewport.scrollHeight;
  }

  function setFollow(on) {
    state.follow = on;
    els.follow.setAttribute('aria-pressed', String(on));
    if (on) { state.unseen = 0; scrollToEnd(); }
    updateJump();
  }

  function updateJump() {
    const show = !state.follow && els.rows.childElementCount > 0;
    els.jump.hidden = !show;
    if (show) els.jumpText.textContent = state.unseen ? `${fmtInt(state.unseen)} ${state.unseen === 1 ? 'novo evento' : 'novos eventos'}` : 'Ir para o fim';
  }

  // ---------- Resumo, contadores e status ----------
  function updateChrome() {
    const c = state.counts;
    els.statTotal.textContent = fmtInt(c.total);
    els.statErrors.textContent = fmtInt(c.ERROR);
    els.statWarns.textContent = fmtInt(c.WARN);
    els.statErrorsPct.textContent = c.total ? `${((c.ERROR / c.total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do total` : '—';
    els.statWarnsPct.textContent = c.total ? `${((c.WARN / c.total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do total` : '—';
    for (const span of els.tabs.querySelectorAll('[data-count]')) {
      const k = span.dataset.count;
      span.textContent = fmtInt(k ? c[k] : c.total);
    }
    updateSources();
    updateClock();

    const empty = state.entries.length === 0;
    els.emptyWaiting.hidden = !empty;
    els.emptyFiltered.hidden = empty || state.matchCount > 0;

    let info = `<strong>${fmtInt(c.total)}</strong> ${c.total === 1 ? 'evento' : 'eventos'}`;
    if (hasFilters()) info = `<strong>${fmtInt(state.matchCount)}</strong> de ${fmtInt(c.total)} eventos correspondem aos filtros`;
    if (state.matchCount > MAX_ROWS) info += ` · exibindo os ${fmtInt(MAX_ROWS)} mais recentes`;
    els.info.innerHTML = info;
    updateJump();
  }

  function updateClock() {
    const last = state.entries[state.entries.length - 1];
    if (last && Number.isFinite(last.ts)) {
      els.statLast.textContent = relative(last.ts);
      els.statLastAt.textContent = `${timeUtc(last.ts).slice(0, 8)} UTC`;
    } else {
      els.statLast.textContent = '—';
      els.statLastAt.textContent = 'sem eventos';
    }
    const now = Math.floor(Date.now() / 60000);
    let recent = 0;
    for (let k = now - 4; k <= now; k++) {
      const b = state.minutes.get(k);
      if (b) recent += b.INFO + b.WARN + b.ERROR;
    }
    els.statRate.textContent = `${(recent / 5).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} eventos/min (5 min)`;
  }

  function updateSources() {
    const names = [...state.sources.entries()].filter(([, n]) => n > 0).map(([s]) => s).sort();
    if (state.source && !names.includes(state.source)) names.push(state.source);
    const current = [...els.source.options].slice(1).map((o) => o.value);
    if (current.join('|') === names.join('|')) return;
    els.source.innerHTML = '<option value="">Todas as origens</option>'
      + names.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    els.source.value = state.source;
  }

  // ---------- Gráfico de volume (colunas empilhadas por minuto) ----------
  let chartHover = -1;
  let chartData = [];

  function niceMax(v) {
    if (v <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // Coluna com a ponta superior arredondada (4px) e a base reta
  function colPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function drawChart() {
    const W = els.chart.clientWidth;
    const H = els.chart.clientHeight || 104;
    if (!W) return;
    const padL = 28, padB = 18, padT = 6;
    const plotW = W - padL;
    const plotH = H - padB - padT;
    const nowMin = Math.floor(Date.now() / 60000);
    chartData = [];
    let peak = 0;
    for (let i = 0; i < BUCKETS; i++) {
      const k = nowMin - (BUCKETS - 1) + i;
      const b = state.minutes.get(k) || { INFO: 0, WARN: 0, ERROR: 0 };
      chartData.push({ k, ...b });
      peak = Math.max(peak, b.INFO + b.WARN + b.ERROR);
    }
    const max = niceMax(peak);
    const slot = plotW / BUCKETS;
    const barW = Math.max(2, Math.min(24, slot - 2));
    const y = (v) => padT + plotH - (v / max) * plotH;

    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
    for (const v of [0, max / 2, max]) {
      const yy = Math.round(y(v)) + 0.5;
      svg += `<line class="chart-grid" x1="${padL}" x2="${W}" y1="${yy}" y2="${yy}"/>`;
      svg += `<text class="chart-axis" x="${padL - 8}" y="${yy + 3.5}" text-anchor="end">${fmtInt(v)}</text>`;
    }
    chartData.forEach((d, i) => {
      const x0 = padL + i * slot;
      svg += `<rect class="chart-hit${i === chartHover ? ' is-hover' : ''}" data-i="${i}" x="${x0}" y="${padT}" width="${slot}" height="${plotH}" rx="3"/>`;
    });
    chartData.forEach((d, i) => {
      const x = padL + i * slot + (slot - barW) / 2;
      const segs = ['INFO', 'WARN', 'ERROR'].filter((l) => d[l] > 0);
      let base = padT + plotH;
      segs.forEach((l, si) => {
        let h = Math.max(2, (d[l] / max) * plotH);
        const gap = si < segs.length - 1 ? 2 : 0;
        const top = base - h;
        const drawH = Math.max(1, h - gap);
        svg += si === segs.length - 1
          ? `<path class="seg-${l}" d="${colPath(x, top, barW, drawH, 4)}" pointer-events="none"/>`
          : `<rect class="seg-${l}" x="${x}" y="${top + gap}" width="${barW}" height="${drawH}" pointer-events="none"/>`;
        base = top;
      });
      const minute = new Date(d.k * 60000);
      if (minute.getUTCMinutes() % 15 === 0) {
        svg += `<text class="chart-axis" x="${padL + i * slot + slot / 2}" y="${H - 4}" text-anchor="middle">${pad(minute.getUTCHours())}:${pad(minute.getUTCMinutes())}</text>`;
      }
    });
    if (!peak) svg += `<text class="chart-empty" x="${padL + plotW / 2}" y="${padT + plotH / 2}" text-anchor="middle">Sem eventos na última hora</text>`;
    svg += '</svg>';

    const tipHidden = els.tip.hidden;
    els.chart.innerHTML = svg;
    els.chart.appendChild(els.tip);
    els.tip.hidden = tipHidden;
    if (chartHover >= 0 && !tipHidden) showTip(chartHover);
  }

  function showTip(i) {
    const d = chartData[i];
    if (!d) return;
    const start = new Date(d.k * 60000);
    const label = `${pad(start.getUTCHours())}:${pad(start.getUTCMinutes())} UTC`;
    const total = d.INFO + d.WARN + d.ERROR;
    els.tip.innerHTML = `<div class="chart-tip-title">${label}</div>`
      + `<div class="chart-tip-row"><span class="swatch swatch-info"></span>Info<b>${fmtInt(d.INFO)}</b></div>`
      + `<div class="chart-tip-row"><span class="swatch swatch-warn"></span>Aviso<b>${fmtInt(d.WARN)}</b></div>`
      + `<div class="chart-tip-row"><span class="swatch swatch-error"></span>Erro<b>${fmtInt(d.ERROR)}</b></div>`
      + `<div class="chart-tip-row">Total<b>${fmtInt(total)}</b></div>`;
    els.tip.hidden = false;
    const W = els.chart.clientWidth;
    const slot = (W - 28) / BUCKETS;
    const cx = 28 + i * slot + slot / 2;
    const tw = els.tip.offsetWidth;
    els.tip.style.left = `${Math.min(Math.max(0, cx + 12), W - tw)}px`;
    if (cx + 12 + tw > W) els.tip.style.left = `${Math.max(0, cx - tw - 12)}px`;
  }

  els.chart.addEventListener('mousemove', (ev) => {
    const hit = ev.target.closest('.chart-hit');
    const i = hit ? Number(hit.dataset.i) : -1;
    if (i === chartHover) return;
    els.chart.querySelector('.chart-hit.is-hover')?.classList.remove('is-hover');
    chartHover = i;
    if (i < 0) { els.tip.hidden = true; return; }
    hit.classList.add('is-hover');
    showTip(i);
  });
  els.chart.addEventListener('mouseleave', () => {
    chartHover = -1;
    els.tip.hidden = true;
    els.chart.querySelector('.chart-hit.is-hover')?.classList.remove('is-hover');
  });
  new ResizeObserver(() => drawChart()).observe(els.chart);

  // ---------- Painel de detalhes ----------
  function kvRow(label, value, { mono = false, copy = null } = {}) {
    const btn = copy ? `<button type="button" class="copy-mini" data-copy="${esc(copy)}" title="Copiar" aria-label="Copiar"><svg class="icon"><use href="#i-copy"/></svg></button>` : '';
    return `<div><dt>${esc(label)}</dt><dd class="${mono ? 'mono' : ''}">${value}${btn}</dd></div>`;
  }

  function openDetail(id) {
    const e = state.byId.get(id);
    if (!e) return;
    rowEls.get(state.selectedId)?.classList.remove('is-selected');
    state.selectedId = id;
    rowEls.get(id)?.classList.add('is-selected');

    const lvl = LEVEL_LABEL[e.level] || e.level;
    const badge = e.level === 'INFO' ? 'badge' : `badge badge-${e.level.toLowerCase()}`;
    const iso = Number.isFinite(e.ts) ? new Date(e.ts).toISOString() : '—';
    els.sheetMeta.innerHTML = `<span class="${badge}"><span class="dot"></span>${esc(lvl)}</span><span>${esc(e.source)}</span><span aria-hidden="true">·</span><span>${Number.isFinite(e.ts) ? relative(e.ts) : ''}</span>`;
    els.sheetTitle.innerHTML = hl(e.message || '(sem mensagem)');

    let html = '<section><h3 class="section-title">Evento</h3><dl class="kv-list">';
    html += kvRow('Horário (UTC)', esc(iso.replace('T', ' ').replace('Z', '')), { mono: true });
    if (Number.isFinite(e.ts)) html += kvRow('Horário local', esc(new Date(e.ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })), { mono: true });
    html += kvRow('Nível', esc(lvl));
    html += kvRow('Origem', esc(e.source));
    if (e.agreement) html += kvRow('ID do acordo', esc(e.agreement), { mono: true, copy: e.agreement });
    html += '</dl></section>';
    if (e.attrs.length) {
      html += '<section><h3 class="section-title">Atributos</h3><dl class="kv-list">';
      for (const a of e.attrs) html += kvRow(a.key, hl(a.value), { mono: true, copy: a.value });
      html += '</dl></section>';
    }
    if (e.extra.length) html += `<section><h3 class="section-title">Linhas adicionais</h3><pre class="pre">${hl(e.extra.join('\n'))}</pre></section>`;
    html += `<section><h3 class="section-title">Linha bruta</h3><pre class="pre">${hl(e.raw.join('\n'))}</pre></section>`;
    els.sheetBody.innerHTML = html;

    const visible = visibleIds();
    const pos = visible.indexOf(id);
    els.prev.disabled = pos <= 0;
    els.next.disabled = pos === -1 || pos >= visible.length - 1;
    if (els.sheet.hidden) {
      els.sheet.hidden = false;
      els.sheet.querySelector('.sheet-panel [data-close]').focus();
    }
  }

  function closeDetail() {
    els.sheet.hidden = true;
    rowEls.get(state.selectedId)?.classList.remove('is-selected');
    state.selectedId = null;
    if (state.follow && !holdScroll()) scrollToEnd();
  }

  const visibleIds = () => [...els.rows.children].map((r) => Number(r.dataset.id));

  function stepDetail(delta) {
    const visible = visibleIds();
    const next = visible[visible.indexOf(state.selectedId) + delta];
    if (next === undefined) return;
    openDetail(next);
    rowEls.get(next)?.scrollIntoView({ block: 'nearest' });
  }

  async function flashCopied(btn, text) {
    const ok = await copyText(text);
    const label = btn.querySelector('span');
    if (!label) return;
    const old = label.textContent;
    label.textContent = ok ? 'Copiado' : 'Falha ao copiar';
    setTimeout(() => { label.textContent = old; }, 1500);
  }

  // ---------- Eventos de interface ----------
  els.rows.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.id-chip');
    if (chip) {
      ev.stopPropagation();
      els.search.value = chip.dataset.q;
      applySearch();
      return;
    }
    const row = ev.target.closest('.row');
    if (row && !window.getSelection().toString()) openDetail(Number(row.dataset.id));
  });

  els.viewport.addEventListener('scroll', () => {
    const atEnd = nearBottom();
    if (atEnd !== state.follow) {
      state.follow = atEnd;
      els.follow.setAttribute('aria-pressed', String(atEnd));
    }
    if (atEnd) state.unseen = 0;
    updateJump();
  }, { passive: true });

  els.viewport.addEventListener('pointerenter', () => { hovering = true; });
  els.viewport.addEventListener('pointerleave', () => {
    hovering = false;
    if (state.follow && !holdScroll()) scrollToEnd();
  });

  els.jump.addEventListener('click', () => setFollow(true));
  els.follow.addEventListener('click', () => setFollow(!state.follow));

  els.wrap.addEventListener('click', () => {
    const on = els.wrap.getAttribute('aria-pressed') !== 'true';
    els.wrap.setAttribute('aria-pressed', String(on));
    els.rows.classList.toggle('wrap', on);
    if (state.follow) scrollToEnd();
  });

  els.pause.addEventListener('click', () => {
    state.paused = !state.paused;
    els.pause.setAttribute('aria-pressed', String(state.paused));
    els.pauseText.textContent = state.paused ? 'Retomar' : 'Pausar';
    if (!state.paused && state.held.length) {
      state.queue.push(...state.held);
      state.held = [];
      if (!frame) frame = requestAnimationFrame(flush);
    }
    setConn(state.conn);
  });

  // Limpa só a visualização; rawLines continua valendo para descartar o replay numa reconexão
  els.clear.addEventListener('click', () => {
    state.entries = [];
    state.byId.clear();
    state.counts = { total: 0, INFO: 0, WARN: 0, ERROR: 0 };
    state.minutes.clear();
    state.sources.clear();
    state.held = [];
    closeDetail();
    renderAll();
    drawChart();
    setConn(state.conn);
  });

  els.tabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-level]');
    if (!btn) return;
    state.level = btn.dataset.level;
    for (const b of els.tabs.querySelectorAll('button')) b.setAttribute('aria-checked', String(b === btn));
    renderAll();
  });

  els.source.addEventListener('change', () => {
    state.source = els.source.value;
    renderAll();
  });

  let searchTimer = 0;
  function applySearch() {
    clearTimeout(searchTimer);
    state.query = els.search.value.trim().toLowerCase();
    renderAll();
  }
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 120);
  });
  els.search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      els.search.value = '';
      applySearch();
      els.search.blur();
    }
  });

  els.resetFilters.addEventListener('click', () => {
    els.search.value = '';
    state.query = '';
    state.source = '';
    els.source.value = '';
    state.level = '';
    for (const b of els.tabs.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.level === ''));
    renderAll();
  });

  els.retry.addEventListener('click', connect);

  els.theme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('logs-theme', next); } catch { /* storage indisponível */ }
  });

  els.sheet.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-close]')) { closeDetail(); return; }
    const copy = ev.target.closest('[data-copy]');
    if (copy) copyText(copy.dataset.copy);
  });
  els.prev.addEventListener('click', () => stepDetail(-1));
  els.next.addEventListener('click', () => stepDetail(1));
  els.copyRaw.addEventListener('click', () => {
    const e = state.byId.get(state.selectedId);
    if (e) flashCopied(els.copyRaw, e.raw.join('\n'));
  });

  document.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (!els.sheet.hidden) {
      if (ev.key === 'Escape') { closeDetail(); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); stepDetail(-1); return; }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); stepDetail(1); return; }
    }
    if (ev.key === '/' && !typing && els.sheet.hidden) {
      ev.preventDefault();
      els.search.focus();
      els.search.select();
    }
  });

  // Relógio: "último evento há…", taxa e deslocamento do gráfico com o tempo
  setInterval(updateClock, 1000);
  setInterval(drawChart, 15000);

  updateChrome();
  connect();
})();
