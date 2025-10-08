// ===== Previsões (somente lógica da view de previsões) =====

// Seletores (mesmos do seu contrato)
const pvForm = document.getElementById('pv-form');
const pvTema = document.getElementById('pv-tema');
const pvLog = document.getElementById('pv-log');
const pvCanvas = document.getElementById('pv-canvas');
const pvArticles = document.getElementById('pv-articles');

const pvRangeBtns = document.querySelectorAll('.pv-range');
const pvMM = document.getElementById('pv-mm');
const pvExport = document.getElementById('pv-export');
const pvLimpar = document.getElementById('pv-limpar');

const pvHistorico = document.getElementById('pv-historico');
const pvClearHistory = document.getElementById('pv-clear-history');

const previsoesView = document.getElementById('previsoes-view');

let pvChart = null;
let PV_DAYS = 7; // default
let currentSeries = []; // última série recebida (para export)
let currentTema = '';
let inFlight = null; // AbortController da requisição ativa

// ===== A11y & Preferências =====
if (pvLog) pvLog.setAttribute('aria-live', 'polite');

function savePrefs() {
  try {
    localStorage.setItem('pv_prefs_v1', JSON.stringify({
      days: PV_DAYS,
      useMA: !!pvMM?.checked
    }));
  } catch {}
}
function loadPrefs() {
  try {
    const raw = localStorage.getItem('pv_prefs_v1');
    if (!raw) return;
    const { days, useMA } = JSON.parse(raw);
    if (days && [7, 14, 30].includes(days)) {
      PV_DAYS = days;
      pvRangeBtns.forEach(b => {
        const isActive = parseInt(b.dataset.days, 10) === PV_DAYS;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', String(isActive));
      });
    }
    if (typeof useMA === 'boolean' && pvMM) {
      pvMM.checked = useMA;
    }
  } catch {}
}

// ===== Util =====
function pvAdd(text, role = 'bot') {
  const div = document.createElement('div');
  div.classList.add('mensagem', role === 'user' ? 'user' : 'bot');
  // Segurança: sem HTML arbitrário
  div.textContent = text;
  pvLog.appendChild(div);
  pvLog.scrollTop = pvLog.scrollHeight;
}

function pvClear() {
  pvLog.innerHTML = '';
  pvArticles.innerHTML = '';
  if (pvChart) { pvChart.destroy(); pvChart = null; }
  currentSeries = [];
  currentTema = '';
}

