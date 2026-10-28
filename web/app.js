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


const STORY3_BASE = '../output/analysis/';
const STORY3_POLLUTANTS = ['NO2', 'O3', 'RSP', 'FSP'];
const STORY3_COMPLETE = 0.75;
const STORY3_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STORY3_SEASONS = ['Winter', 'Spring', 'Summer', 'Autumn'];
const STORY3_VIEWS = ['annual', 'monthly', 'seasonal', 'stations', 'limits'];
const STORY3_COLORS = { full: '#08519c', balanced: '#e6550d', winter: '#2b6cb0', summer: '#dd6b20', context: '#a0aec0', ink: '#1a1f2e' };
let story3Loaded = null;
let story3Token = 0;
const story3State = { pollutant: 'NO2', station: '' };
const story3Drawn = new Map();
const story3ModelCache = new Map();

function story3Num(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function story3Hours(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate() * 24;
}

function loadStory3() {
  if (!story3Loaded) {
    story3Loaded = fetchCsv(`${STORY3_BASE}story3_monthly_summary.csv`).then((raw) => {
      const rows = raw.map((r) => {
        const year = Number(r.year);
        const month = Number(r.month);
        const valid = story3Num(r.valid_obs);
        const expected = story3Hours(year, month);
        return {
          year,
          month,
          station: r.station_id,
          pollutant: r.pollutant,
          mean: story3Num(r.mean_value),
          valid,
          expected,
          coverage: valid === null ? null : valid / expected,
        };
      }).filter((r) => r.mean !== null && r.valid !== null && r.valid > 0);
      const counts = {};
      rows.forEach((r) => {
        const k = `${r.station}|${r.pollutant}`;
        counts[k] = (counts[k] ?? 0) + 1;
      });
      const stations = [...new Set(rows.map((r) => r.station))].sort();
      const balanced = stations.filter((s) => STORY3_POLLUTANTS.every((p) => counts[`${s}|${p}`] === 72));
      return { rows, stations, balanced };
    });
  }
  return story3Loaded;
}

// Observation-weighted pooling: sum(mean × valid_obs) / sum(valid_obs). Different pollutants are never pooled.
function story3Pool(rows) {
  const valid = rows.reduce((s, r) => s + r.valid, 0);
  if (!valid) return null;
  const weighted = rows.reduce((s, r) => s + r.mean * r.valid, 0);
  return {
    mean: weighted / valid,
    valid,
    groups: rows.length,
    incomplete: rows.filter((r) => r.coverage !== null && r.coverage < STORY3_COMPLETE).length,
  };
}

function story3Season(row) {
  if (row.month === 12) return { season: 'Winter', year: row.year + 1 };
  if (row.month <= 2) return { season: 'Winter', year: row.year };
  if (row.month <= 5) return { season: 'Spring', year: row.year };
  if (row.month <= 8) return { season: 'Summer', year: row.year };
  return { season: 'Autumn', year: row.year };
}

function story3Mobile() {
  return STORY2_MOBILE.matches;
}

function story3Fmt(value, digits = 1) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(digits);
}

function story3Signed(value, digits = 1) {
  if (value === null || value === undefined) return 'n/a';
  const text = Math.abs(value).toFixed(digits);
  return Number(text) === 0 ? text : `${value < 0 ? '−' : '+'}${text}`;
}

function story3Pct(value) {
  return value === null || value === undefined ? 'n/a' : `${story3Signed(value, 1)}%`;
}

function story3Dir(value, up = 'higher', down = 'lower') {
  if (value > 0) return up;
  return value < 0 ? down : 'unchanged';
}

