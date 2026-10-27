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

const STORY1_BASE = '../output/analysis/story1/';
const STORY1_COLORS = { low: '#1f6fb2', high: '#c8553d', neutral: '#7a8699' };
const STORY1_POLLUTANT_ORDER = ['NO2', 'O3', 'RSP', 'FSP'];
const STORY1_ROLE_LABELS = {
  primary_24h: 'Primary 24 h analysis (main result)',
  timing_sensitivity: 'Timing check (hour-bin shift)',
  transparency_only_48h_all_events: '48 h, all events: transparency only (not the main sensitivity result)',
  sensitivity_48h_full_windows_only: '48 h, full-window events only: main 48 h sensitivity',
};
let story1Loaded = null;
let story1ControlsReady = false;

async function fetchStory1Json(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return null;
  }
}

function loadStory1() {
  if (!story1Loaded) {
    story1Loaded = Promise.all([
      fetchCsv(`${STORY1_BASE}story1_events.csv`),
      fetchCsv(`${STORY1_BASE}story1_timeline_segments.csv`),
      fetchCsv(`${STORY1_BASE}story1_unit_medians.csv`),
      fetchCsv(`${STORY1_BASE}story1_pairs.csv`),
      fetchCsv(`${STORY1_BASE}story1_period_medians.csv`),
      fetchCsv(`${STORY1_BASE}story1_baseline_windows.csv`),
      fetchCsv(`${STORY1_BASE}story1_sensitivity_summary.csv`),
      fetchStory1Json(`${STORY1_BASE}story1_validation_summary.json`),
    ]).then(([events, segments, units, pairs, periods, windows, sensitivity, validation]) => ({
      events, segments, units, pairs, periods, windows, sensitivity, validation,
    }));
  }
  return story1Loaded;
}

function story1Number(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function story1Iso(value) {
  return String(value).replace(' ', 'T');
}

function story1Distinct(rows, key) {
  return new Set(rows.map((r) => r[key])).size;
}

function story1Placeholder(el, message) {
  Plotly.newPlot(el, [], {
    xaxis: { visible: false },
    yaxis: { visible: false },
    annotations: [{ text: message, x: 0.5, y: 0.5, showarrow: false, xref: 'paper', yref: 'paper' }],
    margin: { t: 20, r: 20, b: 20, l: 20 },
  }, { responsive: true });
}

function story1Table(headers, rows) {
  const table = document.createElement('table');
  table.className = 'story1-table';
  const headRow = table.createTHead().insertRow();
  headers.forEach((h) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = h;
    headRow.appendChild(th);
  });
  const body = table.createTBody();
  rows.forEach((cells) => {
    const tr = body.insertRow();
    cells.forEach((c) => { tr.insertCell().textContent = c ?? ''; });
  });
  return table;
}

function renderStory1Timeline(data) {
  if (!data.events.length || !data.segments.length) {
    renderPlaceholder('Story 1 — Warning-signal timeline', 'Story 1 timeline outputs not found. Run scripts/story1_analysis.py.');
    return;
  }
  const labels = new Map(data.events.map((e) => [e.event_id, `${e.event_id} · ${e.storm_name}`]));
  // Plotly draws category axes bottom-up, so reversing puts E01 at the top.
  const categories = data.events.map((e) => labels.get(e.event_id)).reverse();
  const traces = ['low', 'high'].map((group) => {
    const x = [];
    const y = [];
    const text = [];
    data.segments.filter((s) => s.signal_group === group).forEach((s) => {
      const label = labels.get(s.event_id) ?? s.event_id;
      const hover = `${label}<br>Signal ${s.signal_label}<br>${s.start} to ${s.end}<br>${s.duration_minutes} minutes`;
      x.push(story1Iso(s.start), story1Iso(s.end), null);
      y.push(label, label, null);
      text.push(hover, hover, '');
    });
    return {
      type: 'scatter',
      mode: 'lines+markers',
      name: group === 'low' ? 'Lower signals (1, 3)' : 'Higher signals (8, 9, 10)',
      x,
      y,
      text,
      hoverinfo: 'text',
      line: { color: STORY1_COLORS[group], width: 10 },
      marker: { color: STORY1_COLORS[group], size: 4 },
    };
  });
  Plotly.newPlot(chartEl, traces, {
    title: 'HKO tropical cyclone warning-signal intervals by event',
    xaxis: { type: 'date', title: 'Time as recorded in HKO workbook (HKT assumed; not independently verified)' },
    yaxis: { type: 'category', categoryorder: 'array', categoryarray: categories, automargin: true },
    legend: { orientation: 'h' },
    margin: { t: 50, r: 20, b: 60, l: 20 },
  }, { responsive: true });
}