function movingAverage(arr, window = 3) {
  if (!arr || arr.length === 0) return [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = arr.slice(start, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    out.push(Number(avg.toFixed(2)));
  }
  return out;
}

function fmtDateLabel(iso) {
  // Tenta usar só AAAA-MM-DD para clareza no eixo
  try {
    return (iso || '').slice(0, 10);
  } catch { return iso; }
}

// ===== Histórico (localStorage, embutido no painel) =====
const pvState = { history: [] }; // [{tema, at}]
function pvLoadHistory() {
  try {
    const raw = localStorage.getItem('pv_history_v2');
    pvState.history = raw ? JSON.parse(raw) : [];
  } catch {
    pvState.history = [];
  }
}
function pvSaveHistory() {
  localStorage.setItem('pv_history_v2', JSON.stringify(pvState.history));
}
function pvAddHistory(tema) {
  if (!tema) return;
  // Evita duplicar consecutivo
  if (pvState.history[0]?.tema?.toLowerCase() === tema.toLowerCase()) return;

  // Remove duplicatas antigas do mesmo tema
  pvState.history = pvState.history.filter(h => h.tema.toLowerCase() !== tema.toLowerCase());

  pvState.history.unshift({ tema, at: new Date().toISOString() });
  if (pvState.history.length > 40) pvState.history.length = 40;
  pvSaveHistory();
  renderPVHistory();
}
function renderPVHistory() {
  if (!pvHistorico) return;
  pvHistorico.innerHTML = '';
  pvState.history.forEach(item => {
    const li = document.createElement('li');
    const date = new Date(item.at).toLocaleString('pt-BR');
    li.innerHTML = `
      <div class="pv-h-item-title">${item.tema}</div>
      <div class="pv-h-item-date">${date}</div>
    `;
    li.addEventListener('click', () => {
      pvTema.value = item.tema;
      // Ação direta: reexecuta a busca ao clicar no histórico
      submitTema(item.tema);
    });
    pvHistorico.appendChild(li);
  });
}
pvClearHistory?.addEventListener('click', () => {
  pvState.history = [];
  pvSaveHistory();
  renderPVHistory();
});

// ===== Chart.js (área com gradiente + linha da MM opcional) =====
function buildDatasets(series) {
  const counts = series.map(p => p.count);
  const datasets = [
    {
      label: 'Matérias/dia',
      data: counts,
      borderColor: '#66a3ff',
      backgroundColor: (ctx) => {
        const { chart } = ctx;
        const { ctx: c, chartArea } = chart;
        if (!chartArea) return '#66a3ff33';
        const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        gradient.addColorStop(0, 'rgba(102, 163, 255, 0.35)');
        gradient.addColorStop(1, 'rgba(102, 163, 255, 0.00)');
        return gradient;
      },
      fill: 'start',
      tension: 0.3,
      pointRadius: 3,
      pointHoverRadius: 4,
      borderWidth: 2
    }
  ];
  if (pvMM?.checked) {
    datasets.push({
      label: 'MM 3d',
      data: movingAverage(counts, 3),
      borderColor: '#a78bfa',
      pointRadius: 0,
      borderWidth: 2,
      tension: 0.25
    });
  }
  return datasets;
}

function renderChart(series) {
  if (!pvCanvas) return;
  const labels = series.map(p => fmtDateLabel(p.date));
  const counts = series.map(p => p.count);
  const { slope, pct, lastDelta, line } = trendStats(series);

  // cor da série principal por tendência
  const up = slope > 0.0001;
  const down = slope < -0.0001;
  const mainColor = up ? '#22c55e' : (down ? '#ef4444' : '#66a3ff'); // verde / vermelho / neutro

  if (pvChart) pvChart.destroy();
  pvChart = new Chart(pvCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Matérias/dia',
          data: counts,
          borderColor: mainColor,
          backgroundColor: (ctx) => {
            const { chart } = ctx;
            const { ctx: c, chartArea } = chart;
            if (!chartArea) return mainColor + '33';
            const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            g.addColorStop(0, (up ? 'rgba(34,197,94,.35)' : (down ? 'rgba(239,68,68,.35)' : 'rgba(102,163,255,.35)')));
            g.addColorStop(1, 'rgba(0,0,0,0)');
            return g;
          },
          fill: 'start',
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 4,
          borderWidth: 2
        },
        // MM 3d opcional
        ...(pvMM?.checked ? [{
          label: 'MM 3d',
          data: movingAverage(counts, 3),
          borderColor: '#a78bfa',
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.25
        }] : []),
        // Linha de tendência (reta de regressão)
        {
          label: 'Tendência',
          data: line,
          borderColor: up ? '#22c55e' : (down ? '#ef4444' : '#9fb0c8'),
          borderDash: [6,4],
          pointRadius: 0,
          borderWidth: 2,
          tension: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            title: (items) => `Dia: ${items[0].label}`,
            afterBody: () => {
              const sign = lastDelta > 0 ? '↑' : (lastDelta < 0 ? '↓' : '→');
              return [`Variação dia: ${sign} ${lastDelta}`, `Tendência (${PV_DAYS}d): ${pct.toFixed(1)}%`];
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
          suggestedMax: Math.max(5, Math.max(...counts, 0) + 2)
        }
      }
    }
  });

  // Badge visual no título (opcional, sem mexer no CSS)
  const titleEl = previsoesView?.querySelector('.pv-card .pv-card-title');
  if (titleEl && titleEl.textContent?.includes('Volume de notícias por dia')) {
    titleEl.nextSibling?.nodeType === 1 && titleEl.nextSibling.classList?.contains('pv-trend') && titleEl.nextSibling.remove();
    const badge = document.createElement('span');
    badge.className = 'pv-trend';
    badge.style.marginLeft = '8px';
    badge.style.fontWeight = '700';
    badge.style.color = up ? '#22c55e' : (down ? '#ef4444' : '#9fb0c8');
    const arrow = up ? '↑' : (down ? '↓' : '→');
    badge.textContent = `${arrow} ${pct.toFixed(1)}%`;
    titleEl.after(badge);
  }
}


// Redimensiona o gráfico ao mostrar a view de previsões
function whenPrevisoesBecomesVisible(cb) {
  if (!previsoesView) return;
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(en => {
      if (en.isIntersecting) cb();
    });
  }, { root: document, threshold: 0.1 });
  obs.observe(previsoesView);
}
whenPrevisoesBecomesVisible(() => {
  if (pvChart) {
    // pequeno raf para garantir layout estável
    requestAnimationFrame(() => pvChart.resize());
  }
});