function story3List(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function story3Years(years) {
  if (!years.length) return 'none';
  const contiguous = years.every((y, i) => i === 0 || y === years[i - 1] + 1);
  return contiguous && years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : years.join(', ');
}

function story3Median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function story3Ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    for (let k = i; k <= j; k += 1) ranks[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return ranks;
}

function story3Corr(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}

function story3Title(main, sub) {
  return {
    text: sub ? `<b>${main}</b><br><sup>${sub}</sup>` : `<b>${main}</b>`,
    x: 0.01,
    xanchor: 'left',
    y: 0.97,
    yanchor: 'top',
    font: { size: story3Mobile() ? 13 : 15 },
  };
}

// Plotly.newPlot (not react) so axes from another story's figure on the shared chart never carry over.
function story3Plot(target, traces, layout) {
  const mobile = story3Mobile();
  const base = {
    margin: { t: 84, r: mobile ? 12 : 24, b: 70, l: mobile ? 48 : 64 },
    font: { size: mobile ? 11 : 12, color: STORY3_COLORS.ink },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    legend: { orientation: 'h', x: 0, y: -0.16, yanchor: 'top', font: { size: mobile ? 10 : 12 } },
  };
  Plotly.newPlot(target, traces, { ...base, ...layout }, { responsive: true, displayModeBar: false });
}

function story3SeasonMonths(season, year) {
  if (season === 'Winter') return [[year - 1, 12], [year, 1], [year, 2]];
  const first = { Spring: 3, Summer: 6, Autumn: 9 }[season];
  return [0, 1, 2].map((i) => [year, first + i]);
}

function story3YearHours(year) {
  return Array.from({ length: 12 }, (_, i) => story3Hours(year, i + 1)).reduce((a, b) => a + b, 0);
}

function story3BuildAnnual(data, rows, years) {
  const series = (set) => years.map((year) => {
    const own = rows.filter((r) => r.year === year && set.includes(r.station));
    const pool = story3Pool(own);
    const flagged = set.filter((st) => own.filter((r) => r.station === st).reduce((s, r) => s + r.valid, 0) / story3YearHours(year) < STORY3_COMPLETE);
    return { year, mean: pool ? pool.mean : null, flagged };
  });
  const change = (pts) => {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (!a || !b || a.mean === null || b.mean === null) return null;
    return { from: a.year, to: b.year, a: a.mean, b: b.mean, abs: b.mean - a.mean, pct: a.mean ? ((b.mean - a.mean) / a.mean) * 100 : null };
  };
  const full = series(data.stations);
  const balanced = series(data.balanced);
  const valued = full.filter((pt) => pt.mean !== null);
  const marks = new Map();
  const mark = (year, label) => marks.set(year, [...(marks.get(year) ?? []), label]);
  let step = null;
  if (valued.length) {
    const hi = valued.reduce((m, pt) => (pt.mean > m.mean ? pt : m));
    const lo = valued.reduce((m, pt) => (pt.mean < m.mean ? pt : m));
    mark(hi.year, 'Highest');
    if (lo.year !== hi.year) mark(lo.year, 'Lowest');
    for (let i = 1; i < valued.length - 1; i += 1) {
      const before = valued[i].mean - valued[i - 1].mean;
      const after = valued[i + 1].mean - valued[i].mean;
      if (before * after < 0 && !marks.has(valued[i].year)) mark(valued[i].year, before > 0 ? 'Local peak' : 'Local trough');
    }
    for (let i = 1; i < valued.length; i += 1) {
      const d = valued[i].mean - valued[i - 1].mean;
      if (!step || Math.abs(d) > Math.abs(step.d)) step = { from: valued[i - 1].year, to: valued[i].year, d };
    }
  }
  return {
    full,
    balanced,
    fullChange: change(full),
    balChange: change(balanced),
    marks,
    step,
    highYear: valued.length ? valued.reduce((m, pt) => (pt.mean > m.mean ? pt : m)) : null,
    lowYear: valued.length ? valued.reduce((m, pt) => (pt.mean < m.mean ? pt : m)) : null,
    flaggedFull: full.reduce((n, pt) => n + pt.flagged.length, 0),
  };
}

function story3TextAnnual(model, data) {
  const { p, annual: a } = model;
  const flagged = a.full.filter((pt) => pt.flagged.length).map((pt) => `${pt.year}: ${pt.flagged.join(', ')}`);
  document.getElementById('story3-annual-note').textContent =
    `${p}, pooled by valid-observation count, so stations and months with more valid readings carry more weight. ` +
    'Hollow markers include at least one station below 75% of that year\'s hours. Those values are kept and flagged, not removed. ' +
    `Flagged station-years (all-stations line): ${flagged.join('; ') || 'none'}. ` +
    `The balanced ${data.balanced.length}-station line uses only stations with all 72 months for every pollutant.`;
  const c = a.fullChange;
  const b = a.balChange;
  const parts = [];
  if (c) {
    parts.push(`${p}'s pooled mean in ${c.to} was ${story3Fmt(Math.abs(c.abs))} ${story3Dir(c.abs)} than in ${c.from} (${story3Fmt(c.a)} → ${story3Fmt(c.b)}; ${story3Pct(c.pct)}), using all stations with data.`);
  }
  if (b) {
    const opposite = c && Math.sign(b.abs) !== Math.sign(c.abs);
    parts.push(`On the balanced ${data.balanced.length}-station set the change was ${story3Signed(b.abs)} (${story3Pct(b.pct)})${opposite ? ', in the opposite direction' : ''}.`);
  }
  if (a.highYear && a.lowYear) {
    parts.push(`Highest year: ${a.highYear.year} (${story3Fmt(a.highYear.mean)}); lowest: ${a.lowYear.year} (${story3Fmt(a.lowYear.mean)}).`);
  }
  if (a.step) parts.push(`Largest year-to-year move: ${a.step.from} to ${a.step.to} (${story3Signed(a.step.d)}).`);
  const first = a.full[0];
  if (first && first.flagged.length) {
    parts.push(`The ${first.year} all-stations value includes ${first.flagged.length} station${first.flagged.length === 1 ? '' : 's'} below 75% of that year's hours, so the balanced line is the safer like-for-like comparison.`);
  }
  parts.push('This describes how yearly levels differ; it does not show why.');
  document.getElementById('story3-annual-takeaway').textContent = c ? parts.join(' ') : `No annual values are available for ${p}.`;
}

function renderStory3Annual(model, data, target) {
  const { p, annual: a } = model;
  const mobile = story3Mobile();
  const trace = (pts, name, color, width, dash, size, rank) => ({
    x: pts.map((pt) => pt.year),
    y: pts.map((pt) => pt.mean),
    mode: 'lines+markers',
    name,
    legendrank: rank,
    line: { color, width, dash },
    marker: { color: pts.map((pt) => (pt.flagged.length ? '#ffffff' : color)), line: { color, width: 2 }, size },
    customdata: pts.map((pt) => (pt.flagged.length ? `Stations below 75% this year: ${pt.flagged.join(', ')}` : 'All contributing stations at least 75% complete this year')),
    hovertemplate: `${name}<br>%{x}: %{y:.1f}<br>%{customdata}<extra></extra>`,
  });
  const balName = `Balanced ${data.balanced.length}-station check`;
  const traces = [
    trace(a.balanced, balName, STORY3_COLORS.balanced, 2, 'dot', 7, 2),
    trace(a.full, `All ${data.stations.length} stations with data`, STORY3_COLORS.full, 4.5, 'solid', 12, 1),
  ];
  const annotations = [...a.marks].map(([year, labels]) => {
    const pt = a.full.find((q) => q.year === year);
    const up = labels.some((l) => l === 'Highest' || l === 'Local peak');
    return {
      x: year,
      y: pt.mean,
      text: `<b>${labels.join(' / ')}</b><br>${story3Fmt(pt.mean)}`,
      showarrow: true,
      arrowhead: 0,
      arrowcolor: STORY3_COLORS.full,
      ax: 0,
      ay: up ? -42 : 42,
      font: { size: mobile ? 10 : 12, color: STORY3_COLORS.full },
      bgcolor: 'rgba(255,255,255,0.9)',
    };
  });
  const values = [...a.full, ...a.balanced].map((pt) => pt.mean).filter((v) => v !== null);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || 1) * 0.35;
  const c = a.fullChange;
  const b = a.balChange;
  const sub = c
    ? `${c.from}→${c.to}: ${story3Signed(c.abs)} (${story3Pct(c.pct)}) all stations${b ? `<br>${b.from}→${b.to}: ${story3Signed(b.abs)} (${story3Pct(b.pct)}) balanced ${data.balanced.length}` : ''}`
    : '';
  story3Plot(target, traces, {
    title: story3Title(`${p}: annual pooled mean`, sub),
    xaxis: { title: 'Calendar year', dtick: 1, showgrid: false },
    yaxis: { title: `${p} (units as recorded; not verified)`, range: [lo - pad, hi + pad], gridcolor: '#eef1f6', automargin: true },
    annotations,
  });
}