function renderStory1Groups(data, pollutant) {
  const el = document.getElementById('story1-group-chart');
  const note = document.getElementById('story1-group-note');
  const all = data.units.filter((u) => u.pollutant === pollutant);
  const usable = all.filter((u) => u.retained_75 === 'True' && story1Number(u.median) !== null);
  const groups = [
    { key: 'low', label: 'Lower (1, 3)' },
    { key: 'high', label: 'Higher (8, 9, 10)' },
  ];
  const counts = groups.map(({ key, label }) => {
    const rows = usable.filter((u) => u.signal_group === key);
    return `${label}: ${rows.length} units, ${story1Distinct(rows, 'event_id')} events, ${story1Distinct(rows, 'station_id')} stations`;
  });
  note.textContent = `${counts.join(' · ')}. Excluded units (missing median or below the 75% completeness rule): ${all.length - usable.length} of ${all.length}. Missing values are not treated as zero.`;
  if (!usable.length) {
    story1Placeholder(el, `No retained ${pollutant} units.`);
    return;
  }
  const traces = groups.map(({ key, label }) => {
    const rows = usable.filter((u) => u.signal_group === key);
    return {
      type: 'box',
      name: label,
      x: rows.map(() => label),
      y: rows.map((u) => story1Number(u.median)),
      text: rows.map((u) => `${u.event_id} · ${u.station_id}`),
      boxpoints: 'all',
      jitter: 0.4,
      pointpos: 0,
      marker: { color: STORY1_COLORS[key], size: 5 },
      line: { color: STORY1_COLORS[key] },
      hovertemplate: '%{text}<br>Median: %{y} µg/m³<extra></extra>',
    };
  });
  Plotly.newPlot(el, traces, {
    title: `${pollutant}: event–station medians by signal group`,
    yaxis: { title: 'Median concentration (µg/m³)' },
    showlegend: false,
    margin: { t: 50, r: 20, b: 40, l: 60 },
  }, { responsive: true });
}

function renderStory1Paired(data, pollutant) {
  const el = document.getElementById('story1-paired-chart');
  const note = document.getElementById('story1-paired-note');
  const pairs = data.pairs
    .filter((p) => p.pollutant === pollutant && story1Number(p.diff_high_minus_low) !== null)
    .map((p) => ({ event_id: p.event_id, station_id: p.station_id, diff: story1Number(p.diff_high_minus_low) }));
  note.textContent = `${pairs.length} pairs · ${story1Distinct(pairs, 'event_id')} events · ${story1Distinct(pairs, 'station_id')} stations. Each pair comes from the same event, station and pollutant. Pairs are not independent across hours or stations, and the differences are descriptive associations, not causal effects.`;
  if (!pairs.length) {
    story1Placeholder(el, `No paired ${pollutant} comparisons.`);
    return;
  }
  Plotly.newPlot(el, [{
    type: 'box',
    x: pairs.map(() => 'Higher − lower'),
    y: pairs.map((p) => p.diff),
    text: pairs.map((p) => `${p.event_id} · ${p.station_id}`),
    boxpoints: 'all',
    jitter: 0.4,
    pointpos: 0,
    marker: { color: '#5b4b8a', size: 5 },
    hovertemplate: '%{text}<br>Difference: %{y} µg/m³<extra></extra>',
  }], {
    title: `${pollutant}: paired difference (higher-signal median − lower-signal median)`,
    yaxis: { title: 'Difference, µg/m³ (positive = higher in higher-signal group)' },
    shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0, line: { dash: 'dot', color: '#56607a' } }],
    showlegend: false,
    margin: { t: 50, r: 20, b: 40, l: 60 },
  }, { responsive: true });
}

