// ============================================================================
// OrionAI — Módulo de Previsões Inteligentes (Versão Melhorada)
// - Sistema de análise preditiva mais preciso
// - Algoritmos de machine learning simples
// - Previsões quantitativas claras
// - Análise de tendências avançada
// ============================================================================

(() => {
  // ---------- DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const pvForm = $('#pv-form');
  const pvTema = $('#pv-tema');
  const pvLog = $('#pv-log');
  const pvCanvas = $('#pv-canvas');
  const pvArticles = $('#pv-articles');
  const pvMM = $('#pv-mm');
  const pvExport = $('#pv-export');
  const pvLimpar = $('#pv-limpar');
  const pvHistorico = $('#pv-historico');
  const pvClearHist = $('#pv-clear-history');
  const pvRangeBtns = $$('.pv-range');
  const pvStatsBox = $('.pv-stats');
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
    inFlight: null,
    prefsKey: 'pv_prefs_v3',
    histKey: 'pv_history_v3',
    history: [],
    lastPrediction: null,
    forecastDays: 5, // Dias para prever no futuro
    // artigos (paginados)
    allArticles: [],
    pageSize: 8,
    pageIndex: 0,
    // cache leve (memória) por 2 minutos
    cache: new Map(),
    cacheTTL: 120000
  };

  // ---------- Preferências ----------
  const savePrefs = () => {
    try {
      localStorage.setItem(state.prefsKey, JSON.stringify({
        days: state.PV_DAYS,
        useMA: !!pvMM?.checked
      }));
    } catch { }
  };

  const loadPrefs = () => {
    try {
      const raw = localStorage.getItem(state.prefsKey);
      if (raw) {
        const { days, useMA } = JSON.parse(raw);
        if ([7, 14, 30].includes(days)) state.PV_DAYS = days;
        if (typeof useMA === 'boolean' && pvMM) pvMM.checked = useMA;
      }
    } catch { }
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
    try { localStorage.setItem(state.histKey, JSON.stringify(state.history)); } catch { }
  };
  const addHistory = (tema) => {
    if (!tema) return;
    if (state.history[0]?.tema?.toLowerCase() === tema.toLowerCase()) return;
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

  const fmtDateLabel = (iso) => (iso || '').slice(0, 10);

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

  // ---------- ALGORITMOS DE PREVISÃO MELHORADOS ----------
  
  // Regressão linear para tendência
  const linearRegression = (y) => {
    const n = y.length;
    if (n < 2) return { slope: 0, intercept: 0 };
    
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += y[i];
      sumXY += i * y[i];
      sumXX += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return { slope, intercept };
  };

  // Previsão usando regressão linear
  const forecastLinear = (data, daysAhead = 5) => {
    const values = data.map(d => d.count);
    const { slope, intercept } = linearRegression(values);
    
    const forecast = [];
    const lastIndex = data.length - 1;
    const lastDate = new Date(data[lastIndex].date);
    
    for (let i = 1; i <= daysAhead; i++) {
      const futureValue = Math.max(0, intercept + slope * (lastIndex + i));
      const futureDate = new Date(lastDate);
      futureDate.setDate(futureDate.getDate() + i);
      
      forecast.push({
        date: futureDate.toISOString().split('T')[0],
        count: Math.round(futureValue),
        isForecast: true
      });
    }
    
    return forecast;
  };

  // Análise de sazonalidade semanal
  const detectSeasonality = (data) => {
    if (data.length < 14) return null; // Precisa de pelo menos 2 semanas
    
    const weeklyPattern = [0, 0, 0, 0, 0, 0, 0]; // Domingo a Sábado
    
    data.forEach((point, index) => {
      const date = new Date(point.date);
      const dayOfWeek = date.getDay(); // 0 = Domingo, 6 = Sábado
      weeklyPattern[dayOfWeek] += point.count;
    });
    
    // Normalizar
    const weeks = Math.ceil(data.length / 7);
    const normalized = weeklyPattern.map(val => val / weeks);
    
    // Calcular variação sazonal
    const avg = normalized.reduce((a, b) => a + b, 0) / 7;
    const seasonality = normalized.map(val => (val - avg) / avg);
    
    return seasonality;
  };

  // Previsão com sazonalidade
  const forecastWithSeasonality = (data, daysAhead = 5) => {
    const linearForecast = forecastLinear(data, daysAhead);
    const seasonality = detectSeasonality(data);
    
    if (!seasonality) return linearForecast;
    
    return linearForecast.map((point, index) => {
      const date = new Date(point.date);
      const dayOfWeek = date.getDay();
      const seasonalAdjustment = seasonality[dayOfWeek] || 0;
      
      return {
        ...point,
        count: Math.max(0, Math.round(point.count * (1 + seasonalAdjustment)))
      };
    });
  };

  // Análise de confiança da previsão
  const calculateForecastConfidence = (data, forecast) => {
    if (data.length < 5) return 0.5;
    
    // Calcular R² do modelo
    const values = data.map(d => d.count);
    const { slope, intercept } = linearRegression(values);
    
    const yMean = values.reduce((a, b) => a + b, 0) / values.length;
    let ssTotal = 0;
    let ssResidual = 0;
    
    values.forEach((y, i) => {
      ssTotal += Math.pow(y - yMean, 2);
      const predicted = intercept + slope * i;
      ssResidual += Math.pow(y - predicted, 2);
    });
    
    const rSquared = 1 - (ssResidual / ssTotal);
    
    // Fator de estabilidade (variância dos dados)
    const variance = values.reduce((acc, val) => acc + Math.pow(val - yMean, 2), 0) / values.length;
    const stability = Math.max(0, 1 - (variance / (yMean + 1)));
    
    // Fator de tendência clara
    const trendStrength = Math.min(1, Math.abs(slope) * 10);
    
    return Math.min(0.95, (rSquared * 0.4 + stability * 0.4 + trendStrength * 0.2));
  };

  // Gerar análise textual da previsão
  const generatePredictionText = (data, forecast, confidence) => {
    const currentAvg = data.reduce((sum, point) => sum + point.count, 0) / data.length;
    const forecastAvg = forecast.reduce((sum, point) => sum + point.count, 0) / forecast.length;
    const changePercent = ((forecastAvg - currentAvg) / currentAvg) * 100;
    
    const trend = changePercent > 5 ? 'forte alta' : 
                 changePercent > 1 ? 'leve alta' :
                 changePercent < -5 ? 'forte queda' :
                 changePercent < -1 ? 'leve queda' : 'estabilidade';
    
    const confidenceText = confidence > 0.8 ? 'alta confiança' :
                          confidence > 0.6 ? 'confiança moderada' :
                          'baixa confiança';
    
    const direction = changePercent > 0 ? 'aumentará' : 
                     changePercent < 0 ? 'diminuirá' : 'permanecerá estável';
    
    return `Baseado na análise de ${data.length} dias, prevejo que o interesse em "${state.temaAtual}" ${direction} nos próximos ${state.forecastDays} dias, com uma ${trend} (${Math.abs(changePercent).toFixed(1)}%). Esta previsão tem ${confidenceText} (${Math.round(confidence * 100)}%).`;
  };

  // ---------- Chart com Previsão ----------
  let renderLock = false;
  let ro = null;

  const destroyChart = () => {
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    if (ro) { ro.disconnect(); ro = null; }
  };

  const renderChart = (series, forecast = []) => {
    if (!pvCanvas || renderLock) return;
    renderLock = true;
    try {
      const allData = [...series, ...forecast];
      const labels = allData.map(p => fmtDateLabel(p.date));
      const counts = allData.map(p => p.count | 0);
      const isForecast = allData.map(p => !!p.isForecast);
      
      const historicalCounts = series.map(p => p.count | 0);
      const mx = Math.max(0, ...counts);

      destroyChart();
      const ctx = pvCanvas.getContext('2d');
      state.chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            // Dados históricos
            {
              label: 'Dados Históricos',
              data: counts.map((count, i) => isForecast[i] ? null : count),
              borderColor: '#007aff',
              backgroundColor: 'rgba(0, 122, 255, 0.1)',
              fill: 'start',
              tension: 0.3,
              pointRadius: 4,
              pointHoverRadius: 6,
              borderWidth: 2
            },
            // Previsão
            {
              label: 'Previsão',
              data: counts.map((count, i) => isForecast[i] ? count : null),
              borderColor: '#ff9500',
              backgroundColor: 'rgba(255, 149, 0, 0.1)',
              fill: false,
              tension: 0.3,
              pointRadius: 4,
              pointHoverRadius: 6,
              borderWidth: 2,
              borderDash: [5, 5]
            },
            // Média móvel
            ...(pvMM?.checked ? [{
              label: 'MM 3d',
              data: movingAverage(historicalCounts, 3).map((val, i) => isForecast[i] ? null : val),
              borderColor: '#34c759',
              pointRadius: 0,
              borderWidth: 1.5,
              tension: 0.25
            }] : [])
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          resizeDelay: 200,
          animation: false,
          plugins: {
            legend: { 
              display: true,
              position: 'top'
            },
            tooltip: {
              mode: 'index',
              intersect: false,
              callbacks: {
                title: (items) => {
                  const item = items[0];
                  const isPred = isForecast[item.dataIndex];
                  return `${item.label} ${isPred ? '(Previsão)' : ''}`;
                }
              }
            }
          },
          scales: {
            x: { 
              grid: { color: 'rgba(255,255,255,.07)' }, 
              ticks: { autoSkip: true, maxTicksLimit: 12 } 
            },
            y: { 
              beginAtZero: true, 
              grid: { color: 'rgba(255,255,255,.07)' }, 
              suggestedMax: Math.max(1, mx + 1) 
            }
          }
        }
      });

      // Resize Observer
      ro = new ResizeObserver(() => { state.chart?.resize(); });
      ro.observe(pvCanvas);

      updateStatsCards(historicalCounts, forecast, state.lastPrediction?.confidence || 0);

    } finally {
      renderLock = false;
    }
  };

  const updateStatsCards = (historical, forecast, confidence) => {
    if (!pvStatsBox) return;
    pvStatsBox.innerHTML = '';
    
    const currentAvg = historical.reduce((a, b) => a + b, 0) / historical.length;
    const forecastAvg = forecast.reduce((a, b) => a + b, 0) / forecast.length;
    const changePercent = ((forecastAvg - currentAvg) / currentAvg) * 100;
    
    const blocks = [
      { label: 'Tendência', value: changePercent > 0 ? 'Alta ↑' : (changePercent < 0 ? 'Baixa ↓' : 'Estável →') },
      { label: 'Variação', value: `${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}%` },
      { label: 'Confiança', value: `${Math.round(confidence * 100)}%` }
    ];
    
    blocks.forEach(b => {
      const d = document.createElement('div');
      d.className = 'pv-stat';
      d.innerHTML = `<div class="label">${b.label}</div><div class="value">${b.value}</div>`;
      pvStatsBox.appendChild(d);
    });
  };

  const clearUI = () => {
    pvLog && (pvLog.innerHTML = '');
    pvArticles && (pvArticles.innerHTML = '');
    destroyChart();
    state.series = [];
    state.temaAtual = '';
    state.lastPrediction = null;
    state.allArticles = [];
    state.pageIndex = 0;
    pvStatsBox && (pvStatsBox.innerHTML = '');
  };

  // ---------- Export ----------
  pvExport?.addEventListener('click', () => {
    if (!state.series.length) return;
    
    const header = 'date,count,type\n';
    const historicalRows = state.series.map(p => `${p.date},${p.count},historical`).join('\n');
    const forecastRows = state.lastPrediction?.forecast?.map(p => `${p.date},${p.count},forecast`).join('\n') || '';
    
    const rows = forecastRows ? historicalRows + '\n' + forecastRows : historicalRows;
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const temaSlug = (state.temaAtual || 'series_previsoes').toLowerCase().replace(/[^\w\-]+/g, '-');
    a.href = url; a.download = `${temaSlug}-previsao-${state.PV_DAYS}d.csv`;
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
      if (state.temaAtual) submitTema(state.temaAtual);
    });
  });
  pvMM?.addEventListener('change', () => {
    savePrefs();
    if (state.series.length) {
      renderChart(state.series, state.lastPrediction?.forecast || []);
    }
  });
  pvLimpar?.addEventListener('click', clearUI);

  // ---------- Fetch com retry + cache ----------
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

  const cacheKey = (tema, dias) => `${tema}::${dias}`;
  const getCache = (k) => {
    const hit = state.cache.get(k);
    if (!hit) return null;
    if (Date.now() - hit.at > state.cacheTTL) { state.cache.delete(k); return null; }
    return hit.payload;
  };
  const setCache = (k, payload) => state.cache.set(k, { at: Date.now(), payload });

  // ---------- Artigos (UI) ----------
  const setArticlesLoading = (flag) => {
    if (!pvArticles) return;
    if (flag) {
      pvArticles.innerHTML = `
        <div style="opacity:.85">• Carregando artigos…</div>
        <div style="opacity:.55">• Aguarde, buscando fontes…</div>
      `;
    }
  };

  const renderArticles = () => {
    if (!pvArticles) return;
    const start = 0;
    const end = Math.min(state.allArticles.length, (state.pageIndex + 1) * state.pageSize);
    const slice = state.allArticles.slice(start, end);

    pvArticles.innerHTML = slice.map(a => {
      const title = a?.titulo || a?.title || 'sem título';
      const url = a?.url || a?.link || '#';
      const date = a?.data_iso || a?.data || null;
      const fonte = a?.fonte ? ` — ${a.fonte}` : '';
      const dStr = date ? new Date(date).toLocaleString('pt-BR') : '';
      return `<div>• <a href="${url}" target="_blank" rel="noopener">${title}</a>
              <span style="color:#8aa0bf">${fonte}${dStr ? ' · ' + dStr : ''}</span></div>`;
    }).join('') || '<div style="color:#8aa0bf">Sem artigos encontrados nesse período.</div>';

    // botão "ver mais"
    const moreNeeded = end < state.allArticles.length;
    let btn = pvArticles.parentElement.querySelector('.pv-more');
    if (moreNeeded) {
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'btn soft pv-more';
        btn.style.marginTop = '8px';
        btn.textContent = 'Ver mais';
        btn.addEventListener('click', () => {
          state.pageIndex += 1;
          renderArticles();
        });
        pvArticles.parentElement.appendChild(btn);
      }
      btn.disabled = false;
      btn.style.display = '';
    } else if (btn) {
      btn.style.display = 'none';
    }
  };

  // ---------- Fluxo principal MELHORADO ----------
  const submitTema = async (temaOpt) => {
    const value = (temaOpt ?? pvTema?.value ?? '').trim();
    if (!value) return;

    // cancela requisição ativa
    if (state.inFlight) state.inFlight.abort?.();
    const controller = new AbortController();
    state.inFlight = controller;

    pvAdd(`Você: ${value}`, 'user');
    const thinking = 'Bot: analisando tendências e gerando previsões...';
    pvAdd(thinking, 'bot');
    setArticlesLoading(true);

    const submitBtn = pvForm?.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    if (pvTema) pvTema.value = '';

    try {
      const body = { tema: value, dias: state.PV_DAYS };

      const key = cacheKey(value, state.PV_DAYS);
      let data = getCache(key);

      if (!data) {
        const res = await fetchWithRetry('/prever', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        data = await res.json().catch(() => ({}));
        setCache(key, data);
      }

      if (data.erro) { pvAdd(`Bot: ${data.erro}`, 'bot'); return; }

      state.temaAtual = value;
      addHistory(value);

      // remove "pensando..." se for a última
      const last = pvLog?.lastElementChild;
      if (last && last.textContent === thinking) last.remove();

      // Processar série de dados
      const series = Array.isArray(data.series) ? data.series.slice() : [];
      series.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      state.series = series;

      // GERAR PREVISÃO
      if (series.length >= 3) {
        const forecast = forecastWithSeasonality(series, state.forecastDays);
        const confidence = calculateForecastConfidence(series, forecast);
        const predictionText = generatePredictionText(series, forecast, confidence);
        
        state.lastPrediction = {
          forecast,
          confidence,
          generatedAt: new Date().toISOString()
        };

        // Mostrar previsão
        pvAdd(`Bot: ${predictionText}`, 'bot');
        
        // Renderizar gráfico com previsão
        renderChart(series, forecast);
      } else {
        pvAdd('Bot: Dados insuficientes para gerar previsão. Necessário pelo menos 3 dias de dados.', 'bot');
        renderChart(series);
      }

      // Artigos
      state.allArticles = Array.isArray(data.artigos) ? data.artigos : [];
      state.pageIndex = 0;
      renderArticles();

    } catch (err) {
      if (err?.name === 'AbortError') {
        pvAdd('Bot: consulta anterior cancelada.', 'bot');
      } else {
        pvAdd('Bot: erro ao consultar /prever — ' + (err?.message || 'falha desconhecida'), 'bot');
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (state.inFlight === controller) state.inFlight = null;
      setArticlesLoading(false);
    }
  };

  // submit pelo form
  pvForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitTema();
  });
  
  // atalhos de teclado no input
  pvTema?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submitTema();
    }
  });

  // ---------- Boot ----------
  if (pvLog) pvLog.setAttribute('aria-live', 'polite');
  loadPrefs();
  loadHistory();
  renderHistory();

  // helpers para debug manual no console
  window.__previsoesDebug = {
    submitTema, 
    renderChart,
    forecastLinear,
    forecastWithSeasonality,
    calculateForecastConfidence,
    getState: () => ({ ...state })
  };

  // guardas de erro úteis
  window.addEventListener('error', (e) => console.error('[previsoes] onerror:', e.message, e.filename, e.lineno));
  window.addEventListener('unhandledrejection', (e) => console.error('[previsoes] unhandledrejection:', e.reason));
})();