function story3BuildMonthly(rows, years) {
  const table = years.map((year) => STORY3_MONTHS.map((_, i) => {
    const pool = story3Pool(rows.filter((r) => r.year === year && r.month === i + 1));
    return pool ? { ...pool, year, month: i + 1 } : null;
  }));
  const avg = STORY3_MONTHS.map((_, i) => {
    const pool = story3Pool(rows.filter((r) => r.month === i + 1));
    return pool ? { ...pool, month: i + 1 } : null;
  });
  const fullYears = years.filter((_, yi) => table[yi].every(Boolean));
  const peaks = fullYears.map((year) => {
    const cells = table[years.indexOf(year)];
    const order = cells.map((c, i) => ({ i, m: c.mean, flag: c.incomplete > 0 })).sort((a, b) => b.m - a.m);
    return {
      year,
      peak: order[0].i,
      trough: order[11].i,
      top3: order.slice(0, 3).map((o) => o.i),
      bottom3: order.slice(9).map((o) => o.i),
      flagged: Number(order[0].flag) + Number(order[11].flag),
    };
  });
  const complete = avg.every(Boolean);
  const hiM = complete ? avg.reduce((m, c, i) => (c.mean > avg[m].mean ? i : m), 0) : null;
  const loM = complete ? avg.reduce((m, c, i) => (c.mean < avg[m].mean ? i : m), 0) : null;
  const tally = (key) => {
    const counts = new Array(12).fill(0);
    peaks.forEach((pk) => { counts[pk[key]] += 1; });
    const best = counts.reduce((m, c, i) => (c > counts[m] ? i : m), 0);
    return { month: best, count: counts[best] };
  };
  const ranks = fullYears.map((y) => story3Ranks(table[years.indexOf(y)].map((c) => c.mean)));
  const corrs = [];
  for (let i = 0; i < ranks.length; i += 1) {
    for (let j = i + 1; j < ranks.length; j += 1) {
      const c = story3Corr(ranks[i], ranks[j]);
      if (c !== null) corrs.push(c);
    }
  }
  return {
    table,
    avg,
    peaks,
    hiM,
    loM,
    flaggedCells: table.flat().filter((c) => c && c.incomplete).length,
    hiPeak: hiM === null ? 0 : peaks.filter((pk) => pk.peak === hiM).length,
    hiTop3: hiM === null ? 0 : peaks.filter((pk) => pk.top3.includes(hiM)).length,
    loTrough: loM === null ? 0 : peaks.filter((pk) => pk.trough === loM).length,
    loBottom3: loM === null ? 0 : peaks.filter((pk) => pk.bottom3.includes(loM)).length,
    modePeak: peaks.length ? tally('peak') : null,
    modeTrough: peaks.length ? tally('trough') : null,
    flaggedExtremes: peaks.reduce((n, pk) => n + pk.flagged, 0),
    spearman: corrs.length ? corrs.reduce((a, b) => a + b, 0) / corrs.length : null,
  };
}

function story3TextMonthly(model) {
  const { p, years, monthly: m } = model;
  const n = m.peaks.length;
  const cells = years.length * 12;
  const eachYear = (key) => m.peaks.map((pk) => `${pk.year} ${STORY3_MONTHS[pk[key]]}`).join('; ');
  let note = `† = at least one contributing station-month is below 75% of its hours. Those cells are included and marked, not removed. Flagged cells for ${p}: ${m.flaggedCells} of ${cells}. ` +
    `Highest month in each year: ${eachYear('peak') || 'n/a'}. Lowest: ${eachYear('trough') || 'n/a'}.`;
  if (m.spearman !== null) {
    note += ` Optional method detail: the average rank correlation between years' month-by-month patterns is ${m.spearman.toFixed(2)} (1 = identical month order; 0 = unrelated). It is descriptive, not a significance test.`;
  }
  document.getElementById('story3-monthly-note').textContent = note;
  const el = document.getElementById('story3-monthly-takeaway');
  if (m.hiM === null || !n) {
    el.textContent = `Not every month has data in every year for ${p}, so recurrence is not calculated.`;
    return;
  }
  const share = m.hiTop3 / n;
  const repeat = share >= 0.8 ? 'repeats closely' : (share >= 0.5 ? 'repeats partly' : 'does not repeat reliably');
  const hi = STORY3_MONTHS[m.hiM];
  const lo = STORY3_MONTHS[m.loM];
  const parts = [
    `Averaged over ${story3Years(years)}, ${p} was highest in ${hi} (${story3Fmt(m.avg[m.hiM].mean)}) and lowest in ${lo} (${story3Fmt(m.avg[m.loM].mean)}).`,
    `${hi} was the highest month of its year in ${m.hiPeak} of ${n} years, and among the top three in ${m.hiTop3}. ${lo} was the lowest in ${m.loTrough} of ${n} years, and among the bottom three in ${m.loBottom3}.`,
    `So the month-by-month timing ${repeat} across years (wording rule: top three in at least 80% of years = closely, 50% = partly).`,
  ];
  if (m.flaggedExtremes) parts.push(`${m.flaggedExtremes} of the ${n * 2} yearly highest/lowest cells include station-months below 75% (marked †).`);
  el.textContent = parts.join(' ');
}

