// Mount Kenya Wildfire Risk Monitor: map and interface behaviour

const $ = id => document.getElementById(id);
const fmt = (v, d = 0) => (v == null ? "n/a" : Number(v).toFixed(d));

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------
const BANDS = [
  { name: "Low",       color: "#2E9E5B", cls: "b0" },
  { name: "Moderate",  color: "#F2C94C", cls: "b1" },
  { name: "High",      color: "#F2994A", cls: "b2" },
  { name: "Very High", color: "#D64545", cls: "b3" }
];
const HISTORY = [
  { label: "0 years",   color: "#2E9E5B", test: n => n === 0 },
  { label: "1–2 years", color: "#F2C94C", test: n => n >= 1 && n <= 2 },
  { label: "3–5 years", color: "#F2994A", test: n => n >= 3 && n <= 5 },
  { label: "6+ years",  color: "#D64545", test: n => n >= 6 }
];
const histIndex = n => { const i = HISTORY.findIndex(l => l.test(n)); return i < 0 ? 0 : i; };

const CONDITIONS = [
  { key: "ndvi", label: "Vegetation greenness", hint: "NDVI: higher = greener",       digits: 2, unit: "" },
  { key: "ndmi", label: "Vegetation moisture",  hint: "NDMI: lower = drier",          digits: 2, unit: "" },
  { key: "lst",  label: "Surface temperature",  hint: "Land surface temperature",     digits: 1, unit: " °C" },
  { key: "rain", label: "Rainfall this period", hint: "Total over the 8 days",        digits: 0, unit: " mm" }
];
const SERIES = {
  score: { label: "Model risk score",              digits: 3, unit: "" },
  ndvi:  { label: "Vegetation greenness (NDVI)",   digits: 2, unit: "" },
  ndmi:  { label: "Vegetation moisture (NDMI)",    digits: 2, unit: "" },
  lst:   { label: "Land surface temperature",      digits: 1, unit: " °C" },
  rain:  { label: "Rainfall per period",           digits: 0, unit: " mm" }
};
const TABS = [["score", "Risk"], ["ndvi", "NDVI"], ["ndmi", "NDMI"], ["lst", "Temp"], ["rain", "Rain"]];

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
const state = {
  mode: "risk",        // "risk" or "history"
  risk: {},            // cell_id -> [score, band, fire_followed]
  bandStats: [],       // back-test track record per band
  selectedId: null,    // the clicked cell
  hist: null,          // last 12 periods for the clicked cell
  tab: "score"         // chart tab
};
let layer = null;
const cellLayers = {};  // cell_id -> { layer, p }
let allProps = [];

// ------------------------------------------------------------------
// Dates and small helpers
// ------------------------------------------------------------------
function fmtDate(iso, withYear) {
  const d = new Date(iso + "T00:00:00");
  const opts = { day: "numeric", month: "short" };
  if (withYear) opts.year = "numeric";
  return d.toLocaleDateString("en-GB", opts);
}

function showBanner(message, retry) {
  const b = $("banner");
  b.innerHTML = `<span>${message}</span>` + (retry ? `<button id="retryBtn">Retry</button>` : "");
  b.hidden = false;
  if (retry) $("retryBtn").onclick = retry;
}
const hideBanner = () => { $("banner").hidden = true; };

function trackLine(band) {
  const b = state.bandStats[band];
  if (!b) return "";
  const oneIn = b.one_in ? `about 1 in ${b.one_in.toLocaleString()}` : "none";
  return `In back-testing, ${oneIn} cells rated ${b.name} had a new fire in the next 8 days (${b.lift}× the average).`;
}

// ------------------------------------------------------------------
// Map
// ------------------------------------------------------------------
const map = L.map("map", { zoomControl: false }).setView([-0.15, 37.31], 10);

const street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors"
});
const terrain = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | Style: &copy; OpenTopoMap (CC-BY-SA)"
});
const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics"
});
street.addTo(map);
L.control.layers({ "Street": street, "Terrain": terrain, "Satellite": satellite }, null, { position: "topright" }).addTo(map);
L.control.zoom({ position: "bottomright" }).addTo(map);

L.DomEvent.disableClickPropagation($("periodCard"));
L.DomEvent.disableScrollPropagation($("periodCard"));

const legendDiv = L.DomUtil.create("div", "legend");
const legendControl = L.control({ position: "bottomleft" });
legendControl.onAdd = () => legendDiv;
legendControl.addTo(map);

