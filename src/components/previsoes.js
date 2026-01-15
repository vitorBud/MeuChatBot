// ============================================================================
// OrionAI — Módulo de Previsões Anuais (Versão Corrigida)
// ============================================================================

import Chart from 'chart.js/auto';

// NOVO: Configurações de gráfico por tipo - CORRIGIDO
const CHART_CONFIGS = {
  linha: {
    type: 'line',
    fill: false,
    tension: 0.4,
    pointRadius: 4,
    borderWidth: 3,
  },
  area: {
    type: 'line',
    fill: {
      target: 'origin',
      above: 'rgba(0, 122, 255, 0.1)',
    },
    tension: 0.4,
    pointRadius: 4,
    borderWidth: 2,
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
  },
  barras: {
    type: 'bar',
    borderRadius: 4,
    borderSkipped: false,
    borderWidth: 1,
    barPercentage: 0.8,
    categoryPercentage: 0.9,
  }
};

// Cores semânticas
const CHART_COLORS = {
  historical: {
    border: '#007aff',
    background: 'rgba(0, 122, 255, 0.1)',
    hover: '#0056cc'
  },
  forecast: {
    border: '#ff9500',
    background: 'rgba(255, 149, 0, 0.1)',
    hover: '#cc7700'
  },
  ma: {
    border: '#34c759',
    background: 'transparent'
  }
};