function renderStory3Monthly(model, target) {
  const { p, years, monthly: m } = model;
  const mobile = story3Mobile();
  const z = STORY3_MONTHS.map((_, mi) => years.map((_, yi) => (m.table[yi][mi] ? m.table[yi][mi].mean : null)));
  const hover = STORY3_MONTHS.map((_, mi) => years.map((_, yi) => {
    const c = m.table[yi][mi];
    return c ? `${c.groups} station-months · ${c.valid.toLocaleString('en-GB')} valid obs${c.incomplete ? ` · ${c.incomplete} below 75% (†)` : ''}` : 'No valid data';
  }));
  const values = z.flat().filter((v) => v !== null);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const annotations = [];
  STORY3_MONTHS.forEach((name, mi) => years.forEach((year, yi) => {
    const c = m.table[yi][mi];
    if (!c) return;
    const t = hi > lo ? (c.mean - lo) / (hi - lo) : 0;
    annotations.push({
      xref: 'x',
      yref: 'y',
      x: String(year),
      y: name,
      text: `${c.mean.toFixed(1)}${c.incomplete ? '†' : ''}`,
      showarrow: false,
      font: { size: mobile ? 9 : 11, color: t >= 0.72 ? '#ffffff' : '#1a1f2e' },
    });
  }));
  const barColors = m.avg.map((c, i) => (i === m.hiM ? '#b30000' : (i === m.loM ? STORY3_COLORS.winter : STORY3_COLORS.context)));
  const avgMax = Math.max(...m.avg.filter(Boolean).map((c) => c.mean));
  story3Plot(target, [
    {
      type: 'heatmap',
      z,
      x: years.map(String),
      y: STORY3_MONTHS,
      customdata: hover,
      hovertemplate: `${p} · %{y} %{x}<br>Pooled mean %{z:.1f}<br>%{customdata}<extra></extra>`,
      colorscale: [[0, '#ffffcc'], [0.125, '#ffeda0'], [0.25, '#fed976'], [0.375, '#feb24c'], [0.5, '#fd8d3c'], [0.625, '#fc4e2a'], [0.75, '#e31a1c'], [0.875, '#bd0026'], [1, '#800026']],
      showscale: false,
      xgap: 2,
      ygap: 2,
    },
    {
      type: 'bar',
      orientation: 'h',
      x: m.avg.map((c) => (c ? c.mean : null)),
      y: STORY3_MONTHS,
      xaxis: 'x2',
      yaxis: 'y2',
      marker: { color: barColors },
      text: m.avg.map((c) => (c ? c.mean.toFixed(1) : '')),
      textposition: 'outside',
      cliponaxis: false,
      textfont: { size: mobile ? 9 : 11 },
      hovertemplate: `${p} · %{y}, all years<br>Pooled mean %{x:.1f}<extra></extra>`,
    },
  ], {
    title: story3Title(`${p}: month-by-year pooled mean`, 'Left: each month and year. Right: all-years average (red = highest month, blue = lowest).'),
    showlegend: false,
    xaxis: { domain: [0, 0.74], type: 'category', title: 'Calendar year', anchor: 'y' },
    yaxis: { type: 'category', categoryorder: 'array', categoryarray: STORY3_MONTHS, autorange: 'reversed', anchor: 'x' },
    xaxis2: { domain: [0.8, 1], anchor: 'y2', range: [0, avgMax * 1.35], showgrid: false, zeroline: false, showticklabels: false, title: 'All-years mean' },
    yaxis2: { type: 'category', categoryorder: 'array', categoryarray: STORY3_MONTHS, autorange: 'reversed', anchor: 'x2', showticklabels: false },
    annotations,
  });
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

function story3BuildSeasonal(data, rows) {
  const groups = new Map();
  rows.forEach((r) => {
    const { season, year } = story3Season(r);
    const key = `${season}|${year}`;
    if (!groups.has(key)) groups.set(key, { season, year, rows: [], months: new Set() });
    const g = groups.get(key);
    g.rows.push(r);
    g.months.add(`${r.year}-${r.month}`);
  });
  groups.forEach((g) => {
    const hours = story3SeasonMonths(g.season, g.year).reduce((s, [yy, mm]) => s + story3Hours(yy, mm), 0);
    g.pool = story3Pool(g.rows);
    g.present = g.months.size === 3;
    g.coverage = g.pool ? g.pool.valid / (data.stations.length * hours) : 0;
    g.flaggedStations = data.stations.filter((st) => g.rows.filter((r) => r.station === st).reduce((s, r) => s + r.valid, 0) / hours < STORY3_COMPLETE);
    g.ok = g.present && g.coverage >= STORY3_COMPLETE;
    if (!g.present) g.reason = `only ${g.months.size} of 3 months present`;
    else g.reason = g.coverage < STORY3_COMPLETE ? `valid observations cover ${(g.coverage * 100).toFixed(0)}% of expected hours` : '';
  });
  const list = [...groups.values()];
  const years = [...new Set(list.map((g) => g.year))].sort((a, b) => a - b);
  const get = (season, year) => groups.get(`${season}|${year}`);
  const comparable = years.filter((y) => get('Winter', y)?.ok && get('Summer', y)?.ok);
  const gaps = comparable.map((year) => {
    const winter = get('Winter', year).pool.mean;
    const summer = get('Summer', year).pool.mean;
    return { year, winter, summer, diff: winter - summer };
  });
  const outliers = [];
  if (gaps.length >= 4) {
    gaps.forEach((g) => {
      const median = story3Median(gaps.filter((o) => o !== g).map((o) => o.diff));
      if (median > 0 && (g.diff / median > 1.5 || g.diff / median < 0.5)) outliers.push({ year: g.year, diff: g.diff, ratio: g.diff / median });
    });
  }
  const sorted = [...gaps].sort((a, b) => a.diff - b.diff);
  return {
    groups,
    years,
    get,
    comparable,
    gaps,
    outliers,
    incomplete: list.filter((g) => !g.ok).sort((a, b) => a.year - b.year || STORY3_SEASONS.indexOf(a.season) - STORY3_SEASONS.indexOf(b.season)),
    positives: gaps.filter((g) => g.diff > 0).length,
    meanGap: gaps.length ? gaps.reduce((s, g) => s + g.diff, 0) / gaps.length : null,
    minGap: sorted[0] ?? null,
    maxGap: sorted[sorted.length - 1] ?? null,
    flaggedStations: comparable.reduce((n, y) => n + get('Winter', y).flaggedStations.length + get('Summer', y).flaggedStations.length, 0),
  };
}

function story3GroupName(g) {
  return `${g.season} ${g.year}`;
}

function story3TextSeasonal(model) {
  const { p, seasonal: s } = model;
  const skipped = s.incomplete.map((g) => `${story3GroupName(g)} (${g.reason})`);
  document.getElementById('story3-seasonal-note').textContent =
    'Winter for year Y = December of Y−1 plus January and February of Y. A season is compared only when all three months are present and valid observations cover at least 75% of the expected hours across stations. ' +
    `Comparable winter–summer years: ${story3Years(s.comparable)}. ` +
    `Kept visible but not compared: ${skipped.join('; ') || 'none'}. ` +
    `Station-seasons below 75% inside the comparable years: ${s.flaggedStations}.`;
  const el = document.getElementById('story3-seasonal-takeaway');
  if (!s.gaps.length) {
    el.textContent = `No year has both a comparable winter and a comparable summer for ${p}.`;
    return;
  }
  const n = s.gaps.length;
  const verdict = s.positives === n ? `winter was higher than summer in every one of the ${n} comparable years (${story3Years(s.comparable)})` : `winter was higher than summer in ${s.positives} of ${n} comparable years (${story3Years(s.comparable)})`;
  const parts = [
    `${p}: ${verdict}.`,
    `The winter-minus-summer difference averaged ${story3Signed(s.meanGap)}, ranging from ${story3Signed(s.minGap.diff)} in ${s.minGap.year} to ${story3Signed(s.maxGap.diff)} in ${s.maxGap.year}.`,
  ];
  s.outliers.forEach((o) => {
    parts.push(`The ${o.year} gap (${story3Signed(o.diff)}) is ${o.ratio.toFixed(1)} times the median of the other years; the source data for ${p} in that period have not been checked, so treat it with caution.`);
  });
  parts.push('These are descriptive differences; weather and emissions are not analysed.');
  el.textContent = parts.join(' ');
}

function story3SeasonHover(g) {
  const state = g.ok ? 'comparable' : `not compared: ${g.reason}`;
  return `${story3GroupName(g)}<br>Pooled mean ${story3Fmt(g.pool ? g.pool.mean : null)}<br>${g.months.size} of 3 months · ${(g.coverage * 100).toFixed(0)}% of expected hours<br>${g.flaggedStations.length} station(s) below 75%<br>${state}`;
}

function renderStory3Seasonal(model, target) {
  const { p, seasonal: s } = model;
  const mobile = story3Mobile();
  const label = (y) => (s.comparable.includes(y) ? String(y) : `${y} †`);
  const labels = s.years.map(label);
  const point = (g) => ({ x: g.pool.mean, y: label(g.year), g });
  const pick = (season, ok) => s.years.map((y) => s.get(season, y)).filter((g) => g && g.pool && g.ok === ok).map(point);
  const context = [...pick('Spring', true), ...pick('Autumn', true), ...pick('Spring', false), ...pick('Autumn', false)];
  const winter = pick('Winter', true);
  const summer = pick('Summer', true);
  const skipped = [...pick('Winter', false), ...pick('Summer', false)];
  const gapRows = s.gaps;
  const connectors = {
    type: 'scatter',
    mode: 'lines',
    x: gapRows.flatMap((g) => [g.winter, g.summer, null]),
    y: gapRows.flatMap((g) => [label(g.year), label(g.year), null]),
    line: { color: '#cbd5e0', width: 4 },
    hoverinfo: 'skip',
    showlegend: false,
  };
  const dots = (items, name, color, symbol, size) => ({
    type: 'scatter',
    mode: 'markers',
    name,
    x: items.map((i) => i.x),
    y: items.map((i) => i.y),
    marker: { color, symbol, size, line: { color: '#ffffff', width: 1 } },
    customdata: items.map((i) => story3SeasonHover(i.g)),
    hovertemplate: '%{customdata}<extra></extra>',
  });
  const traces = [
    connectors,
    {
      ...dots(context, 'Spring and autumn (context)', STORY3_COLORS.context, 'circle', 8),
      marker: { color: context.map((i) => (i.g.ok ? STORY3_COLORS.context : '#ffffff')), size: 8, line: { color: STORY3_COLORS.context, width: 1.5 } },
    },
    dots(winter, 'Winter (Dec–Feb)', STORY3_COLORS.winter, 'circle', mobile ? 12 : 14),
    dots(summer, 'Summer (Jun–Aug)', STORY3_COLORS.summer, 'diamond', mobile ? 12 : 14),
    {
      ...dots(skipped, 'Not compared (incomplete or low coverage)', '#ffffff', 'circle', mobile ? 12 : 14),
      marker: { color: '#ffffff', size: mobile ? 12 : 14, symbol: skipped.map((i) => (i.g.season === 'Winter' ? 'circle' : 'diamond')), line: { color: '#4a5568', width: 2 } },
    },
    {
      type: 'scatter',
      mode: 'text',
      x: gapRows.map((g) => Math.max(g.winter, g.summer)),
      y: gapRows.map((g) => label(g.year)),
      text: gapRows.map((g) => `<b>${story3Signed(g.diff)}</b>`),
      textposition: 'middle right',
      cliponaxis: false,
      textfont: { size: mobile ? 11 : 13, color: STORY3_COLORS.ink },
      showlegend: false,
      hoverinfo: 'skip',
    },
  ];
  const xs = [...context, ...winter, ...summer, ...skipped].map((i) => i.x);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const span = hi - lo || 1;
  const sub = s.gaps.length
    ? `Labels = winter minus summer. Average over ${story3Years(s.comparable)}: ${story3Signed(s.meanGap)}. † = year not compared.`
    : 'No comparable winter–summer years.';
  story3Plot(target, traces, {
    title: story3Title(`${p}: winter vs summer by year`, sub),
    xaxis: { title: `${p} pooled mean (units as recorded; not verified)`, range: [lo - span * 0.08, hi + span * 0.18], gridcolor: '#eef1f6', zeroline: false },
    yaxis: { type: 'category', categoryorder: 'array', categoryarray: labels, autorange: 'reversed', automargin: true, showgrid: false },
    legend: { orientation: 'h', x: 0, y: -0.2, yanchor: 'top', font: { size: mobile ? 10 : 12 } },
  });
}

function story3BuildStations(data, rows, seasonal) {
  const years = seasonal.comparable;
  const part = (own, season) => {
    const mine = [];
    let expected = 0;
    years.forEach((y) => story3SeasonMonths(season, y).forEach(([yy, mm]) => {
      expected += story3Hours(yy, mm);
      const r = own.find((x) => x.year === yy && x.month === mm);
      if (r) mine.push(r);
    }));
    const pool = story3Pool(mine);
    const valid = pool ? pool.valid : 0;
    return { mean: pool ? pool.mean : null, valid, coverage: expected ? valid / expected : 0, months: mine.length, monthsExpected: years.length * 3 };
  };
  const list = data.stations.map((station) => {
    const own = rows.filter((r) => r.station === station);
    const w = part(own, 'Winter');
    const s = part(own, 'Summer');
    const diff = w.mean !== null && s.mean !== null ? w.mean - s.mean : null;
    const reasons = [];
    [['winter', w], ['summer', s]].forEach(([name, x]) => {
      if (x.months < x.monthsExpected) reasons.push(`${name}: ${x.months} of ${x.monthsExpected} months present`);
      if (x.coverage < STORY3_COMPLETE) reasons.push(`${name}: ${(x.coverage * 100).toFixed(0)}% of expected hours`);
    });
    return { station, w, s, diff, flag: reasons.length > 0, reasons };
  });
  list.sort((a, b) => {
    if (a.diff === null || b.diff === null) return (a.diff === null) - (b.diff === null) || a.station.localeCompare(b.station);
    return b.diff - a.diff;
  });
  const withDiff = list.filter((x) => x.diff !== null);
  return {
    years,
    list,
    withDiff,
    positives: withDiff.filter((x) => x.diff > 0).length,
    median: story3Median(withDiff.map((x) => x.diff)),
    maxRow: withDiff[0] ?? null,
    minRow: withDiff[withDiff.length - 1] ?? null,
    flagged: list.filter((x) => x.flag),
  };
}

function story3TextStations(model) {
  const { p, stations: st } = model;
  document.getElementById('story3-stations-note').textContent =
    `Same comparable years for every station: ${story3Years(st.years)}. Each mark is the station's winter or summer mean over those years, weighted by valid observations. ` +
    `Hollow marks (†) are incomplete records, with missing months or under 75% of expected hours. They are kept and flagged: ${st.flagged.map((x) => x.station).join(', ') || 'none'}. ` +
    'Station IDs are shown as recorded; no location or station type is inferred from them.';
  const el = document.getElementById('story3-stations-takeaway');
  if (!st.withDiff.length) {
    el.textContent = `No station has both winter and summer data in the comparable years for ${p}.`;
  } else {
    el.textContent =
      `${p}: winter was higher than summer at ${st.positives} of ${st.withDiff.length} stations with both seasons (${story3Years(st.years)}). ` +
      `The winter-minus-summer difference ranged from ${story3Signed(st.minRow.diff)} (${st.minRow.station}) to ${story3Signed(st.maxRow.diff)} (${st.maxRow.station}); the median was ${story3Signed(st.median)}. ` +
      'Differences between stations are descriptive and are not adjusted for siting or monitor type.';
  }
  story3TextStationSelected(model);
}

function story3TextStationSelected(model) {
  const el = document.getElementById('story3-stations-selected');
  const x = model.stations.list.find((r) => r.station === story3State.station);
  if (!x) {
    el.textContent = 'Choose a station above to highlight it in the chart. All other stations stay visible.';
    return;
  }
  const flag = x.flag ? ` Incomplete record: ${x.reasons.join('; ')}.` : ' Record complete for these years.';
  el.textContent = `${x.station}: winter ${story3Fmt(x.w.mean)}, summer ${story3Fmt(x.s.mean)}, difference ${story3Signed(x.diff)}.${flag}`;
}

function renderStory3Stations(model, target) {
  const { p, stations: st } = model;
  const mobile = story3Mobile();
  const order = st.list.map((x) => x.station);
  const tick = (x) => {
    const text = x.flag ? `${x.station} †` : x.station;
    return x.station === story3State.station ? `<b>${text}</b>` : text;
  };
  const have = st.list.filter((x) => x.diff !== null);
  const size = (x) => (x.station === story3State.station ? (mobile ? 14 : 16) : (mobile ? 8 : 10));
  const info = (x) => `${x.station}${x.flag ? ' (incomplete record)' : ''}<br>Winter ${story3Fmt(x.w.mean)} · ${x.w.valid.toLocaleString('en-GB')} valid obs · ${(x.w.coverage * 100).toFixed(0)}% coverage<br>` +
    `Summer ${story3Fmt(x.s.mean)} · ${x.s.valid.toLocaleString('en-GB')} valid obs · ${(x.s.coverage * 100).toFixed(0)}% coverage<br>Winter − summer ${story3Signed(x.diff)}${x.flag ? `<br>${x.reasons.join('; ')}` : ''}`;
  const dots = (key, name, color, symbol) => ({
    type: 'scatter',
    mode: 'markers',
    name,
    x: have.map((x) => x[key].mean),
    y: have.map((x) => x.station),
    marker: {
      color: have.map((x) => (x.flag ? '#ffffff' : color)),
      symbol,
      size: have.map(size),
      line: { color, width: 2 },
    },
    customdata: have.map(info),
    hovertemplate: '%{customdata}<extra></extra>',
  });
  const missing = st.list.filter((x) => x.diff === null);
  const xs = have.flatMap((x) => [x.w.mean, x.s.mean]);
  const lo = xs.length ? Math.min(...xs) : 0;
  const hi = xs.length ? Math.max(...xs) : 1;
  const span = hi - lo || 1;
  const sel = order.indexOf(story3State.station);
  const traces = [
    {
      type: 'scatter',
      mode: 'lines',
      x: have.flatMap((x) => [x.w.mean, x.s.mean, null]),
      y: have.flatMap((x) => [x.station, x.station, null]),
      line: { color: '#cbd5e0', width: 3 },
      hoverinfo: 'skip',
      showlegend: false,
    },
    dots('s', 'Summer', STORY3_COLORS.summer, 'diamond'),
    dots('w', 'Winter', STORY3_COLORS.winter, 'circle'),
    {
      type: 'scatter',
      mode: 'markers',
      name: 'Hollow = incomplete record',
      x: [null],
      y: [null],
      marker: { color: '#ffffff', size: 10, line: { color: '#4a5568', width: 2 } },
      hoverinfo: 'skip',
    },
    {
      type: 'scatter',
      mode: 'text',
      x: missing.map(() => lo),
      y: missing.map((x) => x.station),
      text: missing.map(() => 'no comparable data'),
      textposition: 'middle right',
      showlegend: false,
      hoverinfo: 'skip',
    },
  ];
  story3Plot(target, traces, {
    title: story3Title(`${p}: winter vs summer by station`, `Same years for every station: ${story3Years(st.years)}. Sorted by winter minus summer. † = incomplete record.`),
    xaxis: { title: `${p} pooled mean (units as recorded; not verified)`, range: [lo - span * 0.06, hi + span * 0.06], gridcolor: '#eef1f6', zeroline: false },
    yaxis: {
      type: 'category',
      categoryorder: 'array',
      categoryarray: order,
      autorange: 'reversed',
      tickmode: 'array',
      tickvals: order,
      ticktext: st.list.map(tick),
      tickfont: { size: mobile ? 10 : 12 },
      automargin: true,
      gridcolor: '#f2f4f8',
      showgrid: true,
    },
    shapes: sel >= 0 ? [{ type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: sel - 0.5, y1: sel + 0.5, fillcolor: '#fff3bf', opacity: 0.75, line: { width: 0 }, layer: 'below' }] : [],
    margin: { t: 84, r: mobile ? 12 : 24, b: 78, l: mobile ? 96 : 120 },
  });
}

function renderStory3StationTable(model) {
  const host = document.getElementById('story3-stations-table');
  const { stations: st } = model;
  const head = ['Station ID', 'Winter mean', 'Summer mean', 'Winter − summer', 'Winter valid obs', 'Summer valid obs', 'Winter coverage', 'Summer coverage', 'Record'];
  const table = document.createElement('table');
  table.className = 'story3-table';
  const thead = table.createTHead().insertRow();
  head.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    thead.appendChild(th);
  });
  const body = table.createTBody();
  st.list.forEach((x) => {
    const tr = body.insertRow();
    if (x.station === story3State.station) tr.className = 'is-selected';
    [
      x.station,
      story3Fmt(x.w.mean),
      story3Fmt(x.s.mean),
      story3Signed(x.diff),
      x.w.valid.toLocaleString('en-GB'),
      x.s.valid.toLocaleString('en-GB'),
      `${(x.w.coverage * 100).toFixed(0)}%`,
      `${(x.s.coverage * 100).toFixed(0)}%`,
      x.flag ? `Incomplete: ${x.reasons.join('; ')}` : 'Complete',
    ].forEach((text) => {
      tr.insertCell().textContent = text;
    });
  });
  host.replaceChildren(table);
}