function updateLegend() {
  if (state.mode === "risk") {
    legendDiv.innerHTML = "<b>Relative risk rank</b><br>" +
      BANDS.map(b => `<i style="background:${b.color}"></i>${b.name}`).join("<br>") +
      `<br><i style="background:#9aa3a0;opacity:.4"></i>No score` +
      `<br><i style="background:#fff;border:3px solid #0B3D91"></i>New fire followed` +
      "<br><small>A ranking, not a forecast. Each square = 1 km × 1 km</small>";
  } else {
    legendDiv.innerHTML = "<b>Years with fire<br>(2001–2025)</b><br>" +
      HISTORY.map(l => `<i style="background:${l.color}"></i>${l.label}`).join("<br>") +
      "<br><small>Each square = 1 km × 1 km</small>";
  }
}

function styleFor(feature) {
  const p = feature.properties;
  let fill, opacity = 0.6, border = "#6b7570", weight = 0.5;

  if (state.mode === "history") {
    fill = HISTORY[histIndex(p.years_burned)].color;
    opacity = 0.55;
  } else {
    const r = state.risk[p.cell_id];
    fill = r ? BANDS[r[1]].color : "#9aa3a0";
    opacity = r ? 0.6 : 0.15;
    if (r && r[2] === 1 && $("showFires").checked) { border = "#0B3D91"; weight = 3; }
  }
  if (p.cell_id === state.selectedId) { border = "#111"; weight = 4; }
  return { color: border, weight: weight, fillColor: fill, fillOpacity: opacity };
}
const refreshMap = () => { if (layer) layer.setStyle(styleFor); };

function tooltipText(p) {
  const where = `${fmt(p.lat, 3)}°, ${fmt(p.lon, 3)}°`;
  if (state.mode === "history") return `${where} | burned in ${p.years_burned} of 25 years`;
  const r = state.risk[p.cell_id];
  return `${where} | ${r ? BANDS[r[1]].name + " risk rank" : "no score"}`;
}

// ------------------------------------------------------------------
// Sidebar: summary
// ------------------------------------------------------------------
function barHtml(counts, colors, labels) {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const segments = counts.map((c, i) => c
    ? `<div style="width:${(100 * c / total).toFixed(2)}%;background:${colors[i]}" title="${labels[i]}: ${c}"></div>` : "").join("");
  const rows = counts.map((c, i) =>
    `<div class="legend-row"><span class="dot" style="background:${colors[i]}"></span>${labels[i]}` +
    `<span class="count">${c.toLocaleString()}</span><span class="pct">${(100 * c / total).toFixed(1)}%</span></div>`).join("");
  return `<div class="stackbar">${segments}</div>${rows}`;
}

function trackHtml() {
  if (!state.bandStats.length) return "";
  const rows = state.bandStats.map((b, i) =>
    `<tr><td><span class="dot" style="background:${BANDS[i].color}"></span>${b.name}</td>` +
    `<td>${b.one_in ? "1 in " + b.one_in.toLocaleString() : "none seen"}</td>` +
    `<td>${b.lift}×</td></tr>`).join("");
  return `<table class="track"><tr><th>Rank</th><th>Fire in next 8 days</th><th>vs average</th></tr>${rows}</table>` +
         `<p class="small muted">From back-testing on years the model never saw.</p>`;
}

function riskSummaryHtml() {
  const entries = Object.entries(state.risk);
  const range = $("periodDates").textContent;
  if (!entries.length) {
    return `<p class="sub">${range}</p><div class="empty">No scores for this period. The first months of 2001 and the final periods of the data have none.</div>`;
  }
  const counts = [0, 0, 0, 0];
  let fires = 0, firesHigh = 0;
  entries.forEach(([, r]) => {
    counts[r[1]]++;
    if (r[2]) { fires++; if (r[1] >= 2) firesHigh++; }
  });
  const top = entries.slice().sort((a, b) => b[1][0] - a[1][0]).slice(0, 10);
  const rows = top.map(([id, r], i) => {
    const p = cellLayers[id] ? cellLayers[id].p : null;
    if (!p) return "";
    return `<button class="toprow" data-id="${id}"><span class="rank">${i + 1}</span>` +
      `<span class="badge ${BANDS[r[1]].cls}">${BANDS[r[1]].name}</span>` +
      `<span class="loc">${fmt(p.lat, 3)}°, ${fmt(p.lon, 3)}°<small>${fmt(p.elevation)} m</small></span>` +
      `<span class="score">${r[0].toFixed(3)}</span>` +
      (r[2] ? `<span class="firedot" title="A new fire followed">●</span>` : "") + `</button>`;
  }).join("");

  return `<p class="sub">${range}</p>
    <div class="tiles">
      <div class="tile"><b>${entries.length.toLocaleString()}</b><span>cells scored</span></div>
      <div class="tile"><b>${counts[2] + counts[3]}</b><span>High or Very High</span></div>
      <div class="tile"><b>${fires}</b><span>new fires followed</span></div>
    </div>
    <p class="small muted">${fires
      ? `${firesHigh} of ${fires} fire cell${fires > 1 ? "s were" : " was"} rated High or Very High.`
      : "No new fire started in the 8 days after this period."}</p>
    <h3>Cells by risk rank</h3>
    ${barHtml(counts, BANDS.map(b => b.color), BANDS.map(b => b.name))}
    <h3>Highest-risk areas</h3>
    <div class="hint">Ranked by model score. Click a row to zoom to it.</div>
    ${rows}
    <h3>Back-test track record</h3>
    ${trackHtml()}`;
}

