const statusEl = document.getElementById('status');
const chartEl = document.getElementById('chart');
const mapEl = document.getElementById('map');
const vizEl = document.querySelector('.viz-panel');
const validationEl = document.getElementById('story2-validation');
const STORY2_MOBILE = window.matchMedia('(max-width: 900px)');
let story2Token = 0;
let story2SharedView = null;
const story2InlineDrawn = new Set();

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

const STORY2_BASE = '../output/analysis/story2/';
const STORY2_COLORS = {
  weekday: '#2c7a7b',
  weekend: '#805ad5',
  weekdayFill: 'rgba(44,122,123,0.15)',
  weekendFill: 'rgba(128,90,213,0.15)',
  neutral: '#7a8699',
  neutralFill: 'rgba(122,134,153,0.2)',
};
let story2Loaded = null;

// Blank CSV cells (pandas writes NaN as an empty field) become gaps, never zeros.
function story2Num(value) {
  if (value === undefined || value === '' || value === 'nan') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return null;
  }
}

function loadStory2() {
  if (!story2Loaded) {
    story2Loaded = Promise.all([
      fetchCsv(`${STORY2_BASE}story2_city_hourly_profile.csv`),
      fetchCsv(`${STORY2_BASE}story2_hourly_weekday_weekend_difference.csv`),
      fetchCsv(`${STORY2_BASE}story2_station_summary.csv`),
      fetchJson(`${STORY2_BASE}story2_validation_summary.json`),
    ]);
  }
  return story2Loaded;
}

function sortByHour(rows) {
  return [...rows].sort((a, b) => Number(a.hour) - Number(b.hour));
}

function story2Layout(extra) {
  return {
    margin: { t: 50, r: 20, b: 60, l: 60 },
    legend: { orientation: 'h', y: -0.2 },
    ...extra,
  };
}

function story2Plot(target, traces, layout) {
  Plotly.react(target, traces, story2Layout(layout), { responsive: true });
}