function story3BuildCoverage(data, rows, years) {
  const stationsP = new Set(rows.map((r) => r.station));
  const perStation = new Map();
  rows.forEach((r) => perStation.set(r.station, (perStation.get(r.station) ?? 0) + 1));
  const monthsPer = years.length * 12;
  const possible = stationsP.size * monthsPer;
  const possibleHours = stationsP.size * years.reduce((s, y) => s + story3YearHours(y), 0);
  return {
    stationsP: stationsP.size,
    present: rows.length,
    possible,
    below: rows.filter((r) => r.coverage < STORY3_COMPLETE).length,
    validShare: possibleHours ? rows.reduce((s, r) => s + r.valid, 0) / possibleHours : null,
    fullRecord: [...perStation.values()].filter((n) => n === monthsPer).length,
    balanced: data.balanced.length,
    monthsPer,
  };
}

function story3BuildFindings(model, data) {
  const { p, annual: a, monthly: m, seasonal: s, stations: st, years } = model;
  const out = [];
  const c = a.fullChange;
  const b = a.balChange;
  if (c) {
    const same = b && Math.sign(b.abs) === Math.sign(c.abs);
    out.push({
      title: 'Yearly level',
      text: `${p} was ${story3Fmt(Math.abs(c.abs))} ${story3Dir(c.abs)} in ${c.to} than in ${c.from} (${story3Pct(c.pct)}) across all stations with data` +
        (b ? `, and ${story3Signed(b.abs)} (${story3Pct(b.pct)}) on the balanced ${data.balanced.length}-station set. ${same ? 'Both comparisons point the same way.' : 'The two comparisons point in opposite directions, so the direction depends on which stations are included.'}` : '.'),
    });
  } else {
    out.push({ title: 'Yearly level', text: `No annual comparison is available for ${p}.` });
  }
  if (s.gaps.length) {
    let text = `Winter was higher than summer in ${s.positives} of ${s.gaps.length} comparable years (${story3Years(s.comparable)}); the gap averaged ${story3Signed(s.meanGap)}.`;
    if (st.withDiff.length) text += ` At station level winter was higher at ${st.positives} of ${st.withDiff.length} stations over the same years.`;
    if (s.outliers.length) text += ` The ${story3List(s.outliers.map((o) => o.year))} gap is unusually far from the other years, so treat it with caution.`;
    out.push({ title: 'Winter–summer gap', text });
  } else {
    out.push({ title: 'Winter–summer gap', text: `No year has both a comparable winter and a comparable summer for ${p}.` });
  }
  if (m.hiM !== null && m.peaks.length) {
    out.push({
      title: 'Month-by-month timing',
      text: `${STORY3_MONTHS[m.hiM]} had the highest ${story3Years(years)} average and was the highest month of its year in ${m.hiPeak} of ${m.peaks.length} years; ` +
        `${STORY3_MONTHS[m.loM]} was the lowest in ${m.loTrough} of ${m.peaks.length}.`,
    });
  } else {
    out.push({ title: 'Month-by-month timing', text: `Not every month has data in every year for ${p}, so recurrence is not reported.` });
  }
  return out;
}