function historySummaryHtml() {
  const counts = [0, 0, 0, 0];
  let events = 0;
  allProps.forEach(p => { counts[histIndex(p.years_burned)]++; events += p.fire_events || 0; });
  const burned = allProps.length - counts[0];
  const top = allProps.slice().sort((a, b) => b.years_burned - a.years_burned).slice(0, 10);
  const rows = top.map((p, i) =>
    `<button class="toprow" data-id="${p.cell_id}"><span class="rank">${i + 1}</span>` +
    `<span class="loc">${fmt(p.lat, 3)}°, ${fmt(p.lon, 3)}°<small>${fmt(p.elevation)} m</small></span>` +
    `<span class="score">${p.years_burned} yrs</span></button>`).join("");
  return `<p class="sub">Years (out of 25) with a new fire, 2001–2025</p>
    <div class="tiles">
      <div class="tile"><b>${allProps.length.toLocaleString()}</b><span>cells in the study area</span></div>
      <div class="tile"><b>${burned}</b><span>ever burned</span></div>
      <div class="tile"><b>${events}</b><span>fire events</span></div>
    </div>
    <h3>Cells by years burned</h3>
    ${barHtml(counts, HISTORY.map(l => l.color), HISTORY.map(l => l.label))}
    <h3>Most-burned areas</h3>
    <div class="hint">Click a row to zoom to it.</div>
    ${rows}`;
}

function renderSummary() {
  $("summaryBody").innerHTML = state.mode === "risk" ? riskSummaryHtml() : historySummaryHtml();
}

// ------------------------------------------------------------------
// Sidebar: cell detail
// ------------------------------------------------------------------
function conditionsHtml(hist) {
  const cur = hist[hist.length - 1];
  const prev = hist.length > 1 ? hist[hist.length - 2] : null;
  const cards = CONDITIONS.map(c => {
    const v = cur[c.key];
    let delta = "";
    if (v != null && prev && prev[c.key] != null) {
      const d = v - prev[c.key];
      delta = `<small>${d > 0 ? "▲ +" : d < 0 ? "▼ " : "• "}${d.toFixed(c.digits)} vs previous period</small>`;
    }
    return `<div class="cond"><span class="clabel">${c.label}</span>` +
      `<b>${v == null ? "n/a" : v.toFixed(c.digits) + c.unit}</b>${delta}<span class="chint">${c.hint}</span></div>`;
  }).join("");
  return `<h3>Conditions this period</h3><div class="conds">${cards}</div>`;
}

function dataNoteHtml(hist) {
  const cur = hist[hist.length - 1];
  if (cur.ndvi == null && cur.lst == null) {
    return `<div class="note info">No satellite readings are stored for this cell and period (for example, a fire was already burning).</div>`;
  }
  const parts = [];
  if (cur.ndvi_age > 0) parts.push(`vegetation readings are ${cur.ndvi_age} period${cur.ndvi_age > 1 ? "s" : ""} old`);
  if (cur.lst_age > 0) parts.push(`temperature is ${cur.lst_age} period${cur.lst_age > 1 ? "s" : ""} old`);
  return parts.length
    ? `<div class="note">Cloud cover: ${parts.join(" and ")}. The last clear reading is carried forward.</div>`
    : `<div class="note info">Satellite readings for this cell are from this period.</div>`;
}