function story2Hour(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function story2Signed(value) {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function story2Extreme(rows, key, sign) {
  const valid = rows.filter((r) => story2Num(r[key]) !== null);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (sign * (story2Num(b[key]) - story2Num(a[key])) > 0 ? b : a));
}

function story2InWindow(rows, key, [lo, hi]) {
  return story2Extreme(rows.filter((r) => Number(r.hour) >= lo && Number(r.hour) <= hi), key, 1);
}

function story2Message(target, message) {
  target.replaceChildren();
  const p = document.createElement('p');
  p.className = 'story2-message';
  p.textContent = message;
  target.appendChild(p);
}

const STORY2_MORNING = [6, 10];
const STORY2_EVENING = [16, 21];

function story2RhythmPeakNote(row, prefix, color, ay) {
  return {
    x: Number(row.hour),
    y: story2Num(row.median_no2),
    xref: 'x',
    yref: 'y',
    text: `${prefix} ${story2Hour(row.hour)}: ${story2Num(row.median_no2).toFixed(1)}`,
    showarrow: true,
    arrowhead: 0,
    arrowwidth: 1,
    arrowcolor: color,
    ax: 0,
    ay,
    font: { size: 11, color },
    bgcolor: 'rgba(255,255,255,0.85)',
  };
}

function renderStory2Rhythm(city, validation, target) {
  const traces = [];
  const annotations = [];
  const peaks = {};
  const stationCounts = [];
  [
    ['weekday', 'Weekday', STORY2_COLORS.weekday, STORY2_COLORS.weekdayFill],
    ['weekend', 'Weekend', STORY2_COLORS.weekend, STORY2_COLORS.weekendFill],
  ].forEach(([key, label, color, fill]) => {
    const rows = sortByHour(city.filter((r) => r.day_type === key));
    const x = rows.map((r) => Number(r.hour));
    traces.push({ x, y: rows.map((r) => story2Num(r.p75_no2)), mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false });
    traces.push({ x, y: rows.map((r) => story2Num(r.p25_no2)), mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: fill, hoverinfo: 'skip', showlegend: false });
    traces.push({
      x,
      y: rows.map((r) => story2Num(r.median_no2)),
      mode: 'lines+markers',
      name: `${label} median`,
      line: { color },
      marker: { color },
      customdata: rows.map((r) => r.n_stations),
      hovertemplate: `${label} %{x}:00<br>Median %{y:.1f}<br>Stations: %{customdata}<extra></extra>`,
    });
    const morning = story2InWindow(rows, 'median_no2', STORY2_MORNING);
    const evening = story2InWindow(rows, 'median_no2', STORY2_EVENING);
    peaks[key] = { label, morning, evening };
    if (morning) annotations.push(story2RhythmPeakNote(morning, `${label} morning`, color, key === 'weekday' ? -30 : 30));
    if (evening) annotations.push(story2RhythmPeakNote(evening, `${label} evening`, color, key === 'weekday' ? -30 : 30));
    rows.forEach((r) => { if (story2Num(r.n_stations) !== null) stationCounts.push(Number(r.n_stations)); });
  });

  story2Plot(target, traces, {
    title: 'Median NO₂ by hour of day (across qualifying stations)',
    xaxis: { title: 'Hour of day (0–23)', dtick: 3 },
    yaxis: { title: 'NO₂ (units as recorded; not verified)' },
    annotations,
  });

  const counts = validation?.qualifying_cells_by_day_type;
  const countText = counts
    ? `Qualifying station-hour cells (at least 50% of expected days): ${counts.weekday} weekday and ${counts.weekend} weekend.`
    : '';
  const range = stationCounts.length ? `Stations per hour: ${Math.min(...stationCounts)} to ${Math.max(...stationCounts)}.` : '';
  document.getElementById('story2-rhythm-note').textContent = [countText, range].filter(Boolean).join(' ');
  renderStory2RhythmTakeaway(peaks);
}

function renderStory2RhythmTakeaway(peaks) {
  const wd = peaks.weekday;
  const we = peaks.weekend;
  const span = ([lo, hi]) => `${story2Hour(lo)}–${story2Hour(hi)}`;
  const peak = (p) => `${story2Hour(p.hour)} (${story2Num(p.median_no2).toFixed(1)})`;
  const sentences = [];
  if (wd.evening && wd.morning) {
    sentences.push(`Weekday peaks: ${peak(wd.morning)} in ${span(STORY2_MORNING)} and ${peak(wd.evening)} in ${span(STORY2_EVENING)}.`);
  }
  if (we.evening && we.morning && wd.morning) {
    const gap = story2Num(wd.morning.median_no2) - story2Num(we.morning.median_no2);
    const comparison = gap >= 0 ? `${gap.toFixed(1)} lower` : `${Math.abs(gap).toFixed(1)} higher`;
    sentences.push(`Weekend: ${peak(we.morning)} morning, ${peak(we.evening)} evening; the morning peak is ${comparison} than on weekdays.`);
  }
  const body = sentences.length ? sentences.join(' ') : 'Peak values are not available in the Story 2 hourly profile.';
  document.getElementById('story2-rhythm-takeaway').textContent = body;
}

function story2GapAnnotation(row, text, color, ay) {
  return {
    x: Number(row.hour),
    y: story2Num(row.median_difference),
    xref: 'x',
    yref: 'y',
    text,
    showarrow: true,
    arrowhead: 0,
    arrowwidth: 1,
    arrowcolor: color,
    ax: 0,
    ay,
    font: { size: 11, color },
    bgcolor: 'rgba(255,255,255,0.85)',
  };
}

function story2CitywideDifference(city, hour) {
  const pick = (dayType) => city.find((r) => r.day_type === dayType && Number(r.hour) === hour);
  const wd = pick('weekday');
  const we = pick('weekend');
  if (!wd || !we) return null;
  const a = story2Num(wd.median_no2);
  const b = story2Num(we.median_no2);
  return a === null || b === null ? null : a - b;
}

function renderStory2Gap(diffRows, city, target) {
  const rows = sortByHour(diffRows);
  const x = rows.map((r) => Number(r.hour));
  const median = rows.map((r) => story2Num(r.median_difference));
  const total = median.filter((v) => v !== null).length;
  const weekdayHigher = median.filter((v) => v !== null && v > 0).length;
  const weekendHigherHours = rows.filter((r) => story2Num(r.median_difference) !== null && story2Num(r.median_difference) < 0).map((r) => story2Hour(r.hour));
  const pairs = rows.map((r) => story2Num(r.n_station_pairs)).filter((v) => v !== null);
  const top = story2Extreme(rows, 'median_difference', 1);
  const bottom = story2Extreme(rows, 'median_difference', -1);

  const annotations = [];
  if (top) annotations.push(story2GapAnnotation(top, `Largest weekday-higher gap ${story2Hour(top.hour)} (${story2Signed(story2Num(top.median_difference))})`, STORY2_COLORS.weekday, -30));
  if (bottom) annotations.push(story2GapAnnotation(bottom, `Largest weekend-higher gap ${story2Hour(bottom.hour)} (${story2Signed(story2Num(bottom.median_difference))})`, STORY2_COLORS.weekend, 30));

  const bandValues = [
    ...median,
    ...rows.map((r) => story2Num(r.p25_difference)),
    ...rows.map((r) => story2Num(r.p75_difference)),
  ].filter((v) => v !== null);
  const lo = Math.min(...bandValues);
  const hi = Math.max(...bandValues);
  const pad = hi - lo;

  story2Plot(target, [
    { x, y: rows.map((r) => story2Num(r.p75_difference)), mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
    { x, y: rows.map((r) => story2Num(r.p25_difference)), mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: STORY2_COLORS.neutralFill, hoverinfo: 'skip', showlegend: false },
    {
      x,
      y: median,
      mode: 'lines+markers',
      name: 'Median station difference',
      line: { color: STORY2_COLORS.neutral },
      marker: { color: median.map((v) => (v !== null && v < 0 ? STORY2_COLORS.weekend : STORY2_COLORS.weekday)), size: 7 },
      customdata: rows.map((r) => r.n_station_pairs),
      hovertemplate: 'Hour %{x}:00<br>Median station difference %{y:.2f}<br>Station pairs: %{customdata}<extra></extra>',
    },
  ], {
    title: 'Weekday minus weekend NO₂ (teal = weekday higher, purple = weekend higher)',
    xaxis: { title: 'Hour of day (0–23)', dtick: 3 },
    yaxis: { title: 'Difference (units as recorded; not verified)', zeroline: true, range: [lo - 0.3 * pad, hi + 0.1 * pad] },
    shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: '#333', dash: 'dot', width: 1 } }],
    annotations,
  });

  const pairRange = pairs.length ? `Station pairs per hour: ${Math.min(...pairs)} to ${Math.max(...pairs)}.` : '';
  document.getElementById('story2-gap-note').textContent =
    `Across ${total} hours, the median station difference was positive (weekday higher) in ${weekdayHigher} hours and negative (weekend higher) in ${weekendHigherHours.length}${weekendHigherHours.length ? `: ${weekendHigherHours.join(', ')}` : ''}. ${pairRange}`;

  const sentences = [];
  if (top) {
    const cityDiff = story2CitywideDifference(city, Number(top.hour));
    const cityText = cityDiff === null ? '' : ` The difference between the citywide weekday and weekend medians at that hour is ${story2Signed(cityDiff)}; that is a different statistic from the median of station differences.`;
    sentences.push(`At ${story2Hour(top.hour)}, the median station difference is ${story2Signed(story2Num(top.median_difference))}.${cityText}`);
  }
  if (bottom && story2Num(bottom.median_difference) < 0) {
    sentences.push(`The largest weekend-higher value is at ${story2Hour(bottom.hour)} (${story2Signed(story2Num(bottom.median_difference))}).`);
  }
  document.getElementById('story2-gap-takeaway').textContent = sentences.join(' ') || 'No hourly difference is available.';
}