function renderStory1Period(data, eventId, pollutant) {
  const el = document.getElementById('story1-period-chart');
  const note = document.getElementById('story1-period-note');
  const event = data.events.find((e) => e.event_id === eventId);
  const phases = [
    { label: 'Before (24 h)', color: STORY1_COLORS.neutral, rows: data.periods.filter((r) => r.event_id === eventId && r.pollutant === pollutant && r.window_hours === '24' && r.side === 'before') },
    { label: 'During: lower (1, 3)', color: STORY1_COLORS.low, rows: data.units.filter((r) => r.event_id === eventId && r.pollutant === pollutant && r.signal_group === 'low') },
    { label: 'During: higher (8, 9, 10)', color: STORY1_COLORS.high, rows: data.units.filter((r) => r.event_id === eventId && r.pollutant === pollutant && r.signal_group === 'high') },
    { label: 'After (24 h)', color: STORY1_COLORS.neutral, rows: data.periods.filter((r) => r.event_id === eventId && r.pollutant === pollutant && r.window_hours === '24' && r.side === 'after') },
  ].map((ph) => ({
    ...ph,
    values: ph.rows
      .filter((r) => r.retained_75 === 'True' && story1Number(r.median) !== null)
      .map((r) => ({ value: story1Number(r.median), station: r.station_id })),
  }));
  const traces = phases.filter((ph) => ph.values.length).map((ph) => {
    const label = `${ph.label} (n=${ph.values.length})`;
    return {
      type: 'box',
      name: label,
      x: ph.values.map(() => label),
      y: ph.values.map((v) => v.value),
      text: ph.values.map((v) => v.station),
      boxpoints: 'all',
      jitter: 0.4,
      pointpos: 0,
      marker: { color: ph.color, size: 5 },
      line: { color: ph.color },
      hovertemplate: '%{text}<br>Median: %{y} µg/m³<extra></extra>',
    };
  });
  const higherText = event && event.has_high === 'True'
    ? 'This event has Signal 8, 9 or 10 intervals in the HKO records.'
    : 'This event has no Signal 8, 9 or 10 interval in the HKO records, so the higher-signal box is absent (no data, not zero).';
  note.textContent = `${phases.map((ph) => `${ph.label}: ${ph.values.length} stations`).join(' · ')}. ${higherText} Each point is one station's median. During-signal values use pure hourly bins only; transition hours are excluded. Missing or non-retained values are not plotted and are not treated as zero.`;
  if (!traces.length) {
    story1Placeholder(el, `No retained ${pollutant} values for ${eventId}.`);
    return;
  }
  Plotly.newPlot(el, traces, {
    title: `${eventId}${event ? ` ${event.storm_name}` : ''}: ${pollutant} before, during and after`,
    yaxis: { title: 'Median concentration (µg/m³)' },
    showlegend: false,
    margin: { t: 50, r: 20, b: 40, l: 60 },
  }, { responsive: true });
}

function renderStory1Windows(data, eventId) {
  const tableEl = document.getElementById('story1-window-table');
  const note = document.getElementById('story1-window-note');
  const windows = data.windows.filter((w) => w.window_hours === '24');
  const own = windows.filter((w) => w.event_id === eventId);
  tableEl.textContent = '';
  if (own.length) {
    tableEl.appendChild(story1Table(
      ['Side', 'Window start', 'Window end', 'Free hours', 'Shared hours', 'Warning-contaminated hours', 'Status'],
      own.map((w) => [w.side, w.window_start, w.window_end, w.free_bins, w.shared_bins, w.warning_contaminated_bins, w.status]),
    ));
  } else {
    tableEl.textContent = 'No 24 h window records for this event.';
  }
  const count = (status) => windows.filter((w) => w.status === status).length;
  const notFull = windows.filter((w) => w.status !== 'full').map((w) => `${w.event_id} ${w.side} (${w.status})`);
  note.textContent = `All 24 h windows: full ${count('full')}, reduced ${count('reduced')}, excluded ${count('excluded')}. Not-full windows: ${notFull.join('; ') || 'none'}. A window needs at least 12 free hours; free hours exclude warning-contaminated and shared hours. Excluded windows are listed rather than removed silently.`;
}

function renderStory1Sensitivity(data) {
  const el = document.getElementById('story1-sensitivity-table');
  el.textContent = '';
  if (!data.sensitivity.length) {
    el.textContent = 'Sensitivity summary not found.';
    return;
  }
  const rows = data.sensitivity.map((r) => {
    let label = STORY1_ROLE_LABELS[r.role] ?? r.role;
    if (r.role === 'timing_sensitivity') {
      const shift = Number(r.shift_hours);
      label = `${label}, shift ${shift > 0 ? '+' : ''}${shift} h`;
    }
    const total = story1Number(r.windows_total);
    const full = story1Number(r.windows_full);
    const reduced = story1Number(r.windows_reduced);
    const excluded = story1Number(r.windows_excluded);
    return [
      label,
      `${r.window_hours} h`,
      r.full_windows_only === 'True' ? 'Yes' : 'No',
      r.eligible_events,
      r.units_total,
      r.units_retained_75,
      r.paired_triples_75,
      r.paired_events_75,
      r.paired_stations_75,
      `${full} / ${reduced} / ${excluded} (total ${total})`,
      full + reduced + excluded === total ? 'Yes' : 'No: check',
    ];
  });
  el.appendChild(story1Table(
    ['Analysis', 'Window', 'Full windows only', 'Eligible events', 'Units total', 'Units retained (75%)', 'Paired triples', 'Paired events', 'Paired stations', 'Windows full / reduced / excluded', 'Status counts sum to total'],
    rows,
  ));
}