function chartHtml(hist) {
  const key = state.tab, s = SERIES[key];
  const tabs = TABS.map(([k, l]) => `<button class="tab ${k === key ? "active" : ""}" data-tab="${k}">${l}</button>`).join("");
  const vals = hist.map(h => h[key]).filter(v => v != null);
  let svg;
  if (!vals.length) {
    svg = `<div class="empty small">No values stored for this cell in these periods.</div>`;
  } else {
    const W = 330, H = 140, L = 40, R = 10, T = 10, B = 24;
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min -= 1; max += 1; }
    const x = i => L + (W - L - R) * (hist.length > 1 ? i / (hist.length - 1) : 0.5);
    const y = v => T + (H - T - B) * (1 - (v - min) / (max - min));
    let path = "", pen = false, dots = "";
    hist.forEach((h, i) => {
      const v = h[key];
      if (v == null) { pen = false; return; }
      path += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
      const last = i === hist.length - 1;
      dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${last ? 4 : 2.5}" ` +
              `fill="${last ? "#1F4D3A" : "#fff"}" stroke="#1F4D3A" stroke-width="1.5"/>`;
      if (h.fire_next === 1) {
        dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="8" fill="none" stroke="#0B3D91" stroke-width="2"/>`;
      }
    });
    svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${s.label} over the last 12 periods">
      <line class="grid" x1="${L}" y1="${T}" x2="${W - R}" y2="${T}"/>
      <line class="grid" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>
      <text x="${L - 6}" y="${T + 4}" text-anchor="end">${max.toFixed(s.digits)}</text>
      <text x="${L - 6}" y="${H - B + 4}" text-anchor="end">${min.toFixed(s.digits)}</text>
      <text x="${L}" y="${H - 6}">${hist[0].label}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end">${hist[hist.length - 1].label}</text>
      <path d="${path}" fill="none" stroke="#1F4D3A" stroke-width="2"/>${dots}</svg>`;
  }
  const anyFire = hist.some(h => h.fire_next === 1);
  return `<h3>Last 12 periods</h3><div class="tabs">${tabs}</div>
    <div class="small muted">${s.label}${s.unit ? " (" + s.unit.trim() + ")" : ""}</div>${svg}
    ${anyFire ? `<p class="small muted"><span class="ring"></span> A new fire followed that period.</p>` : ""}`;
}

function renderCell() {
  const id = state.selectedId;
  if (!id || !cellLayers[id]) return;
  const p = cellLayers[id].p;
  const where = `${fmt(p.lat, 3)}°, ${fmt(p.lon, 3)}°`;
  const gmaps = `<a class="gmaps" href="https://www.google.com/maps?q=${p.lat},${p.lon}" target="_blank" rel="noopener">Open in Google Maps ↗</a>`;
  const terrainHtml = `<h3>Terrain</h3><div class="tiles two">
      <div class="tile"><b>${fmt(p.elevation)} m</b><span>elevation</span></div>
      <div class="tile"><b>${fmt(p.slope, 1)}°</b><span>slope</span></div></div>`;
  const burned = `<p class="small">Burned in <b>${p.years_burned}</b> of 25 years (2001–2025).</p>`;
  const body = $("cellBody");

  if (state.mode === "history") {
    body.innerHTML = `<h2>Cell at ${where}</h2><p class="small muted">ID ${id}</p>${burned}${terrainHtml}
      <div class="note info">Switch to <b>Predicted risk</b> to see conditions and the risk trend for this cell.</div>${gmaps}`;
    return;
  }

  const r = state.risk[id];
  let head;
  if (r) {
    const entries = Object.values(state.risk);
    const rank = 1 + entries.filter(x => x[0] > r[0]).length;
    head = `<div class="headrow"><span class="badge lg ${BANDS[r[1]].cls}">${BANDS[r[1]].name} risk rank</span>
        <span class="muted">Model score ${r[0].toFixed(3)}</span></div>
      <p class="small muted">Ranked #${rank} of ${entries.length.toLocaleString()} cells this period</p>
      <p class="small">${trackLine(r[1])}</p>`;
  } else {
    head = `<p class="small muted">No score for this cell in this period.</p>`;
  }
  const outcome = r
    ? `<p class="small">A new fire started in the following 8 days: <b>${r[2] ? "Yes" : "No"}</b></p>` : "";

  let detail;
  if (state.hist === null) {
    detail = `<div class="loading"><span class="spinner"></span>Loading conditions…</div>`;
  } else if (state.hist === "error") {
    detail = `<div class="note">Could not load conditions for this cell.</div>`;
  } else {
    detail = conditionsHtml(state.hist) + dataNoteHtml(state.hist) + chartHtml(state.hist);
  }

  body.innerHTML = `<h2>Cell at ${where}</h2><p class="small muted">ID ${id}</p>
    ${head}${outcome}${detail}${terrainHtml}${burned}${gmaps}`;
}

async function loadCell() {
  const id = state.selectedId;
  if (!id) return;
  try {
    const url = `/api/cell?cell_id=${encodeURIComponent(id)}&year=${$("year").value}&period=${$("period").value}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("bad response");
    const d = await res.json();
    if (id !== state.selectedId) return;      // the user clicked another cell meanwhile
    state.hist = d.history;
  } catch (err) {
    state.hist = "error";
  }
  renderCell();
}

function selectCell(id, zoom) {
  const c = cellLayers[id];
  if (!c) return;
  state.selectedId = id;
  state.hist = null;
  refreshMap();
  c.layer.bringToFront();
  if (zoom) map.fitBounds(c.layer.getBounds(), { maxZoom: 13 });
  $("summaryView").hidden = true;
  $("cellView").hidden = false;
  $("sidebar").scrollTop = 0;
  renderCell();
  if (state.mode === "risk") loadCell();
}

function clearSelection() {
  state.selectedId = null;
  $("cellView").hidden = true;
  $("summaryView").hidden = false;
  refreshMap();
}

// ------------------------------------------------------------------
// Loading the risk scores for the chosen period
// ------------------------------------------------------------------
async function loadRisk() {
  hideBanner();
  if (!$("periodDates").dataset.loaded) {
    $("summaryBody").innerHTML = `<div class="loading"><span class="spinner"></span>Loading risk map…</div>`;
  }
  try {
    const res = await fetch(`/api/risk?year=${$("year").value}&period=${$("period").value}`);
    if (!res.ok) throw new Error("Server returned " + res.status);
    const d = await res.json();
    state.risk = d.cells;
    state.bandStats = d.bands || [];
    $("periodDates").textContent = `${fmtDate(d.start)} – ${fmtDate(d.end, true)}`;
    $("periodDates").dataset.loaded = "1";
    refreshMap();
    renderSummary();
    if (state.selectedId) { state.hist = null; renderCell(); loadCell(); }
  } catch (err) {
    showBanner("Could not load the risk data. Check that the server is running.", loadRisk);
  }
}

// ------------------------------------------------------------------
// Controls
// ------------------------------------------------------------------
for (let y = 2001; y <= 2025; y++) $("year").add(new Option(y, y));
$("year").value = 2019;

function step(delta) {
  let y = +$("year").value, p = +$("period").value + delta;
  if (p < 0)  { if (y > 2001) { y--; p = 45; } else p = 0; }
  if (p > 45) { if (y < 2025) { y++; p = 0; }  else p = 45; }
  $("year").value = y;
  $("period").value = p;
  $("periodNum").textContent = p + 1;
  loadRisk();
}

$("year").addEventListener("change", loadRisk);
$("period").addEventListener("input", () => { $("periodNum").textContent = +$("period").value + 1; });
$("period").addEventListener("change", loadRisk);
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
$("showFires").addEventListener("change", refreshMap);

function setMode(mode) {
  state.mode = mode;
  $("modeRisk").classList.toggle("active", mode === "risk");
  $("modeHistory").classList.toggle("active", mode === "history");
  $("periodCard").hidden = mode === "history";
  updateLegend();
  refreshMap();
  renderSummary();
  if (state.selectedId) {
    if (mode === "risk") { state.hist = null; renderCell(); loadCell(); } else renderCell();
  }
}
$("modeRisk").addEventListener("click", () => setMode("risk"));
$("modeHistory").addEventListener("click", () => setMode("history"));

// Clicking a row in the lists, a chart tab, or the back button
$("summaryBody").addEventListener("click", e => {
  const row = e.target.closest(".toprow");
  if (row) selectCell(row.dataset.id, true);
});
$("cellBody").addEventListener("click", e => {
  const tab = e.target.closest(".tab");
  if (tab) { state.tab = tab.dataset.tab; renderCell(); }
});
$("backBtn").addEventListener("click", clearSelection);

// About page
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && state.selectedId) clearSelection();
});
window.addEventListener("resize", () => map.invalidateSize());

// ------------------------------------------------------------------
// Start: load the grid, then the first period
// ------------------------------------------------------------------
$("periodNum").textContent = +$("period").value + 1;
updateLegend();

fetch("/api/grid")
  .then(r => r.json())
  .then(data => {
    allProps = data.features.map(f => f.properties);
    layer = L.geoJSON(data, {
      style: styleFor,
      onEachFeature: (feature, cell) => {
        const p = feature.properties;
        cellLayers[p.cell_id] = { layer: cell, p: p };
        cell.bindTooltip(() => tooltipText(p), { sticky: true });
        cell.on("click", () => selectCell(p.cell_id, false));
      }
    }).addTo(map);
    map.fitBounds(layer.getBounds());
    setTimeout(() => map.invalidateSize(), 0);
    loadRisk();
  })
  .catch(() => showBanner("Could not load the map grid. Check that the server is running."));