function story2BuildTable(container, headers, rows) {
  container.replaceChildren();
  const table = document.createElement('table');
  table.className = 'story2-table';
  const thead = table.createTHead();
  const headRow = thead.insertRow();
  headers.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  const tbody = table.createTBody();
  rows.forEach((cells) => {
    const tr = tbody.insertRow();
    cells.forEach((value) => {
      const td = tr.insertCell();
      td.append(value);
    });
  });
  container.appendChild(table);
}

function story2StationLabel(row) {
  return row.station_id.replace(/_/g, ' ');
}

function story2StationFlags(row) {
  const flags = [];
  if (row.low_mean_flag === 'True') flags.push({ text: 'low mean', cls: 'low' });
  if (row.coverage_start_flag === 'True') flags.push({ text: 'late start', cls: 'late' });
  if (row.name_overlap_flag === 'True') flags.push({ text: 'name overlap', cls: 'overlap' });
  return flags;
}

function story2FlagBadges(flags) {
  if (!flags.length) return '—';
  const fragment = document.createDocumentFragment();
  flags.forEach((f) => {
    const badge = document.createElement('span');
    badge.className = `story2-flag story2-flag--${f.cls}`;
    badge.textContent = f.text;
    fragment.append(badge, ' ');
  });
  return fragment;
}

