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
  const categories = [...Array(10)].map((_, index) => String(index + 1)).concat('10+');
  const traces = [];
  ['unstarred', 'starred'].forEach((starStatus) => {
    categories.forEach((category) => {
      traces.push({
        x: months,
        y: months.map((month) => {
          const row = selectedRows.find((item) =>
            item.source_month === month &&
            item.category === category &&
            item.star_status === starStatus
          );
          return row ? Number(row.category_count) : null;
        }),
        type: 'bar',
        name: `${category}${starStatus === 'starred' ? ' *' : ''}`,
        legendgroup: starStatus,
        visible: true,
        hovertemplate: `${selected} — ${category}${starStatus === 'starred' ? ' (starred)' : ''}<br>%{x}: %{y}<extra></extra>`,
      });
    });
  });
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
    title: `Monthly daily maximum AQHI categories — ${selected}`,
    barmode: 'group',
    xaxis: { title: 'Month' },
    yaxis: { title: 'Daily maximum observation count' },
    legend: { orientation: 'h' },
  }, { responsive: true });
}

function activateStep(step) {
  document.querySelectorAll('.step').forEach((el) => el.classList.remove('is-active'));
  step.classList.add('is-active');
  const story = step.dataset.story;
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