function renderStory1Assumptions(data) {
  const el = document.getElementById('story1-assumptions');
  el.textContent = '';
  const assumptions = data.validation && data.validation.assumptions;
  if (!assumptions) {
    el.textContent = 'Validation summary not found; assumption text unavailable.';
    return;
  }
  const list = document.createElement('ul');
  Object.entries(assumptions).forEach(([key, value]) => {
    const li = document.createElement('li');
    li.textContent = `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
    list.appendChild(li);
  });
  el.appendChild(list);
}

function setupStory1Controls(data) {
  const pollutantSelect = document.getElementById('story1-pollutant');
  const eventSelect = document.getElementById('story1-event');
  const pollutants = STORY1_POLLUTANT_ORDER.filter((p) => data.units.some((u) => u.pollutant === p));
  pollutants.forEach((p) => pollutantSelect.add(new Option(p, p)));
  data.events.forEach((e) => eventSelect.add(new Option(`${e.event_id} · ${e.storm_name}`, e.event_id)));
  if (pollutants.includes('NO2')) pollutantSelect.value = 'NO2';
  // E20 is Super Typhoon Doksuri (Signal 1 only), used as the default event.
  eventSelect.value = data.events.some((e) => e.event_id === 'E20') ? 'E20' : (data.events[0]?.event_id ?? '');
  pollutantSelect.addEventListener('change', () => renderStory1Inline(data));
  eventSelect.addEventListener('change', () => renderStory1Inline(data));
}

function renderStory1Inline(data) {
  if (!data.units.length) {
    ['story1-group-chart', 'story1-paired-chart', 'story1-period-chart'].forEach((id) => {
      story1Placeholder(document.getElementById(id), 'Story 1 analysis outputs not found. Run scripts/story1_analysis.py.');
    });
    return;
  }
  const pollutant = document.getElementById('story1-pollutant').value;
  const eventId = document.getElementById('story1-event').value;
  renderStory1Groups(data, pollutant);
  renderStory1Paired(data, pollutant);
  renderStory1Period(data, eventId, pollutant);
  renderStory1Windows(data, eventId);
}

async function renderStory1() {
  const data = await loadStory1();
  renderStory1Timeline(data);
  if (!story1ControlsReady) {
    setupStory1Controls(data);
    renderStory1Sensitivity(data);
    renderStory1Assumptions(data);
    story1ControlsReady = true;
  }
  renderStory1Inline(data);
  setStatus(data.units.length
    ? `Story 1: ${data.events.length} events · ${data.segments.length} warning-signal intervals · timestamps as recorded in the HKO workbook (HKT assumed, unverified).`
    : 'Story 1: analysis outputs not found in output/analysis/story1/.');
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
  // Stories 1 and 4 have no verified station coordinates, so the map is hidden to give the charts more room.
  const isStory1 = story === 'story1';
  const isStory4 = story === 'story4';
  mapEl.hidden = isStory1 || isStory4;
  chartEl.classList.toggle('chart--tall', isStory1 || isStory4);
  if (!mapEl.hidden && map) map.invalidateSize();
  if (story === 'story1') return renderStory1();
  if (story === 'story2') return renderStory2();
  if (story === 'story3') return renderStory3();
  if (story === 'story4') return renderStory4();
  setStatus('Intro: inspect repository data first, then run preprocessing scripts.');
  renderPlaceholder('Hong Kong Air Pollution Data Storytelling', 'Scroll to enter story sections.');
}

function initObserver() {
  const onIntersect = (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) activateStep(entry.target);
    });
  };
  const observer = new IntersectionObserver(onIntersect, { threshold: 0.45 });
  // A 45% visibility threshold can never be met by Story 1 at laptop heights (the step is taller than the viewport),
  // so Story 1 activates when it crosses a band across the middle of the viewport instead.
  const story1Observer = new IntersectionObserver(onIntersect, { threshold: 0, rootMargin: '-45% 0px -45% 0px' });

  document.querySelectorAll('.step').forEach((step) => {
    (step.dataset.story === 'story1' ? story1Observer : observer).observe(step);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  ensureMap();
  initObserver();
  const intro = document.querySelector('.step[data-story="intro"]');
  if (intro) activateStep(intro);
});