function story3Model(data, p) {
  if (story3ModelCache.has(p)) return story3ModelCache.get(p);
  const rows = data.rows.filter((r) => r.pollutant === p);
  const years = [...new Set(data.rows.map((r) => r.year))].sort((x, y) => x - y);
  const seasonal = story3BuildSeasonal(data, rows);
  const model = {
    p,
    rows,
    years,
    annual: story3BuildAnnual(data, rows, years),
    monthly: story3BuildMonthly(rows, years),
    seasonal,
    stations: story3BuildStations(data, rows, seasonal),
    coverage: story3BuildCoverage(data, rows, years),
  };
  model.findings = story3BuildFindings(model, data);
  story3ModelCache.set(p, model);
  return model;
}

function story3UpdateText(model, data) {
  story3TextAnnual(model, data);
  story3TextMonthly(model);
  story3TextSeasonal(model);
  story3TextStations(model);
  renderStory3StationTable(model);
}

function story3PopulateStations(data) {
  const select = document.getElementById('story3-station');
  if (!select || select.options.length > 1) return;
  data.stations.forEach((st) => {
    const option = document.createElement('option');
    option.value = st;
    option.textContent = st;
    select.appendChild(option);
  });
  select.value = story3State.station;
}

function renderStory3Limits(model, data, target) {
  const { p, coverage: c, seasonal: s } = model;
  target.replaceChildren();
  const heading = document.createElement('h3');
  heading.className = 'story3-panel-heading';
  heading.textContent = `${p}: what the data support`;
  const findings = document.createElement('ol');
  findings.className = 'story3-findings';
  model.findings.forEach((f) => {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = f.title;
    const text = document.createElement('span');
    text.textContent = f.text;
    li.append(strong, text);
    findings.appendChild(li);
  });
  const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const indicators = document.createElement('div');
  indicators.className = 'story3-indicators';
  [
    [String(c.stationsP), `stations reporting ${p}`],
    [String(c.fullRecord), `stations with all ${c.monthsPer} months of ${p}`],
    [`${c.present} / ${c.possible}`, 'station-months present'],
    [String(c.below), 'station-months below 75% of hours (included, flagged)'],
    [pct(c.validShare), `of possible hourly readings are valid`],
    [String(c.balanced), 'stations in the balanced set (all pollutants, all months)'],
  ].forEach(([value, label]) => {
    const card = document.createElement('div');
    card.className = 'story3-indicator';
    const big = document.createElement('span');
    big.className = 'story3-indicator-value';
    big.textContent = value;
    const text = document.createElement('span');
    text.className = 'story3-indicator-label';
    text.textContent = label;
    card.append(big, text);
    indicators.appendChild(card);
  });
  target.append(heading, findings, indicators);
  const cautions = [];
  if (p === 'O3') cautions.push('O3 results are preliminary. Source-data concerns for this pollutant are not resolved, so read its findings cautiously.');
  s.outliers.forEach((o) => cautions.push(`The ${o.year} winter–summer gap (${story3Signed(o.diff)}) is ${o.ratio.toFixed(1)} times the median of the other years; its source data have not been checked.`));
  if (cautions.length) {
    const box = document.createElement('div');
    box.className = 'story3-caution';
    cautions.forEach((text) => {
      const line = document.createElement('p');
      line.textContent = text;
      box.appendChild(line);
    });
    target.appendChild(box);
  }
}