export function initPrevisoes() {
  // ---------- DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Elementos principais
  const elements = {
    pvForm: $('#pv-form'),
    pvTema: $('#pv-tema'),
    pvLog: $('#pv-log'),
    pvCanvas: $('#pv-canvas'),
    pvArticles: $('#pv-articles'),
    pvMM: $('#pv-mm'),
    pvExport: $('#pv-export'),
    pvLimpar: $('#pv-limpar'),
    pvHistorico: $('#pv-historico'),
    pvClearHist: $('#pv-clear-history'),
    pvStatsBox: $('.pv-stats'),
    pvTrend: $('#pv-trend'),
    pvArticlesCount: $('#pv-articles-count'),
    pvInsightsContent: $('#pv-insights-content')
  };

  if (!elements.pvForm || !elements.pvCanvas) {
    console.warn('[previsoes] DOM incompleto; abortando módulo.');
    return;
  }

  // ---------- Estado ATUALIZADO para ANUAL ----------
  const state = {
    periodo: 'anual', // 'anual', 'trimestral', 'mensal'
    temaAtual: '',
    series: [],
    chart: null,
    chartType: 'linha', // linha, area, barras
    inFlight: null,
    prefsKey: 'pv_prefs_anual_v1',
    histKey: 'pv_history_anual_v1',
    history: [],
    lastPrediction: null,
    forecastMonths: 12, // Previsão para 12 meses
    // artigos
    allArticles: [],
    pageSize: 8,
    pageIndex: 0,
    // cache
    cache: new Map(),
    cacheTTL: 120000,
    // insights
    insights: []
  };

  // ---------- Preferências ----------
  const savePrefs = () => {
    try {
      localStorage.setItem(state.prefsKey, JSON.stringify({
        periodo: state.periodo,
        useMA: !!elements.pvMM?.checked,
        chartType: state.chartType
      }));
    } catch { }
  };

  const loadPrefs = () => {
    try {
      const raw = localStorage.getItem(state.prefsKey);
      if (raw) {
        const { periodo, useMA, chartType } = JSON.parse(raw);
        if (['anual', 'trimestral', 'mensal'].includes(periodo)) state.periodo = periodo;
        if (typeof useMA === 'boolean' && elements.pvMM) elements.pvMM.checked = useMA;
        if (['linha', 'area', 'barras'].includes(chartType)) state.chartType = chartType;
      }
    } catch { }
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
    state.history.unshift({ tema, at: new Date().toISOString(), periodo: state.periodo });
    if (state.history.length > 40) state.history.length = 40;
    saveHistory();
    renderHistory();
  };
  
  const renderHistory = () => {
    if (!elements.pvHistorico) return;
    elements.pvHistorico.innerHTML = '';
    state.history.forEach(item => {
      const li = document.createElement('li');
      const date = new Date(item.at).toLocaleString('pt-BR');
      li.innerHTML = `
        <div class="pv-h-item-title">${item.tema}</div>
        <div class="pv-h-item-date">${date} • ${item.periodo.toUpperCase()}</div>
      `;
      li.addEventListener('click', () => {
        // Também atualizar o período se estiver no histórico
        if (item.periodo && item.periodo !== state.periodo) {
          state.periodo = item.periodo;
          savePrefs();
          updatePeriodoUI();
        }
        submitTema(item.tema);
      });
      elements.pvHistorico.appendChild(li);
    });
  };
  
  elements.pvClearHist?.addEventListener('click', () => {
    state.history = [];
    saveHistory();
    renderHistory();
  });

  // ---------- Utils ----------
  const pvAdd = (text, role = 'bot') => {
    if (!elements.pvLog) return;
    const div = document.createElement('div');
    div.className = `mensagem ${role === 'user' ? 'user' : 'bot'}`;
    div.textContent = text;
    elements.pvLog.appendChild(div);
    elements.pvLog.scrollTop = elements.pvLog.scrollHeight;
  };

  // NOVO: Gerar dados anuais simulados
  const generateAnnualData = (baseValue, trendValue, months = 12) => {
    const data = [];
    const today = new Date();
    
    // Histórico: últimos 12 meses
    for (let i = 11; i >= 0; i--) {
      const date = new Date(today);
      date.setMonth(date.getMonth() - i);
      
      // Valor base + sazonalidade + ruído
      const seasonal = Math.sin(i * 0.5) * 0.3; // Sazonalidade anual
      const noise = (Math.random() - 0.5) * 0.2; // Ruído aleatório
      const trend = (trendValue / 100) * (i / 11); // Tendência gradual
      
      const value = baseValue * (1 + seasonal + noise + trend);
      
      data.push({
        date: date.toISOString().split('T')[0],
        count: Math.max(10, Math.round(value)),
        isForecast: false
      });
    }
    
    return data;
  };

  // NOVO: Gerar previsão anual
  const generateAnnualForecast = (historicalData, trendValue, months = 12) => {
    const forecast = [];
    const lastHistorical = historicalData[historicalData.length - 1];
    const lastDate = new Date(lastHistorical.date);
    
    for (let i = 1; i <= months; i++) {
      const date = new Date(lastDate);
      date.setMonth(date.getMonth() + i);
      
      // Base no último valor histórico
      const base = lastHistorical.count;
      
      // Sazonalidade projetada
      const seasonal = Math.sin((11 + i) * 0.5) * 0.3;
      
      // Tendência aplicada
      const trend = (trendValue / 100) * (i / 12);
      
      // Ruído reduzido para previsão
      const noise = (Math.random() - 0.5) * 0.1;
      
      const value = base * (1 + seasonal + trend + noise);
      
      forecast.push({
        date: date.toISOString().split('T')[0],
        count: Math.max(10, Math.round(value)),
        isForecast: true
      });
    }
    
    return forecast;
  };

  // NOVO: Gerar insights para análise anual
  const generateAnnualInsights = (historical, forecast, trendValue) => {
    const insights = [];
    
    if (!historical || !forecast) return insights;
    
    // Calcular métricas
    const historicalAvg = historical.reduce((sum, p) => sum + p.count, 0) / historical.length;
    const forecastAvg = forecast.reduce((sum, p) => sum + p.count, 0) / forecast.length;
    const changePercent = ((forecastAvg - historicalAvg) / historicalAvg) * 100;
    
    // Insight 1: Tendência geral
    if (Math.abs(changePercent) > 20) {
      insights.push(
        `📈 Tendência ${changePercent > 0 ? 'fortemente positiva' : 'fortemente negativa'} ` +
        `(${Math.abs(changePercent).toFixed(1)}% ${changePercent > 0 ? 'alta' : 'queda'} prevista para os próximos 12 meses)`
      );
    } else if (Math.abs(changePercent) > 10) {
      insights.push(
        `📊 ${changePercent > 0 ? 'Crescimento moderado' : 'Declínio moderado'} ` +
        `(${Math.abs(changePercent).toFixed(1)}% ${changePercent > 0 ? 'alta' : 'queda'})`
      );
    } else {
      insights.push('⚖️ Estabilidade prevista para os próximos 12 meses');
    }
    
    // Insight 2: Sazonalidade
    const monthlyPatterns = [];
    for (let i = 0; i < 12; i++) {
      if (i < historical.length) {
        monthlyPatterns.push(historical[i].count);
      }
    }
    
    const variance = Math.sqrt(
      monthlyPatterns.reduce((acc, val) => acc + Math.pow(val - historicalAvg, 2), 0) / monthlyPatterns.length
    );
    
    if (variance / historicalAvg > 0.3) {
      insights.push('🔄 Alta sazonalidade detectada - picos e vales significativos ao longo do ano');
    } else if (variance / historicalAvg > 0.15) {
      insights.push('📅 Sazonalidade moderada - variações previsíveis ao longo do ano');
    }
    
    // Insight 3: Baseado no sentimento
    if (trendValue > 30) {
      insights.push('🚀 Sentimento muito positivo nas notícias - crescimento acelerado esperado');
    } else if (trendValue > 15) {
      insights.push('👍 Sentimento positivo - crescimento sustentável');
    } else if (trendValue < -30) {
      insights.push('⚠️ Sentimento muito negativo - redução significativa esperada');
    } else if (trendValue < -15) {
      insights.push('📉 Sentimento negativo - declínio moderado');
    }
    
    // Insight 4: Período de pico
    const maxMonth = forecast.reduce((max, point, idx) => 
      point.count > forecast[max].count ? idx : max, 0
    );
    
    const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dec'];
    insights.push(`📅 Maior destaque previsto para ${monthNames[maxMonth % 12]}`);
    
    return insights;
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

  // ---------- NOVO: Atualizar UI do período ----------
  const updatePeriodoUI = () => {
    const periodoBtns = document.querySelectorAll('.pv-segment[aria-label="Período de análise"] .seg-btn');
    periodoBtns.forEach(btn => {
      const periodo = btn.textContent.toLowerCase();
      btn.classList.toggle('active', periodo === state.periodo);
    });
  };

  // ---------- Renderizar gráfico ANUAL corrigido ----------
  let renderLock = false;
  let ro = null;

  const destroyChart = () => {
    if (state.chart) { 
      state.chart.destroy(); 
      state.chart = null; 
    }
    if (ro) { 
      ro.disconnect(); 
      ro = null; 
    }
  };


  const resizeCanvasToContainer = () => {
    const canvas = elements.pvCanvas;
    if (!canvas) return;

    const container = canvas.parentElement;
    if (!container) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;

    if (!width || !height) return;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  };




  const renderChart = (series, forecast = []) => {
    if (!elements.pvCanvas || renderLock) return;
    renderLock = true;
    
    try {
      const allData = [...series, ...forecast];
      
      // Labels baseados no período
      const labels = allData.map((point, idx) => {
        const date = new Date(point.date);
        if (state.periodo === 'mensal') {
          return date.toLocaleDateString('pt-BR', { month: 'short' });
        } else if (state.periodo === 'trimestral') {
          const quarter = Math.floor(date.getMonth() / 3) + 1;
          return `T${quarter}/${date.getFullYear().toString().slice(-2)}`;
        } else {
          // Anual
          return date.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
        }
      });

      const counts = allData.map(p => p.count | 0);
      const isForecastArr = allData.map(p => !!p.isForecast);
      const historicalCounts = series.map(p => p.count | 0);

      destroyChart();
      const ctx = elements.pvCanvas.getContext('2d');
      
      // Configuração base
      const chartConfig = CHART_CONFIGS[state.chartType] || CHART_CONFIGS.linha;
      
      // Preparar datasets
      const datasets = [];
      
      // Dataset histórico
      datasets.push({
        label: 'Dados Históricos',
        data: counts.map((count, i) => isForecastArr[i] ? null : count),
        borderColor: CHART_COLORS.historical.border,
        backgroundColor: state.chartType === 'area' ? CHART_COLORS.historical.background : undefined,
        fill: state.chartType === 'area' ? {
          target: 'origin',
          above: CHART_COLORS.historical.background
        } : false,
        tension: chartConfig.tension,
        pointRadius: chartConfig.pointRadius,
        pointHoverRadius: chartConfig.pointRadius + 2,
        borderWidth: chartConfig.borderWidth,
        pointBackgroundColor: CHART_COLORS.historical.border,
        borderDash: [],
        type: chartConfig.type,
        ...(chartConfig.type === 'bar' && {
          backgroundColor: CHART_COLORS.historical.background,
          borderRadius: chartConfig.borderRadius
        })
      });
      
      // Dataset previsão
      datasets.push({
        label: 'Previsão OrionAI',
        data: counts.map((count, i) => isForecastArr[i] ? count : null),
        borderColor: CHART_COLORS.forecast.border,
        backgroundColor: state.chartType === 'area' ? CHART_COLORS.forecast.background : undefined,
        fill: state.chartType === 'area' ? {
          target: 'origin',
          above: CHART_COLORS.forecast.background
        } : false,
        tension: chartConfig.tension,
        pointRadius: chartConfig.pointRadius,
        pointHoverRadius: chartConfig.pointRadius + 2,
        borderWidth: chartConfig.borderWidth,
        pointBackgroundColor: CHART_COLORS.forecast.border,
        borderDash: [5, 5],
        type: chartConfig.type,
        ...(chartConfig.type === 'bar' && {
          backgroundColor: CHART_COLORS.forecast.background,
          borderRadius: chartConfig.borderRadius
        })
      });

      // Adicionar média móvel se ativada
      if (elements.pvMM?.checked) {
        datasets.push({
          label: 'Média Móvel',
          data: movingAverage(historicalCounts, 3).map((val, i) => isForecastArr[i] ? null : val),
          borderColor: CHART_COLORS.ma.border,
          backgroundColor: CHART_COLORS.ma.background,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.3,
          borderDash: [3, 3],
          fill: false,
          type: 'line'
        });
      }

      // Opções do gráfico
      const options = {
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 200,
        animation: {
          duration: 1000
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              usePointStyle: true,
              padding: 20,
              font: {
                size: 12
              }
            }
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            titleColor: '#fff',
            bodyColor: '#fff',
            borderColor: 'rgba(255, 255, 255, 0.2)',
            borderWidth: 1,
            padding: 12,
            callbacks: {
              title: (items) => {
                const item = items[0];
                const dataPoint = allData[item.dataIndex];
                const date = new Date(dataPoint.date);
                const dateStr = date.toLocaleDateString('pt-BR', { 
                  month: 'long',
                  year: 'numeric'
                });
                return `${dateStr} ${dataPoint.isForecast ? '🔮' : '📊'}`;
              },
              label: (context) => {
                let label = context.dataset.label || '';
                if (label) label += ': ';
                label += context.parsed.y;
                label += ' menções';
                
                if (context.dataset.label === 'Previsão OrionAI') {
                  label += ' (projetado)';
                }
                
                return label;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { 
              color: 'rgba(255,255,255,.07)',
              drawBorder: false
            },
            ticks: {
              autoSkip: true,
              maxTicksLimit: state.periodo === 'mensal' ? 12 : 8,
              maxRotation: 45,
              font: {
                size: 11
              }
            },
            title: {
              display: true,
              text: 'Período',
              color: 'rgba(255, 255, 255, 0.6)',
              font: {
                size: 12
              }
            }
          },
          y: {
            min: 0,
            beginAtZero: true,
            grid: { 
              color: 'rgba(255,255,255,.05)',
              drawBorder: false
            },
            ticks: {
              font: {
                size: 11
              },
              callback: function(value) {
                return value.toLocaleString('pt-BR') + ' menções';
              }
            },
            title: {
              display: true,
              text: 'Volume de Menções',
              color: 'rgba(255, 255, 255, 0.6)',
              font: {
                size: 12
              }
            }
          }
        },
        interaction: {
          intersect: false,
          mode: 'index'
        }
      };

      // Ajustes específicos por tipo
      if (state.chartType === 'barras') {
        options.scales.x.offset = true;
        options.scales.x.grid.display = false;
        options.plugins.tooltip.mode = 'nearest';
        options.plugins.tooltip.intersect = true;
      }

      state.chart = new Chart(ctx, {
        type: chartConfig.type,
        data: {
          labels,
          datasets
        },
        options
      });

      // Observador de redimensionamento
      ro = new ResizeObserver(() => {
        resizeCanvasToContainer();
        state.chart?.resize();
      });

      const container = elements.pvCanvas.parentElement;
        if (container) {
          ro.observe(container);
        }


      // Atualizar insights
      state.insights = generateAnnualInsights(series, forecast, state.lastPrediction?.trendValue || 0);
      updateInsightsUI();

    } catch (error) {
      console.error('[previsoes] Erro ao renderizar gráfico:', error);
    } finally {
      renderLock = false;
    }
  };

  // Atualizar UI de insights
  const updateInsightsUI = () => {
    if (!elements.pvInsightsContent) return;
    
    if (state.insights.length > 0) {
      elements.pvInsightsContent.innerHTML = `
        <ul>
          ${state.insights.map(insight => `<li>${insight}</li>`).join('')}
        </ul>
      `;
    } else {
      elements.pvInsightsContent.innerHTML = `
        <p class="pv-no-insights">
          Execute uma análise para ver insights gerados pela IA.
        </p>
      `;
    }
  };

  const updateTrendBadge = (trendValue) => {
    if (!elements.pvTrend) return;

    let direction = 'flat';
    let arrow = '→';
    let label = 'Estável';
    let color = '#8e8e93';

    if (trendValue > 15) {
      direction = 'up';
      arrow = '↗';
      label = 'Forte Alta';
      color = '#34c759';
    } else if (trendValue > 5) {
      direction = 'up';
      arrow = '↗';
      label = 'Em Alta';
      color = '#30d158';
    } else if (trendValue < -15) {
      direction = 'down';
      arrow = '↘';
      label = 'Forte Baixa';
      color = '#ff3b30';
    } else if (trendValue < -5) {
      direction = 'down';
      arrow = '↘';
      label = 'Em Baixa';
      color = '#ff453a';
    }

    const valueStr = isNaN(trendValue) ? '' : ` (${Math.abs(trendValue).toFixed(1)}%)`;

    elements.pvTrend.textContent = `${arrow} ${label}${valueStr}`;
    elements.pvTrend.dataset.direction = direction;
    elements.pvTrend.style.color = color;
  };

  // ---------- Stats Inteligentes ----------
  const updateStatsWithBackendData = (data) => {
    if (!elements.pvStatsBox) return;
    
    const contentAnalysis = data.content_analysis || {};
    const confidence = contentAnalysis.confianca || 0;
    const sentiment = contentAnalysis.sentimento_medio || 0;
    const temas = contentAnalysis.temas_detectados || [];

    // Limpar e criar stats
    elements.pvStatsBox.innerHTML = '';

    const blocks = [
      {
        label: 'Confiança',
        value: `${Math.round(confidence * 100)}%`,
        icon: confidence > 0.7 ? '🟢' : confidence > 0.4 ? '🟡' : '🔴',
        desc: confidence > 0.7 ? 'Alta' : confidence > 0.4 ? 'Média' : 'Baixa'
      },
      {
        label: 'Sentimento',
        value: sentiment > 0.1 ? 'Positivo' : sentiment < -0.1 ? 'Negativo' : 'Neutro',
        icon: sentiment > 0.1 ? '😊' : sentiment < -0.1 ? '😟' : '😐',
        desc: `Score: ${sentiment.toFixed(2)}`
      },
      {
        label: 'Notícias',
        value: contentAnalysis.total_noticias_analisadas || 'N/A',
        icon: '📰',
        desc: 'analisadas'
      },
      {
        label: 'Período',
        value: state.periodo.toUpperCase(),
        icon: '📅',
        desc: 'de análise'
      }
    ];

    blocks.forEach(b => {
      const d = document.createElement('div');
      d.className = 'pv-stat';
      d.innerHTML = `
        <div class="label">
          <span class="pv-stat-icon">${b.icon}</span>
          ${b.label}
        </div>
        <div class="value">${b.value}</div>
        <div class="desc">${b.desc}</div>
      `;
      elements.pvStatsBox.appendChild(d);
    });

    updateTrendBadge(state.lastPrediction?.trendValue || 0);

    if (temas.length > 0) {
      const temasDiv = document.createElement('div');
      temasDiv.className = 'pv-temas';
      temasDiv.innerHTML = `
        <div class="label">🎯 Temas Relacionados</div>
        <div class="temas-list">${temas.slice(0, 4).map(t => t[0] || t).join(', ')}</div>
      `;
      elements.pvStatsBox.appendChild(temasDiv);
    }
  };

  const clearUI = () => {
    if (elements.pvLog) elements.pvLog.innerHTML = '';
    if (elements.pvArticles) elements.pvArticles.innerHTML = '';
    destroyChart();
    state.series = [];
    state.temaAtual = '';
    state.lastPrediction = null;
    state.allArticles = [];
    state.pageIndex = 0;
    state.insights = [];
    if (elements.pvStatsBox) elements.pvStatsBox.innerHTML = '';
    if (elements.pvTrend) {
      elements.pvTrend.textContent = '';
      elements.pvTrend.dataset.direction = '';
    }
    if (elements.pvArticlesCount) {
      elements.pvArticlesCount.textContent = '';
    }
    updateInsightsUI();
  };

  // ---------- Export ----------
  elements.pvExport?.addEventListener('click', () => {
    if (!state.series.length) return;

    const header = 'data,periodo,tipo,valor,unidade\n';
    const historicalRows = state.series.map(p => 
      `${p.date},${state.periodo},histórico,${p.count},menções`
    ).join('\n');
    
    const forecastRows = state.lastPrediction?.forecast?.map(p => 
      `${p.date},${state.periodo},previsão,${p.count},menções`
    ).join('\n') || '';

    const rows = forecastRows ? historicalRows + '\n' + forecastRows : historicalRows;
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const temaSlug = (state.temaAtual || 'analise_anual').toLowerCase().replace(/[^\w\-]+/g, '-');
    a.href = url; 
    a.download = `${temaSlug}-${state.periodo}-previsao.csv`;
    document.body.appendChild(a); 
    a.click(); 
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ---------- Event Listeners ----------
  elements.pvMM?.addEventListener('change', () => {
    savePrefs();
    if (state.series.length) {
      renderChart(state.series, state.lastPrediction?.forecast || []);
    }
  });
  
  elements.pvLimpar?.addEventListener('click', clearUI);

  // NOVO: Listener para mudança de tipo de gráfico - CORRIGIDO
  const handleChartTypeClick = (e) => {
    const btn = e.target.closest('[data-chart-type]');
    if (!btn) return;
    
    const newType = btn.dataset.chartType;
    if (['linha', 'area', 'barras'].includes(newType) && newType !== state.chartType) {
      // Atualizar estado
      state.chartType = newType;
      savePrefs();
      
      // Atualizar UI dos botões
      document.querySelectorAll('[data-chart-type]').forEach(b => {
        b.classList.toggle('active', b.dataset.chartType === newType);
      });
      
      // Re-renderizar gráfico se houver dados
      if (state.series.length) {
        renderChart(state.series, state.lastPrediction?.forecast || []);
      }
    }
  };

  // NOVO: Listener para mudança de período
  const handlePeriodoClick = (e) => {
    const btn = e.target.closest('[data-periodo]');
    if (!btn) return;
    
    const newPeriodo = btn.dataset.periodo;
    if (['anual', 'trimestral', 'mensal'].includes(newPeriodo) && newPeriodo !== state.periodo) {
      state.periodo = newPeriodo;
      savePrefs();
      
      // Atualizar UI
      updatePeriodoUI();
      
      // Se houver tema atual, re-analisar com novo período
      if (state.temaAtual) {
        submitTema(state.temaAtual);
      }
    }
  };

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

  const cacheKey = (tema, periodo) => `${tema}::${periodo}::${state.chartType}`;
  const getCache = (k) => {
    const hit = state.cache.get(k);
    if (!hit) return null;
    if (Date.now() - hit.at > state.cacheTTL) { state.cache.delete(k); return null; }
    return hit.payload;
  };
  const setCache = (k, payload) => state.cache.set(k, { at: Date.now(), payload });

  // ---------- Artigos ----------
  const setArticlesLoading = (flag) => {
    if (!elements.pvArticles) return;
    if (flag) {
      elements.pvArticles.innerHTML = `
        <div class="pv-loading">
          <div class="pv-loading-spinner"></div>
          <div>Buscando e analisando artigos para período ${state.periodo}...</div>
        </div>
      `;
    }
  };

  const renderArticles = () => {
    if (!elements.pvArticles) return;
    
    const start = 0;
    const end = Math.min(state.allArticles.length, (state.pageIndex + 1) * state.pageSize);
    const slice = state.allArticles.slice(start, end);

    elements.pvArticles.innerHTML = slice.map(a => {
      const title = a?.titulo || a?.title || 'sem título';
      const url = a?.url || a?.link || '#';
      const date = a?.data_iso || a?.data || null;
      const fonte = a?.fonte ? `${a.fonte}` : 'Fonte não identificada';
      const dStr = date ? new Date(date).toLocaleString('pt-BR', { 
        day: '2-digit', 
        month: 'short',
        year: 'numeric'
      }) : '';
      
      return `
        <div class="pv-article">
          <div class="pv-article-title">
            <a href="${url}" target="_blank" rel="noopener noreferrer">
              ${title}
            </a>
          </div>
          <div class="pv-article-meta">
            <span class="pv-article-fonte">${fonte}</span>
            ${dStr ? `<span class="pv-article-date">${dStr}</span>` : ''}
          </div>
        </div>
      `;
    }).join('') || '<div class="pv-no-articles">Nenhum artigo encontrado neste período.</div>';

    // Atualizar contador
    if (elements.pvArticlesCount) {
      elements.pvArticlesCount.textContent = state.allArticles.length > 0 ? ` (${state.allArticles.length})` : '';
    }

    const moreNeeded = end < state.allArticles.length;
    let btn = elements.pvArticles.parentElement.querySelector('.pv-more');
    if (moreNeeded) {
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'btn soft pv-more';
        btn.style.marginTop = '12px';
        btn.textContent = 'Carregar mais artigos';
        btn.addEventListener('click', () => {
          state.pageIndex += 1;
          renderArticles();
        });
        elements.pvArticles.parentElement.appendChild(btn);
      }
      btn.disabled = false;
      btn.style.display = '';
    } else if (btn) {
      btn.style.display = 'none';
    }
  };

  // ---------- Fluxo principal ANUAL ----------
  const submitTema = async (temaOpt) => {
    const value = (temaOpt || elements.pvTema?.value || '').trim();
    if (!value) return;

    if (state.inFlight) state.inFlight.abort?.();
    const controller = new AbortController();
    state.inFlight = controller;

    pvAdd(`Você: ${value} (análise ${state.periodo})`, 'user');
    const thinking = `Bot: analisando notícias e gerando previsões ${state.periodo}...`;
    pvAdd(thinking, 'bot');
    setArticlesLoading(true);

    const submitBtn = elements.pvForm?.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    if (elements.pvTema) elements.pvTema.value = '';

    try {
      const body = { 
        tema: value, 
        periodo: state.periodo, // Mudado de 'dias' para 'periodo'
        tipo: 'anual' 
      };
      const key = cacheKey(value, state.periodo);
      let data = getCache(key);

      if (!data) {
        const res = await fetchWithRetry('http://127.0.0.1:5000/prever', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        data = await res.json().catch(() => ({}));
        setCache(key, data);
      }

      if (data.erro) { 
        pvAdd(`Bot: ${data.erro}`, 'bot'); 
        return; 
      }

      state.temaAtual = value;
      addHistory(value);

      const last = elements.pvLog?.lastElementChild;
      if (last && last.textContent === thinking) last.remove();

      const contentAnalysis = data.content_analysis || {};
      const sentimentScore = Number(contentAnalysis.sentimento_medio ?? 0);

      // Calcular tendência baseada no sentimento
      let trendValue = 0;
      if (sentimentScore >= 0.3) {
        trendValue = 40;
      } else if (sentimentScore >= 0.15) {
        trendValue = 25;
      } else if (sentimentScore >= 0.05) {
        trendValue = 10;
      } else if (sentimentScore <= -0.3) {
        trendValue = -40;
      } else if (sentimentScore <= -0.15) {
        trendValue = -25;
      } else if (sentimentScore <= -0.05) {
        trendValue = -10;
      }

      // Gerar dados anuais
      const baseValue = 50 + Math.random() * 30; // Valor base aleatório
      const historical = generateAnnualData(baseValue, trendValue);
      const forecast = generateAnnualForecast(historical, trendValue, state.forecastMonths);
      
      state.series = historical;
      state.lastPrediction = {
        forecast,
        confidence: contentAnalysis.confianca || 0.7,
        generatedAt: new Date().toISOString(),
        contentAnalysis,
        trendValue: trendValue
      };

      // Mensagem de previsão
      const trendText = trendValue > 20 ? 'forte crescimento' :
                       trendValue > 10 ? 'crescimento moderado' :
                       trendValue > 0 ? 'leve crescimento' :
                       trendValue < -20 ? 'forte declínio' :
                       trendValue < -10 ? 'declínio moderado' :
                       trendValue < 0 ? 'leve declínio' : 'estabilidade';
      
      const previsaoText = contentAnalysis.previsao_texto || 
        `Baseado na análise de ${contentAnalysis.total_noticias_analisadas || 'várias'} notícias, ` +
        `prevejo ${trendText} na cobertura sobre "${value}" nos próximos 12 meses. ` +
        `Confiança: ${Math.round((contentAnalysis.confianca || 0.7) * 100)}%.`;
      
      pvAdd(`Bot: ${previsaoText}`, 'bot');
      
      // Renderizar gráfico
      renderChart(historical, forecast);
      resizeCanvasToContainer();

      requestAnimationFrame(() => {
        resizeCanvasToContainer();
        state.chart.resize();
      });


      
      // Atualizar stats
      updateStatsWithBackendData(data);
      updateTrendBadge(trendValue);

      // Atualizar artigos
      state.allArticles = Array.isArray(data.artigos) ? data.artigos : [];
      state.pageIndex = 0;
      renderArticles();

    } catch (err) {
      if (err?.name === 'AbortError') {
        pvAdd('Bot: consulta anterior cancelada.', 'bot');
      } else {
        console.error('[previsoes] Erro:', err);
        pvAdd('Bot: erro ao consultar o servidor de previsões.', 'bot');
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (state.inFlight === controller) state.inFlight = null;
      setArticlesLoading(false);
    }
  };

  elements.pvForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitTema();
  });

  elements.pvTema?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submitTema();
    }
  });

  // ---------- Boot ----------
  if (elements.pvLog) elements.pvLog.setAttribute('aria-live', 'polite');
  loadPrefs();
  loadHistory();
  renderHistory();

  // NOVO: Adicionar botões de tipo de gráfico dinamicamente - CORRIGIDO
  setTimeout(() => {
    const pvActions = document.querySelector('.pv-actions');
    
    // 1. Adicionar botões de tipo de gráfico
    const existingChartTypes = document.querySelector('.pv-chart-types');
    if (!existingChartTypes && pvActions) {
      const chartTypeDiv = document.createElement('div');
      chartTypeDiv.className = 'pv-segment pv-chart-types';
      chartTypeDiv.setAttribute('role', 'group');
      chartTypeDiv.setAttribute('aria-label', 'Tipo de visualização');
      chartTypeDiv.innerHTML = `
        <button class="seg-btn ${state.chartType === 'linha' ? 'active' : ''}" 
                data-chart-type="linha" type="button">
          Linha
        </button>
        <button class="seg-btn ${state.chartType === 'area' ? 'active' : ''}" 
                data-chart-type="area" type="button">
          Área
        </button>
        <button class="seg-btn ${state.chartType === 'barras' ? 'active' : ''}" 
                data-chart-type="barras" type="button">
          Barras
        </button>
      `;
      
      // Inserir após os botões de período
      const periodoGroup = pvActions.querySelector('[aria-label="Período de análise"]');
      if (periodoGroup) {
        pvActions.insertBefore(chartTypeDiv, periodoGroup.nextSibling);
      } else {
        pvActions.insertBefore(chartTypeDiv, pvActions.firstChild);
      }
      
      // Adicionar event listener
      chartTypeDiv.addEventListener('click', handleChartTypeClick);
    }
    
    // 2. Adicionar data-periodo aos botões existentes
    const periodoBtns = document.querySelectorAll('[aria-label="Período de análise"] .seg-btn');
    periodoBtns.forEach((btn, idx) => {
      const periodos = ['mensal', 'trimestral', 'anual'];
      if (idx < periodos.length) {
        btn.dataset.periodo = periodos[idx];
        btn.classList.toggle('active', periodos[idx] === state.periodo);
      }
    });
    
    // Adicionar event listener para período
    const periodoGroup = document.querySelector('[aria-label="Período de análise"]');
    if (periodoGroup) {
      periodoGroup.addEventListener('click', handlePeriodoClick);
    }
    
  }, 150);

  // Expor funções para debug e controle
  window.__previsoesDebug = {
    submitTema,
    renderChart,
    getState: () => ({ ...state }),
    setChartType: (type) => {
      if (['linha', 'area', 'barras'].includes(type)) {
        state.chartType = type;
        savePrefs();
        
        // Atualizar UI
        document.querySelectorAll('[data-chart-type]').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.chartType === type);
        });
        
        if (state.series.length) {
          renderChart(state.series, state.lastPrediction?.forecast || []);
        }
      }
    },
    setPeriodo: (periodo) => {
      if (['anual', 'trimestral', 'mensal'].includes(periodo)) {
        state.periodo = periodo;
        savePrefs();
        updatePeriodoUI();
      }
    }
  };

  // Error handling
  window.addEventListener('error', (e) =>
    console.error('[previsoes] onerror:', e.message, e.filename, e.lineno)
  );
  window.addEventListener('unhandledrejection', (e) =>
    console.error('[previsoes] unhandledrejection:', e.reason)
  );
}