function renderStory2StationTakeaway(rows) {
  const means = rows.filter((r) => story2Num(r.weekday_qualifying_mean) !== null);
  const high = story2Extreme(means, 'weekday_qualifying_mean', 1);
  const low = story2Extreme(means, 'weekday_qualifying_mean', -1);
  const sentences = [];
  if (high && low) {
    sentences.push(`Weekday qualifying means range from ${story2StationLabel(low)} (${story2Num(low.weekday_qualifying_mean).toFixed(1)}) to ${story2StationLabel(high)} (${story2Num(high.weekday_qualifying_mean).toFixed(1)}).`);
  }
  const names = (key) => rows.filter((r) => r[key] === 'True').map(story2StationLabel);
  const lowMean = names('low_mean_flag');
  const lateStart = names('coverage_start_flag');
  const overlap = names('name_overlap_flag');
  if (lowMean.length) {
    sentences.push(`${lowMean.join(', ')} ${lowMean.length === 1 ? 'is' : 'are'} flagged for a low mean (below half the median station mean).`);
  }
  if (lateStart.length) {
    sentences.push(`${lateStart.join(', ')} ${lateStart.length === 1 ? 'has' : 'have'} a late coverage start.`);
  }
  if (overlap.length) {
    sentences.push(`${overlap.join(' and ')} share a name base and are kept as separate series; they are not verified as duplicates.`);
  }
  sentences.push('Flagged stations are reported as observed, not treated as errors. No station has been removed or merged.');
  document.getElementById('story2-station-takeaway').textContent = sentences.join(' ');
}

function renderStory2Stations(stations, target) {
  const rows = [...stations].sort((a, b) => (story2Num(b.weekday_qualifying_mean) ?? -Infinity) - (story2Num(a.weekday_qualifying_mean) ?? -Infinity));
  const flagged = (r) => story2StationFlags(r).map((f) => f.text);
  const labels = rows.map((r) => (story2StationFlags(r).length ? `${story2StationLabel(r)} *` : story2StationLabel(r)));

  story2Plot(target, [
    {
      type: 'bar',
      orientation: 'h',
      name: 'Weekday',
      y: labels,
      x: rows.map((r) => story2Num(r.weekday_qualifying_mean)),
      marker: { color: STORY2_COLORS.weekday },
      customdata: rows.map((r) => [r.weekday_valid_obs, r.weekday_qualifying_hours, flagged(r).join(', ') || 'none']),
      hovertemplate: '%{y}<br>Weekday mean %{x:.1f}<br>Valid observations: %{customdata[0]}<br>Qualifying hours: %{customdata[1]}<br>Flags: %{customdata[2]}<extra></extra>',
    },
    {
      type: 'bar',
      orientation: 'h',
      name: 'Weekend',
      y: labels,
      x: rows.map((r) => story2Num(r.weekend_qualifying_mean)),
      marker: { color: STORY2_COLORS.weekend },
      customdata: rows.map((r) => [r.weekend_valid_obs, r.weekend_qualifying_hours, flagged(r).join(', ') || 'none']),
      hovertemplate: '%{y}<br>Weekend mean %{x:.1f}<br>Valid observations: %{customdata[0]}<br>Qualifying hours: %{customdata[1]}<br>Flags: %{customdata[2]}<extra></extra>',
    },
  ], {
    title: 'Mean NO₂ by station (qualifying hours only; * = flagged)',
    barmode: 'group',
    xaxis: { title: 'Mean NO₂ (units as recorded; not verified)' },
    yaxis: { autorange: 'reversed', tickfont: { size: 12 }, automargin: true },
    margin: { t: 50, r: 20, b: 60, l: 180 },
  });

  const flagNames = (key) => rows.filter((r) => r[key] === 'True').map(story2StationLabel);
  document.getElementById('story2-station-note').textContent = [
    `Stations with a low mean (below half the median station mean): ${flagNames('low_mean_flag').join(', ') || 'none'}.`,
    `Stations with a late coverage start: ${flagNames('coverage_start_flag').join(', ') || 'none'}.`,
    `Stations whose names share a base (kept as separate series, not verified as duplicates): ${flagNames('name_overlap_flag').join(', ') || 'none'}.`,
  ].join(' ');

  story2BuildTable(
    document.getElementById('story2-station-table'),
    ['Station', 'Weekday valid obs', 'Weekend valid obs', 'Weekday qualifying hours', 'Weekend qualifying hours', 'Flags'],
    rows.map((r) => [
      story2StationLabel(r),
      r.weekday_valid_obs,
      r.weekend_valid_obs,
      r.weekday_qualifying_hours,
      r.weekend_qualifying_hours,
      story2FlagBadges(story2StationFlags(r)),
    ]),
  );
  renderStory2StationTakeaway(rows);
}