const story3ValidationEl = document.getElementById('story3-validation');

function story3DrawView(view, model, data, target) {
  if (view === 'annual') renderStory3Annual(model, data, target);
  else if (view === 'monthly') renderStory3Monthly(model, target);
  else if (view === 'seasonal') renderStory3Seasonal(model, target);
  else if (view === 'stations') renderStory3Stations(model, target);
  else renderStory3Limits(model, data, target);
}

// step may be null (a refresh triggered while another story owns the shared chart); then only inline mobile content updates.
async function renderStory3(step) {
  const token = story3Token;
  const view = step ? step.dataset.view : null;
  const mobile = story3Mobile();
  const p = story3State.pollutant;
  const data = await loadStory3();
  if (token !== story3Token) return;
  if (step) setStatus(`Story 3 (${p}): seasonal air quality, observation-weighted monthly summaries.`);
  const target = !step ? null : (view === 'limits' ? story3ValidationEl : chartEl);
  if (!data.rows.length || !data.rows.some((r) => r.pollutant === p)) {
    const message = `Story 3 monthly summary has no ${p} data (output/analysis/story3_monthly_summary.csv).`;
    if (mobile) STORY3_VIEWS.forEach((v) => { document.getElementById(`story3-inline-${v}`).textContent = message; });
    else if (target === chartEl) renderPlaceholder('Story 3 — Seasonal Air Quality', message);
    else if (target) target.textContent = message;
    return;
  }
  const model = story3Model(data, p);
  story3PopulateStations(data);
  story3UpdateText(model, data);
  if (mobile) {
    const key = `${p}|${story3State.station}`;
    STORY3_VIEWS.forEach((v) => {
      if (story3Drawn.get(v) === key) return;
      story3DrawView(v, model, data, document.getElementById(`story3-inline-${v}`));
      story3Drawn.set(v, key);
    });
  } else if (target) {
    story3DrawView(view, model, data, target);
  }
}