// ===== Exportar CSV da série atual (inclui MM quando ligada) =====
pvExport?.addEventListener('click', () => {
  if (!currentSeries.length) return;
  const counts = currentSeries.map(p => p.count);
  const mm = pvMM?.checked ? movingAverage(counts, 3) : [];
  const header = pvMM?.checked ? 'date,count,mm3d\n' : 'date,count\n';
  const rows = currentSeries.map((p, i) =>
    pvMM?.checked ? `${p.date},${p.count},${mm[i] ?? ''}` : `${p.date},${p.count}`
  ).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const temaSlug = (currentTema || 'series_previsoes').toLowerCase().replace(/[^\w\-]+/g,'-');
  a.download = `${temaSlug}-${PV_DAYS}d.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ===== Controles de período e MM =====
pvRangeBtns.forEach(btn => {
  // A11y toggle
  btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
  btn.addEventListener('click', () => {
    pvRangeBtns.forEach(b => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    PV_DAYS = parseInt(btn.dataset.days, 10) || 7;
    savePrefs();
    // Se já temos dados, reconsulta com novo range para refletir no gráfico e artigos
    if (currentTema) {
      submitTema(currentTema);
    } else if (currentSeries.length) {
      // fallback: re-renderiza somente a MM
      renderChart(currentSeries);
    }
  });
});
pvMM?.addEventListener('change', () => {
  savePrefs();
  if (currentSeries.length) renderChart(currentSeries);
});

pvLimpar?.addEventListener('click', pvClear);

// ===== Fetch com cancelamento + retry =====
async function fetchWithRetry(url, options = {}, retries = 2, delay = 800) {
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
}

// ===== Fluxo principal =====
async function submitTema(tema) {
  const value = (tema ?? pvTema.value ?? '').trim();
  if (!value) return;

  // Cancela requisição anterior, se houver
  if (inFlight) inFlight.abort?.();
  const controller = new AbortController();
  inFlight = controller;

  // UI
  const userLine = `Você: ${value}`;
  pvAdd(userLine, 'user');
  const thinkingMsg = 'Bot: coletando manchetes e montando série...';
  pvAdd(thinkingMsg, 'bot');

  // Desabilita form durante a chamada
  const submitBtn = pvForm?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  if (pvTema) pvTema.value = '';

  try {
    const res = await fetchWithRetry('/prever', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tema: value, dias: PV_DAYS }),
      signal: controller.signal
    });

    const data = await res.json().catch(() => ({}));
    if (data.erro) { pvAdd(`Bot: ${data.erro}`, 'bot'); return; }

    currentTema = value;

    // histórico local
    pvAddHistory(value);

    // Remove a última linha "pensando..." (se ainda for a última)
    const last = pvLog.lastElementChild;
    if (last && last.textContent === thinkingMsg) {
      last.remove();
    }

    // resumo
    pvAdd(`Bot: ${data.previsao || 'Sem resumo.'}`, 'bot');

    // série + gráfico
    currentSeries = Array.isArray(data.series) ? data.series : [];
    // Proteção: ordena por data asc se vier embaralhado
    currentSeries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    renderChart(currentSeries);

    // artigos
    const arts = Array.isArray(data.artigos) ? data.artigos : [];
    pvArticles.innerHTML = arts.map(a => {
      const d = a.data_iso ? new Date(a.data_iso).toLocaleString('pt-BR') : '';
      const fonte = a.fonte ? ` — ${a.fonte}` : '';
      const safeTitle = a.titulo || 'sem título';
      const safeUrl = a.url || '#';
      return `<div>• <a href="${safeUrl}" target="_blank" rel="noopener">${safeTitle}</a>
              <span style="color:#8aa0bf">${fonte}${d ? ' · ' + d : ''}</span></div>`;
    }).join('');

  } catch (err) {
    if (err?.name === 'AbortError') {
      pvAdd('Bot: consulta anterior cancelada.', 'bot');
    } else {
      pvAdd('Bot: erro ao consultar /prever — ' + (err?.message || 'falha desconhecida'), 'bot');
    }
  } finally {
    // Reabilita form
    if (submitBtn) submitBtn.disabled = false;
    // limpa o inFlight se for o mesmo controller
    if (inFlight === controller) inFlight = null;
  }
}

pvForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitTema();
});

// ===== Boot =====
loadPrefs();
pvLoadHistory();
renderPVHistory();

// Garante que o botão ativo está com aria-pressed correto (caso prefs não tenham sido carregadas)
pvRangeBtns.forEach(b => {
  const active = parseInt(b.dataset.days, 10) === PV_DAYS;
  b.classList.toggle('active', active);
  b.setAttribute('aria-pressed', String(active));
});

// Recalibra o chart ao redimensionar janela
window.addEventListener('resize', () => {
  if (pvChart) pvChart.resize();
});
