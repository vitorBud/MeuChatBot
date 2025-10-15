/* ============================================================================
   PREVISÕES – MÓDULO ISOLADO (sem loops de resize)
   Depende de:
     - Chart.js já carregado no <head>
     - HTML com ids: pv-form, pv-tema, pv-log, pv-canvas, pv-articles,
                     pv-export, pv-limpar, pv-historico, pv-clear-history,
                     pv-mm, .pv-range (botões de range), .pv-stats (opcional)
   Endpoint:
     - POST /prever  ->  { previsao, series:[{date,count}], artigos:[...],
                           trend:{slope,pct,last_delta,confidence}? }
   ========================================================================== */

(() => {
  // ---------- Cache de DOM ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const pvForm       = $('#pv-form');
  const pvTema       = $('#pv-tema');
  const pvLog        = $('#pv-log');
  const pvCanvas     = $('#pv-canvas');
  const pvArticles   = $('#pv-articles');
  const pvMM         = $('#pv-mm');
  const pvExport     = $('#pv-export');
  const pvLimpar     = $('#pv-limpar');
  const pvHistorico  = $('#pv-historico');
  const pvClearHist  = $('#pv-clear-history');
  const pvRangeBtns  = $$('.pv-range');
  const pvStatsBox   = $('.pv-stats'); // opcional (cards de “Tendência / Δ / Chances”)
  const previsoesView = $('#previsoes-view');

  if (!pvForm || !pvCanvas) {
    console.warn('[previsoes] DOM incompleto; abortando módulo.');
    return;
  }

  // ---------- Estado ----------
  const state = {
    PV_DAYS: 7,
    temaAtual: '',
    series: [],
    chart: null,
    inFlight: null,          // AbortController
    prefsKey: 'pv_prefs_v1',
    histKey: 'pv_history_v2',
    history: [],             // [{tema,at}]
    lastTrend: null,         // { slope, pct, lastDelta, line }
    lastConfidence: null     // { score, label }
  };

  // ---------- Preferências ----------
  const savePrefs = () => {
    try {
      localStorage.setItem(state.prefsKey, JSON.stringify({
        days: state.PV_DAYS,
        useMA: !!pvMM?.checked
      }));
    } catch {}
  };

  const loadPrefs = () => {
    try {
      const raw = localStorage.getItem(state.prefsKey);
      if (!raw) return;
      const { days, useMA } = JSON.parse(raw);
      if ([7, 14, 30].includes(days)) state.PV_DAYS = days;
      if (typeof useMA === 'boolean' && pvMM) pvMM.checked = useMA;
    } catch {}
    // refletir range no UI
    pvRangeBtns.forEach(b => {
      const active = parseInt(b.dataset.days, 10) === state.PV_DAYS;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  };

  // ---------- Histórico ----------
  const loadHistory = () => {
    try {
      state.history = JSON.parse(localStorage.getItem(state.histKey)) || [];
    } catch { state.history = []; }
  };

  const saveHistory = () => {
    try {
      localStorage.setItem(state.histKey, JSON.stringify(state.history));
    } catch {}
  };

  const addHistory = (tema) => {
    if (!tema) return;
    // evita duplicata consecutiva
    if (state.history[0]?.tema?.toLowerCase() === tema.toLowerCase()) return;
    // remove duplicatas antigas
    state.history = state.history.filter(x => x.tema.toLowerCase() !== tema.toLowerCase());
    state.history.unshift({ tema, at: new Date().toISOString() });
    if (state.history.length > 40) state.history.length = 40;
    saveHistory();
    renderHistory();
  };

  const renderHistory = () => {
    if (!pvHistorico) return;
    pvHistorico.innerHTML = '';
    state.history.forEach(item => {
      const li = document.createElement('li');
      const date = new Date(item.at).toLocaleString('pt-BR');
      li.innerHTML = `
        <div class="pv-h-item-title">${item.tema}</div>
        <div class="pv-h-item-date">${date}</div>
      `;
      li.addEventListener('click', () => submitTema(item.tema));
      pvHistorico.appendChild(li);
    });
  };

  pvClearHist?.addEventListener('click', () => {
    state.history = [];
    saveHistory();
    renderHistory();
  });

  // ---------- Utils ----------
  const pvAdd = (text, role = 'bot') => {
    if (!pvLog) return;
    const div = document.createElement('div');
    div.className = `mensagem ${role === 'user' ? 'user' : 'bot'}`;
    div.textContent = text;
    pvLog.appendChild(div);
    pvLog.scrollTop = pvLog.scrollHeight;
  };

  const movingAverage = (arr, win = 3) => {
    if (!Array.isArray(arr) || !arr.length) return [];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const start = Math.max(0, i - win + 1);
      const slice = arr.slice(start, i + 1);
      out.push(Number((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2)));
    }
    return out;
  };

  const fmtDateLabel = (iso) => (iso || '').slice(0, 10);

  const parseYearRangeFromText = (txt) => {
    if (!txt) return null;
    const t = txt.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const m = t.match(/(?:entre\s+)?(19\d{2}|20\d{2})\s*(?:a|ate|e|-|—|–|to)\s*(19\d{2}|20\d{2})/);
    if (!m) return null;
    let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a > b) [a, b] = [b, a];
    return { anos_de: a, anos_ate: b, fromISO: `${a}-01-01`, toISO: `${b}-12-31` };
  };

  // regressão linear (inclinação)
  const linearSlope = (y) => {
    const n = y.length;
    if (n < 2) return 0;
    let sx=0, sy=0, sxy=0, sxx=0;
    for (let i=0;i<n;i++){ sx+=i; sy+=y[i]; sxy+=i*y[i]; sxx+=i*i; }
    const denom = (n*sxx - sx*sx) || 1;
    return (n*sxy - sx*sy) / denom;
  };

  const trendStats = (series) => {
    const counts = (series || []).map(p => p?.count|0);
    const n = counts.length;
    if (!n) return { slope:0, pct:0, lastDelta:0, line:[] };
    const slope = linearSlope(counts);
    const xMean = (n-1)/2;
    const yMean = counts.reduce((a,b)=>a+b,0)/n;
    const line = counts.map((_, i) => Number((yMean + slope*(i - xMean)).toFixed(3)));
    const first = counts[0] || 0;
    const last  = counts[n-1] || 0;
    const pct = first ? ((last - first) / first) * 100 : 0;
    const lastDelta = n>1 ? last - counts[n-2] : 0;
    return { slope, pct, lastDelta, line };
  };

  const stddev = (arr) => {
    const n = arr.length;
    if (n < 2) return 0;
    const m = arr.reduce((a,b)=>a+b,0)/n;
    return Math.sqrt(arr.reduce((s,x)=>s+(x-m)*(x-m),0)/(n-1));
  };

  const confidenceFromSeries = (series, tr) => {
    const counts = (series || []).map(p => p?.count|0);
    const n = counts.length;
    if (n < 3) return { score: 0.5, label: 'Média' };
    const s = stddev(counts) || 1e-6;
    const slopeZ = tr.slope / s;
    let upDays = 0;
    for (let i=1;i<n;i++){ if (counts[i] > counts[i-1]) upDays++; }
    const consistency = upDays / (n-1);
    const min = Math.min(...counts), max = Math.max(...counts);
    const avg = counts.reduce((a,b)=>a+b,0)/n || 1;
    const amp = Math.min(1, Math.max(0, (max - min) / (avg + 1e-6)));
    const sigmoid = x => 1 / (1 + Math.exp(-x));
    const slopeScore = sigmoid(slopeZ);
    const score = Math.max(0, Math.min(1, 0.5*slopeScore + 0.3*consistency + 0.2*amp));
    const label = score >= 0.66 ? 'Alta' : (score < 0.33 ? 'Baixa' : 'Média');
    return { score, label };
  };

  // ---------- UI auxiliares ----------
  const clearUI = () => {
    pvLog && (pvLog.innerHTML = '');
    pvArticles && (pvArticles.innerHTML = '');
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    state.series = [];
    state.temaAtual = '';
    state.lastTrend = null;
    state.lastConfidence = null;
    updateStatsCards(null);
    removeTrendBadge();
  };

  const updateStatsCards = (info) => {
    if (!pvStatsBox) return; // opcional
    pvStatsBox.innerHTML = '';
    if (!info) return;
    const { pct, lastDelta, confLabel } = info;
    const blocks = [
      { label: 'Tendência', value: `${pct > 0 ? 'Alta ↑' : (pct < 0 ? 'Baixa ↓' : 'Estável →')}` },
      { label: 'Δ Diário',  value: (lastDelta>0?'+':'') + lastDelta },
      { label: 'Chances',   value: confLabel }
    ];
    blocks.forEach(b => {
      const d = document.createElement('div');
      d.className = 'pv-stat';
      d.innerHTML = `<div class="label">${b.label}</div><div class="value">${b.value}</div>`;
      pvStatsBox.appendChild(d);
    });
  };

  const removeTrendBadge = () => {
    const card = previsoesView?.querySelector('.pv-card');
    if (!card) return;
    const badge = card.querySelector('.pv-trend');
    badge?.remove();
  };

  const setTrendBadge = (pct, slope, confidenceLabel) => {
    const titleEl = previsoesView?.querySelector('.pv-card .pv-card-title');
    if (!titleEl) return;
    removeTrendBadge();
    const up = slope > 0.0001;
    const down = slope < -0.0001;
    const badge = document.createElement('span');
    badge.className = 'pv-trend';
    badge.style.marginLeft = '8px';
    badge.style.fontWeight = '700';
    badge.style.color = up ? '#22c55e' : (down ? '#ef4444' : '#9fb0c8');
    const arrow = up ? '↑' : (down ? '↓' : '→');
    badge.textContent = `${arrow} ${pct.toFixed(1)}% · Chances: ${confidenceLabel}`;
    titleEl.after(badge);
  };

  // ---------- Chart ----------
  let renderLock = false; // evita render concorrente

  const renderChart = (series) => {
    if (!pvCanvas || renderLock) return;
    renderLock = true;
    try {
      const labels = series.map(p => fmtDateLabel(p.date));
      const counts = series.map(p => p.count|0);
      const mx = Math.max(0, ...counts);

      const tr = trendStats(series);
      const conf = confidenceFromSeries(series, tr);
      state.lastTrend = tr;
      state.lastConfidence = conf;

      const up = tr.slope > 0.0001;
      const down = tr.slope < -0.0001;
      const mainColor = up ? '#22c55e' : (down ? '#ef4444' : '#66a3ff');

      if (state.chart) { state.chart.destroy(); state.chart = null; }
      const ctx = pvCanvas.getContext('2d');
      state.chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Matérias/dia',
              data: counts,
              borderColor: mainColor,
              backgroundColor: (c) => {
                const { chartArea } = c.chart;
                if (!chartArea) return mainColor + '33';
                const g = c.chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                g.addColorStop(0, up ? 'rgba(34,197,94,.35)' : (down ? 'rgba(239,68,68,.35)' : 'rgba(102,163,255,.35)'));
                g.addColorStop(1, 'rgba(0,0,0,0)');
                return g;
              },
              fill: 'start',
              tension: 0.3,
              pointRadius: 3,
              pointHoverRadius: 4,
              borderWidth: 2
            },
            ...(pvMM?.checked ? [{
              label: 'MM 3d',
              data: movingAverage(counts, 3),
              borderColor: '#a78bfa',
              pointRadius: 0,
              borderWidth: 2,
              tension: 0.25
            }] : []),
            {
              label: 'Tendência',
              data: tr.line,
              borderColor: up ? '#22c55e' : (down ? '#ef4444' : '#9fb0c8'),
              borderDash: [6, 4],
              pointRadius: 0,
              borderWidth: 2,
              tension: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          resizeDelay: 200,            // <- debounce interno do Chart.js
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: 'index',
              intersect: false,
              callbacks: {
                title: (items) => `Dia: ${items[0].label}`,
                afterBody: () => {
                  const s = tr.lastDelta > 0 ? '↑' : tr.lastDelta < 0 ? '↓' : '→';
                  return [
                    `Variação dia: ${s} ${tr.lastDelta}`,
                    `Período: ${tr.pct.toFixed(1)}%`,
                    `Chances: ${conf.label}`
                  ];
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,.07)' },
              ticks: { autoSkip: true, maxTicksLimit: 8 }
            },
            y: {
              beginAtZero: true,
              grid: { color: 'rgba(255,255,255,.07)' },
              suggestedMax: Math.max(1, mx + 1)
            }
          }
        }
      });

      setTrendBadge(tr.pct, tr.slope, conf.label);
      updateStatsCards({ pct: tr.pct, lastDelta: tr.lastDelta, confLabel: conf.label });

      if (mx === 0) {
        pvAdd('Bot: Sem variação detectada no período (cobertura nula/baixa). Tente ampliar o intervalo ou outro tema.', 'bot');
      }
    } finally {
      renderLock = false;
    }
  };

  // ---------- Export ----------
  pvExport?.addEventListener('click', () => {
    if (!state.series.length) return;
    const counts = state.series.map(p => p.count|0);
    const mm = pvMM?.checked ? movingAverage(counts, 3) : [];
    const header = pvMM?.checked ? 'date,count,mm3d\n' : 'date,count\n';
    const rows = state.series.map((p, i) =>
      pvMM?.checked ? `${p.date},${p.count},${mm[i] ?? ''}` : `${p.date},${p.count}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const temaSlug = (state.temaAtual || 'series_previsoes').toLowerCase().replace(/[^\w\-]+/g, '-');
    a.href = url; a.download = `${temaSlug}-${state.PV_DAYS}d.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  // ---------- Range & MM ----------
  pvRangeBtns.forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
    btn.addEventListener('click', () => {
      pvRangeBtns.forEach(b => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      state.PV_DAYS = parseInt(btn.dataset.days, 10) || 7;
      savePrefs();
      // Reconsulta (evita re-render local que pode enganar o usuário)
      if (state.temaAtual) submitTema(state.temaAtual);
    });
  });

  pvMM?.addEventListener('change', () => {
    savePrefs();
    if (state.series.length) renderChart(state.series);
  });

  pvLimpar?.addEventListener('click', clearUI);

  // ---------- Fetch (com retry simples) ----------
  const fetchWithRetry = async (url, options = {}, retries = 2, delay = 800) => {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        if (res.status === 429 && retries > 0) {
          await new Promise(r => setTimeout(r, delay));
          return fetchWithRetry(url, options, retries - 1, delay * 2);
        }
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
      }
      return res;
    } catch (e) {
      if (retries > 0) {
        await new Promise(r => setTimeout(r, delay));
        return fetchWithRetry(url, options, retries - 1, delay * 2);
      }
      throw e;
    }
  };

  // ---------- Fluxo principal ----------
  const submitTema = async (temaOpt) => {
    const value = (temaOpt ?? pvTema?.value ?? '').trim();
    if (!value) return;

    // cancela requisição anterior
    if (state.inFlight) state.inFlight.abort?.();
    const controller = new AbortController();
    state.inFlight = controller;

    pvAdd(`Você: ${value}`, 'user');
    const thinking = 'Bot: coletando manchetes e montando série...';
    pvAdd(thinking, 'bot');

    const submitBtn = pvForm?.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    if (pvTema) pvTema.value = '';

    try {
      const yr = parseYearRangeFromText(value);
      const body = { tema: value, dias: state.PV_DAYS };
      if (yr) { body.anos_de = yr.anos_de; body.anos_ate = yr.anos_ate; }

      const res = await fetchWithRetry('/prever', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const data = await res.json().catch(() => ({}));
      if (data.erro) { pvAdd(`Bot: ${data.erro}`, 'bot'); return; }

      state.temaAtual = value;
      addHistory(value);

      // remove “pensando...” se for a última
      const last = pvLog?.lastElementChild;
      if (last && last.textContent === thinking) last.remove();

      pvAdd(`Bot: ${data.previsao || 'Sem resumo.'}`, 'bot');

      // série
      const series = Array.isArray(data.series) ? data.series.slice() : [];
      series.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      state.series = series;

      // trend/confidence do backend (opcional)
      if (data.trend && typeof data.trend === 'object') {
        // vamos recalcular a reta visual localmente, mas aproveitamos pct/last_delta/confidence
        const trLocal = trendStats(series);
        state.lastTrend = {
          slope: Number(data.trend.slope ?? trLocal.slope),
          pct:   Number(data.trend.pct   ?? trLocal.pct),
          lastDelta: Number(data.trend.last_delta ?? trLocal.lastDelta),
          line: trLocal.line
        };
        state.lastConfidence = { label: data.trend.confidence || 'Média', score: 0.5 };
      }

      // render chart
      renderChart(state.series);

      // artigos
      const arts = Array.isArray(data.artigos) ? data.artigos : [];
      pvArticles.innerHTML = arts.map(a => {
        const title = a?.titulo || a?.title || 'sem título';
        const url   = a?.url || a?.link || '#';
        const date  = a?.data_iso || a?.data || null;
        const fonte = a?.fonte ? ` — ${a.fonte}` : '';
        const dStr  = date ? new Date(date).toLocaleString('pt-BR') : '';
        return `<div>• <a href="${url}" target="_blank" rel="noopener">${title}</a>
                <span style="color:#8aa0bf">${fonte}${dStr ? ' · ' + dStr : ''}</span></div>`;
      }).join('') || '<div style="color:#8aa0bf">Sem artigos encontrados nesse período.</div>';

      // loga stats
      const tr = state.lastTrend || trendStats(state.series);
      const conf = state.lastConfidence || confidenceFromSeries(state.series, tr);
      pvAdd(`Bot: Tendência no período: ${tr.pct.toFixed(1)}% · Chances: ${conf.label}`, 'bot');

    } catch (err) {
      if (err?.name === 'AbortError') {
        pvAdd('Bot: consulta anterior cancelada.', 'bot');
      } else {
        pvAdd('Bot: erro ao consultar /prever — ' + (err?.message || 'falha desconhecida'), 'bot');
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (state.inFlight === controller) state.inFlight = null;
    }
  };

  pvForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitTema();
  });

  // ---------- Boot ----------
  if (pvLog) pvLog.setAttribute('aria-live', 'polite');
  loadPrefs();
  loadHistory();
  renderHistory();

  // guarda globalmente alguns helpers (debug opcional)
  window.__previsoesDebug = {
    submitTema, renderChart,
    getState: () => ({ ...state })
  };

  // guardas de erro (úteis de verdade)
  window.addEventListener('error', (e)=> console.error('[previsoes] onerror:', e.message, e.filename, e.lineno));
  window.addEventListener('unhandledrejection', (e)=> console.error('[previsoes] unhandledrejection:', e.reason));
})();