function story3ActiveStep() {
  const active = document.querySelector('.step.is-active');
  return active && active.dataset.story === 'story3' ? active : null;
}

function setStory3Pollutant(value) {
  story3State.pollutant = value;
  document.querySelectorAll('.story3-pollutant').forEach((el) => { el.value = value; });
  story3Token += 1;
  story3Drawn.clear();
  renderStory3(story3ActiveStep());
}

function setStory3Station(value) {
  story3State.station = value;
  const select = document.getElementById('story3-station');
  if (select) select.value = value;
  story3Token += 1;
  story3Drawn.delete('stations');
  renderStory3(story3ActiveStep());
}

function activateStep(step) {
  story2Token += 1;
  story3Token += 1;
  document.querySelectorAll('.step').forEach((el) => el.classList.remove('is-active'));
  step.classList.add('is-active');
  const story = step.dataset.story;
  // Stories 1 and 4 have no verified station coordinates, so the map is hidden to give the charts more room.
  const isStory1 = story === 'story1';
  const isStory2 = story === 'story2';
  const isStory3 = story === 'story3';
  const isStory4 = story === 'story4';
  const story2Limits = isStory2 && step.dataset.view === 'limits';
  const story3Limits = isStory3 && step.dataset.view === 'limits';
  if (!isStory2) story2SharedView = null;
  // Stories 1, 2, 3 and 4 hide the decorative reference map; the intro keeps it.
  mapEl.hidden = isStory1 || isStory2 || isStory3 || isStory4;
  vizEl.classList.toggle('viz-panel--inline', isStory2 || isStory3);
  const wasChartHidden = chartEl.hidden;
  chartEl.hidden = story2Limits || story3Limits;
  validationEl.hidden = !story2Limits;
  story3ValidationEl.hidden = !story3Limits;
  if (wasChartHidden && !chartEl.hidden && chartEl.data) Plotly.Plots.resize(chartEl);
  chartEl.classList.toggle('chart--tall', isStory1 || isStory4 || (isStory2 && step.dataset.view === 'stations') || (isStory3 && (step.dataset.view === 'monthly' || step.dataset.view === 'stations')));
  if (!mapEl.hidden && map) map.invalidateSize();
  if (story === 'story1') return renderStory1();
  if (story === 'story2') return renderStory2(step);
  if (story === 'story3') return renderStory3(step);
  if (story === 'story4') return renderStory4();
  setStatus('Intro: inspect repository data first, then run preprocessing scripts.');
  renderPlaceholder('Hong Kong Air Pollution Data Storytelling', 'Scroll to enter story sections.');
}

STORY2_MOBILE.addEventListener('change', () => {
  story2SharedView = null;
  story2InlineDrawn.clear();
  story3Drawn.clear();
  const active = document.querySelector('.step.is-active');
  if (active && (active.dataset.story === 'story2' || active.dataset.story === 'story3')) activateStep(active);
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

  // Story 1, 2 and 3 steps are taller than the 45% threshold allows, so they use the middle-band observer.
  document.querySelectorAll('.step').forEach((step) => {
    const useBand = ['story1', 'story2', 'story3'].includes(step.dataset.story);
    (useBand ? story1Observer : observer).observe(step);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  ensureMap();
  document.querySelectorAll('.story3-pollutant').forEach((el) => {
    el.addEventListener('change', () => setStory3Pollutant(el.value));
  });
  const stationSelect = document.getElementById('story3-station');
  if (stationSelect) stationSelect.addEventListener('change', () => setStory3Station(stationSelect.value));
  initObserver();
  const intro = document.querySelector('.step[data-story="intro"]');
  if (intro) activateStep(intro);
});
