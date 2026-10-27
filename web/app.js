const statusEl = document.getElementById('status');
const chartEl = document.getElementById('chart');
const mapEl = document.getElementById('map');

let map;

async function fetchCsv(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const [headerLine, ...rows] = text.trim().split(/\r?\n/);
    if (!headerLine) return [];
    const headers = headerLine.split(',');
    return rows.map((line) => {
      const values = line.split(',');
      const obj = {};
      headers.forEach((h, i) => (obj[h] = values[i] ?? ''));
      return obj;
    });
  } catch {
    return [];
  }
}

function ensureMap() {
  if (map) return;
  map = L.map(mapEl).setView([22.3193, 114.1694], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  L.marker([22.3193, 114.1694]).addTo(map).bindPopup('Hong Kong (reference center)').openPopup();
}

function setStatus(text) {
  statusEl.textContent = text;
}

function renderPlaceholder(title, message) {
  Plotly.newPlot(chartEl, [], {
    title,
    xaxis: { visible: false },
    yaxis: { visible: false },
    annotations: [{ text: message, x: 0.5, y: 0.5, showarrow: false, xref: 'paper', yref: 'paper' }],
    margin: { t: 50, r: 20, b: 40, l: 40 },
  }, { responsive: true });
}

async function renderStory1() {
  setStatus('Story 1: Doksuri event window (24–29 Jul 2023), hourly pollutants where available.');
  const data = await fetchCsv('../output/analysis/story1_doksuri_window.csv');
  if (!data.length) {
    renderPlaceholder('Story 1 — Tropical Cyclones and Extreme Haze', 'No compatible Story 1 dataset found yet. Run preprocessing scripts.');
    return;
  }
  const grouped = {};
  data.forEach((r) => {
    const pollutant = r.pollutant || 'Unknown';
    const station = r.station_id || 'Station unavailable';
    const key = `${pollutant}::${station}`;
    if (!grouped[key]) {
      grouped[key] = {
        x: [],
        y: [],
        type: 'scatter',
        mode: 'lines',
        name: pollutant,
        legendgroup: pollutant,
        showlegend: !Object.values(grouped).some((trace) => trace.legendgroup === pollutant),
        hovertemplate: `${pollutant} — ${station}<br>%{x}<br>%{y}<extra></extra>`,
      };
    }
    const rawValue = (r.value ?? '').trim();
    const numericValue = rawValue === '' ? null : Number(rawValue);
    grouped[key].x.push(r.datetime);
    grouped[key].y.push(Number.isFinite(numericValue) ? numericValue : null);
  });
  Plotly.newPlot(chartEl, Object.values(grouped), {
    title: 'Hourly pollutant patterns around Doksuri',
    xaxis: { title: 'Datetime' },
    yaxis: { title: 'Concentration (original units)' },
    legend: { orientation: 'h', groupclick: 'togglegroup' },
  }, { responsive: true });
}

async function renderStory2() {
  setStatus('Story 2: NO2 hourly profile by station and weekday/weekend.');
  const data = await fetchCsv('../output/analysis/story2_no2_hourly_profiles.csv');
  if (!data.length) {
    renderPlaceholder('Story 2 — Traffic and NO2', 'No compatible Story 2 dataset found yet.');
    return;
  }
  const station = data[0].station_id;
  const stationData = data.filter((r) => r.station_id === station);
  const weekday = stationData.filter((r) => r.day_type === 'weekday');
  const weekend = stationData.filter((r) => r.day_type === 'weekend');
  Plotly.newPlot(chartEl, [
    { x: weekday.map((d) => d.hour), y: weekday.map((d) => Number(d.avg_no2)), type: 'scatter', mode: 'lines+markers', name: 'Weekday' },
    { x: weekend.map((d) => d.hour), y: weekend.map((d) => Number(d.avg_no2)), type: 'scatter', mode: 'lines+markers', name: 'Weekend' },
  ], {
    title: `NO2 hourly profile (${station || 'station unavailable'})`,
    xaxis: { title: 'Hour of day' },
    yaxis: { title: 'NO2 (original units)' },
  }, { responsive: true });
}

async function renderStory3() {
  setStatus('Story 3: Seasonal pollutant averages and supporting counts.');
  const data = await fetchCsv('../output/analysis/story3_seasonal_summary.csv');
  if (!data.length) {
    renderPlaceholder('Story 3 — Seasonal Air Quality', 'No compatible Story 3 dataset found yet.');
    return;
  }

  const bySeason = {};
  data.forEach((r) => {
    const key = r.season || 'unknown';
    if (!bySeason[key]) bySeason[key] = { sum: 0, count: 0 };
    bySeason[key].sum += Number(r.mean_value || 0);
    bySeason[key].count += 1;
  });

  const seasons = Object.keys(bySeason);
  const means = seasons.map((s) => bySeason[s].count ? bySeason[s].sum / bySeason[s].count : 0);
  Plotly.newPlot(chartEl, [{ x: seasons, y: means, type: 'bar' }], {
    title: 'Average seasonal pollutant level (aggregated)',
    xaxis: { title: 'Season' },
    yaxis: { title: 'Concentration (original units)' },
  }, { responsive: true });
}

async function renderStory4() {
  const filter = document.getElementById('aqhi-station-filter');
  setStatus('Story 4: Monthly counts of daily maximum AQHI categories.');
  const data = await fetchCsv('../output/analysis/aqhi_daily_max_category_counts.csv');
  if (!data.length) {
    renderPlaceholder('Story 4 — Daily Maximum AQHI Categories', 'No compatible AQHI dataset found yet.');
    return;
  }
  const stations = [...new Set(data.map((row) => row.station_raw).filter(Boolean))].sort();
  if (filter && !filter.options.length) {
    stations.forEach((station) => {
      const option = document.createElement('option');
      option.value = station;
      option.textContent = station;
      filter.appendChild(option);
    });
  }
  const selected = filter?.value || stations[0];
  const selectedRows = data.filter((row) => row.station_raw === selected);
  const months = [...new Set(data.map((row) => row.source_month))].sort();
  const monthLabels = months.map((month) => `${month.slice(0, 4)}-${month.slice(4, 6)}`);
  // Show only the year on the axis; hover text keeps the exact month (YYYY-MM).
  const tickIndexes = months.map((month, i) => (month.endsWith('01') ? i : -1)).filter((i) => i >= 0);
  const tickvals = tickIndexes.map((i) => monthLabels[i]);
  const ticktext = tickIndexes.map((i) => months[i].slice(0, 4));
  const colours = {
    '1': '#1a9850', '2': '#66bd63', '3': '#a6d96a', '4': '#fee08b', '5': '#fdae61',
    '6': '#f46d43', '7': '#d73027', '8': '#a50026', '9': '#7b3294', '10': '#40004b', '10+': '#000000',
  };
  const axisBase = { type: 'category', tickmode: 'array', tickvals, ticktext, showgrid: false, tickfont: { size: 12 } };
  const yBase = { title: { text: 'Days (daily maximum)', font: { size: 12 } }, rangemode: 'tozero', gridcolor: '#eef1f6', zeroline: false };
  // Chart A uses the x/y axes (top); Chart B uses x2/y2 (bottom).
  const views = [
    { categories: ['1', '2', '3', '4', '5'], xaxis: 'x', yaxis: 'y', legend: 'legend' },
    { categories: ['6', '7', '8', '9', '10', '10+'], xaxis: 'x2', yaxis: 'y2', legend: 'legend2' },
  ];
  const traces = [];
  const viewHasData = views.map(() => false);
  views.forEach((view, viewIndex) => {
    ['unstarred', 'starred'].forEach((starStatus) => {
      view.categories.forEach((category) => {
        const counts = months.map((month) => {
          const row = selectedRows.find((item) =>
            item.source_month === month &&
            item.category === category &&
            item.star_status === starStatus
          );
          return row ? Number(row.category_count) : null;
        });
        const hasCounts = counts.some((count) => count !== null);
        if (hasCounts) viewHasData[viewIndex] = true;
        const isStarred = starStatus === 'starred';
        traces.push({
          x: monthLabels,
          y: counts,
          type: 'bar',
          xaxis: view.xaxis,
          yaxis: view.yaxis,
          legend: view.legend,
          name: isStarred ? `${category} (starred)` : category,
          legendgroup: category,
          showlegend: !isStarred || hasCounts,
          marker: {
            color: colours[category],
            pattern: { shape: isStarred ? '/' : '' },
          },
          hovertemplate: `Station: ${selected}<br>Month: %{x}<br>${isStarred ? 'Starred category' : 'Category'}: ${category}<br>Days: %{y}<extra></extra>`,
        });
      });
    });
  });
  const emptyAnnotations = views.map((view, viewIndex) => viewHasData[viewIndex] ? null : {
    text: `No valid AQHI daily maximum observations in this view for ${selected}.`,
    xref: `${view.xaxis} domain`,
    yref: `${view.yaxis} domain`,
    x: 0.5,
    y: 0.5,
    showarrow: false,
  }).filter(Boolean);
  const unavailableUntil = months.indexOf('202006');
  const isPartlyUnavailable = ['南區', '北區'].includes(selected) && unavailableUntil > 0;
  const unavailableShapes = [];
  const unavailableAnnotations = [];
  if (isPartlyUnavailable) {
    views.forEach((view) => {
      unavailableShapes.push({
        type: 'rect', xref: view.xaxis, yref: `${view.yaxis} domain`,
        x0: -0.5, x1: unavailableUntil - 0.5, y0: 0, y1: 1,
        fillcolor: '#cfd4de', opacity: 0.45, line: { width: 0 }, layer: 'below',
      });
      unavailableAnnotations.push({
        text: 'Not available<br>before June 2020',
        xref: view.xaxis, yref: `${view.yaxis} domain`,
        x: (unavailableUntil - 1) / 2, y: 0.5, showarrow: false,
        font: { size: 11, color: '#3b4252' },
      });
    });
  }

  // Share of valid daily maxima in category 7 or above (a summary threshold chosen here, not an official band).
  const isValidCategory = (row) => row.category === '10+' || /^(?:[1-9]|10)$/.test(row.category);
  const isHigher = (row) => row.category === '10+' || ['7', '8', '9', '10'].includes(row.category);
  const shareByStation = stations.map((station) => {
    const rows = data.filter((row) => row.station_raw === station && isValidCategory(row));
    const valid = rows.reduce((sum, row) => sum + Number(row.category_count), 0);
    const higher = rows.filter(isHigher).reduce((sum, row) => sum + Number(row.category_count), 0);
    return { station, valid, higher, share: valid ? higher / valid : null };
  }).filter((item) => item.share !== null).sort((a, b) => b.share - a.share);
  const observationEl = document.getElementById('aqhi-observation');
  if (observationEl) {
    const current = shareByStation.find((item) => item.station === selected);
    const numberEl = document.getElementById('aqhi-finding-number');
    const textEl = document.getElementById('aqhi-finding-text');
    const contextEl = document.getElementById('aqhi-finding-context');
    if (current) {
      const pct = (item) => `${(item.share * 100).toFixed(1)}%`;
      const validMonths = selectedRows.filter(isValidCategory).map((row) => row.source_month).sort();
      const fmt = (month) => `${month.slice(0, 4)}-${month.slice(4, 6)}`;
      const period = `${fmt(validMonths[0])} to ${fmt(validMonths[validMonths.length - 1])}`;
      const top = shareByStation[0];
      const bottom = shareByStation[shareByStation.length - 1];
      numberEl.textContent = `${current.higher} days · ${pct(current)}`;
      textEl.textContent =
        `${selected}, ${period}: ${current.higher} of ${current.valid} valid daily maximum AQHI records ` +
        `(${pct(current)}) were in category 7 or above, including 10+. ` +
        'Percentages use each station\'s own valid records, so they are shares of days with a valid category, not hours.';
      const excluded = selectedRows
        .filter((row) => ['missing', 'unresolved', 'unknown'].includes(row.category))
        .reduce((sum, row) => sum + Number(row.category_count), 0);
      contextEl.textContent =
        `Across stations this share ranges from ${pct(bottom)} (${bottom.station}) to ${pct(top)} (${top.station}). ` +
        `${excluded} missing, unresolved or unknown record(s) for ${selected} are excluded. ` +
        'Station coverage differs, and this does not show whether AQHI improved or worsened.';
    } else {
      numberEl.textContent = 'No valid records';
      textEl.textContent = `${selected} has no valid daily maximum AQHI records in this dataset.`;
      contextEl.textContent = '';
    }
  }
  const qualityRows = selectedRows.filter((row) =>
    ['missing', 'unresolved', 'unknown'].includes(row.category)
  );
  const qualityCount = qualityRows.reduce((sum, row) => sum + Number(row.category_count), 0);
  const unavailable = ['南區', '北區'].includes(selected)
    ? months.filter((month) => month < '202006').length
    : 0;
  if (filter) filter.onchange = () => renderStory4();
  setStatus(`Story 4: ${selected}; daily maximum categories. Quality-marked/missing records: ${qualityCount}. Unavailable pre-June 2020 months: ${unavailable}.`);
  Plotly.newPlot(chartEl, traces, {
    barmode: 'stack',
    bargap: 0.1,
    xaxis: { ...axisBase, anchor: 'y', domain: [0, 1] },
    yaxis: { ...yBase, domain: [0.55, 0.88] },
    xaxis2: { ...axisBase, anchor: 'y2', domain: [0, 1], title: { text: 'Year (hover a bar for the exact month)', font: { size: 12 } } },
    yaxis2: { ...yBase, domain: [0, 0.36] },
    legend: { orientation: 'h', x: 0, xanchor: 'left', y: 0.89, yanchor: 'bottom', font: { size: 11 } },
    legend2: { orientation: 'h', x: 0, xanchor: 'left', y: 0.37, yanchor: 'bottom', font: { size: 11 } },
    margin: { t: 8, r: 10, b: 60, l: 62 },
    shapes: unavailableShapes,
    annotations: [
      { text: `<b>Chart A — Categories 1–5</b> · ${selected}`, xref: 'paper', yref: 'paper', x: 0, y: 1, yanchor: 'top', xanchor: 'left', showarrow: false, font: { size: 13 } },
      { text: `<b>Chart B — Categories 6–10 and 10+</b> · ${selected}`, xref: 'paper', yref: 'paper', x: 0, y: 0.46, yanchor: 'top', xanchor: 'left', showarrow: false, font: { size: 13 } },
      ...unavailableAnnotations,
      ...emptyAnnotations,
    ],
  }, { responsive: true });
}

function activateStep(step) {
  document.querySelectorAll('.step').forEach((el) => el.classList.remove('is-active'));
  step.classList.add('is-active');
  const story = step.dataset.story;
  // Story 4 has no verified station coordinates, so the map is hidden to give the charts more room.
  const isStory4 = story === 'story4';
  mapEl.hidden = isStory4;
  chartEl.classList.toggle('chart--tall', isStory4);
  if (!isStory4 && map) map.invalidateSize();
  if (story === 'story1') return renderStory1();
  if (story === 'story2') return renderStory2();
  if (story === 'story3') return renderStory3();
  if (story === 'story4') return renderStory4();
  setStatus('Intro: inspect repository data first, then run preprocessing scripts.');
  renderPlaceholder('Hong Kong Air Pollution Data Storytelling', 'Scroll to enter story sections.');
}

function initObserver() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) activateStep(entry.target);
    });
  }, { threshold: 0.45 });

  document.querySelectorAll('.step').forEach((step) => observer.observe(step));
}

window.addEventListener('DOMContentLoaded', () => {
  ensureMap();
  initObserver();
  const intro = document.querySelector('.step[data-story="intro"]');
  if (intro) activateStep(intro);
});