function story2Count(value) {
  return value === undefined || value === null ? 'n/a' : Number(value).toLocaleString('en-GB');
}

function renderStory2Limits(validation, target) {
  target.replaceChildren();
  if (!validation) {
    story2Message(target, 'Story 2 validation summary not found in output/analysis/story2/.');
    return;
  }
  const load = validation.load ?? {};
  const dedupe = validation.deduplication ?? {};
  const cmp = validation.comparison_with_existing_csv ?? {};
  const counts = validation.qualifying_cells_by_day_type ?? {};

  const indicators = document.createElement('div');
  indicators.className = 'story2-indicators';
  [
    [story2Count(validation.stations), 'monitoring stations'],
    [story2Count(validation.station_hour_day_type_cells), 'station × hour × day-type cells'],
    [`${story2Count(counts.weekday)} / ${story2Count(counts.weekend)}`, 'qualifying cells, weekday / weekend (≥50% of expected days)'],
    [story2Count(cmp.valid_obs_mismatches), 'valid-observation count mismatches with the existing CSV'],
  ].forEach(([value, label]) => {
    const card = document.createElement('div');
    card.className = 'story2-indicator';
    const big = document.createElement('span');
    big.className = 'story2-indicator-value';
    big.textContent = value;
    const text = document.createElement('span');
    text.className = 'story2-indicator-label';
    text.textContent = label;
    card.append(big, text);
    indicators.appendChild(card);
  });

  const usage = document.createElement('p');
  usage.className = 'story2-usage';
  usage.textContent = `NO₂ rows used: ${story2Count(load.usable_rows)} of ${story2Count(load.no2_rows)}. ${story2Count(load.missing_or_nonnumeric_value_rows)} missing or non-numeric values were excluded, not treated as zero.`;

  const details = document.createElement('details');
  details.className = 'story2-details';
  const summary = document.createElement('summary');
  summary.textContent = 'Full technical validation table';
  details.append(summary);
  const tableHost = document.createElement('div');
  tableHost.className = 'story2-scroll';
  details.appendChild(tableHost);
  const labels = [
    'Stations',
    'Station × hour × day-type cells',
    'Qualifying cells, weekday (≥50% of expected days)',
    'Qualifying cells, weekend (≥50% of expected days)',
    'NO₂ rows in the long file',
    'Rows used after removing missing or non-numeric values',
    'Missing or non-numeric values excluded (not zero)',
    'Exact duplicate rows removed',
    'Conflicting duplicate rows removed',
    'Cells matching the existing CSV (valid observation counts)',
    'Valid observation count mismatches with the existing CSV',
  ];
  const values = [
    validation.stations,
    validation.station_hour_day_type_cells,
    counts.weekday,
    counts.weekend,
    load.no2_rows,
    load.usable_rows,
    load.missing_or_nonnumeric_value_rows,
    dedupe.exact_duplicate_rows_dropped,
    dedupe.conflicting_rows_dropped,
    cmp.matched_cells,
    cmp.valid_obs_mismatches,
  ].map((v) => (v === undefined || v === null ? 'n/a' : String(v)));
  story2BuildTable(tableHost, ['Check', 'Value'], labels.map((label, i) => [label, values[i]]));

  target.append(indicators, usage, details);
}

async function renderStory2(step) {
  const view = step.dataset.view;
  const token = story2Token;
  const mobile = STORY2_MOBILE.matches;
  const statusText = {
    rhythm: 'Story 2: median NO₂ by hour, weekday and weekend, across qualifying stations.',
    gap: 'Story 2: weekday minus weekend NO₂ difference by hour.',
    stations: 'Story 2: mean NO₂ by station, weekday and weekend, with valid-observation counts.',
    limits: 'Story 2: data checks and limitations.',
  };
  setStatus(statusText[view] ?? 'Story 2');
  if (mobile ? story2InlineDrawn.has(view) : story2SharedView === view) return;
  const [city, diff, stations, validation] = await loadStory2();
  if (token !== story2Token) return;
  const target = mobile ? document.getElementById(`story2-inline-${view}`) : view === 'limits' ? validationEl : chartEl;
  const titles = {
    rhythm: 'Story 2 — Daily NO₂ rhythm',
    gap: 'Story 2 — Weekday minus weekend',
    stations: 'Story 2 — Station comparison',
  };
  const empty = view === 'rhythm' ? !city.length : view === 'gap' ? !diff.length : view === 'stations' ? !stations.length : false;
  if (empty) {
    const message = 'Story 2 outputs not found in output/analysis/story2/.';
    if (target === chartEl) renderPlaceholder(titles[view], message);
    else story2Message(target, message);
    return;
  }
  if (view === 'rhythm') renderStory2Rhythm(city, validation, target);
  else if (view === 'gap') renderStory2Gap(diff, city, target);
  else if (view === 'stations') renderStory2Stations(stations, target);
  else renderStory2Limits(validation, target);
  if (mobile) story2InlineDrawn.add(view);
  else story2SharedView = view;
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
  story2Token += 1;
  document.querySelectorAll('.step').forEach((el) => el.classList.remove('is-active'));
  step.classList.add('is-active');
  const story = step.dataset.story;
  // Stories 1 and 4 have no verified station coordinates, so the map is hidden to give the charts more room.
  const isStory1 = story === 'story1';
  const isStory2 = story === 'story2';
  const isStory4 = story === 'story4';
  const story2Limits = isStory2 && step.dataset.view === 'limits';
  if (!isStory2) story2SharedView = null;
  // Story 2 no longer shows the decorative reference map; its station-comparison view uses a taller chart.
  mapEl.hidden = isStory1 || isStory2 || isStory4;
  vizEl.classList.toggle('viz-panel--inline', isStory2);
  const wasChartHidden = chartEl.hidden;
  chartEl.hidden = story2Limits;
  validationEl.hidden = !story2Limits;
  if (wasChartHidden && !chartEl.hidden && chartEl.data) Plotly.Plots.resize(chartEl);
  chartEl.classList.toggle('chart--tall', isStory1 || isStory4 || (isStory2 && step.dataset.view === 'stations'));
  if (!mapEl.hidden && map) map.invalidateSize();
  if (story === 'story1') return renderStory1();
  if (story === 'story2') return renderStory2(step);
  if (story === 'story3') return renderStory3();
  if (story === 'story4') return renderStory4();
  setStatus('Intro: inspect repository data first, then run preprocessing scripts.');
  renderPlaceholder('Hong Kong Air Pollution Data Storytelling', 'Scroll to enter story sections.');
}

STORY2_MOBILE.addEventListener('change', () => {
  story2SharedView = null;
  story2InlineDrawn.clear();
  const active = document.querySelector('.step.is-active');
  if (active && active.dataset.story === 'story2') activateStep(active);
});

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

  // Story 1 and Story 2 steps are taller than the 45% threshold allows, so they use the middle-band observer.
  document.querySelectorAll('.step').forEach((step) => {
    const useBand = step.dataset.story === 'story1' || step.dataset.story === 'story2';
    (useBand ? story1Observer : observer).observe(step);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  ensureMap();
  initObserver();
  const intro = document.querySelector('.step[data-story="intro"]');
  if (intro) activateStep(intro);
});
