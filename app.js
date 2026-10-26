"use strict";

// Forecast data: MET Norway Locationforecast 2.0 (the same data yr.no uses).
// Browsers can't set a User-Agent, so MET identifies this app by its Origin header.
// Their terms: plain GET requests only, coordinates at most 4 decimals, respect Expires.
const FORECAST_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
// Long-range (21-day) daily forecast from MET Norway. Only covers Norway, Sweden, Finland and Denmark.
const LONG_RANGE_URL = "https://api.met.no/weatherapi/subseasonal/1.0/complete";
// Place names: OpenStreetMap Nominatim. Only queried on submit (no search-as-you-type).
const GEOCODE_URL = "https://nominatim.openstreetmap.org";

const HOUR = 3600 * 1000;

const $ = (id) => document.getElementById(id);

// ---------- Storage (wrapped: private mode or blocked storage must not break the app) ----------

const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

// ---------- Helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Three decimals is ~100 m: plenty for weather, and nearby lookups share a cache entry.
const roundCoord = (n) => Math.round(n * 1000) / 1000;

const iconUrl = (symbol) => `icons/weather/${symbol}.svg`;

const tempClass = (t) => (t > 0 ? "warm" : "cold");
const fmtTemp = (t) => `${Math.round(t)}°`;
const fmtPrecip = (mm) => (mm >= 0.05 ? `${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm` : "");
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

// Arrow points the way the wind blows (MET gives the direction it comes from).
function windArrow(fromDeg) {
  return `<svg viewBox="0 0 24 24" style="transform:rotate(${fromDeg + 180}deg)" aria-hidden="true">
    <path d="M12 3 6 15h4.5v6h3v-6H18Z" fill="currentColor"/></svg>`;
}

const RAIN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11Z" fill="currentColor"/></svg>`;
const HUMIDITY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11Z" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// ---------- Data fetching ----------

// Fetches JSON from MET, keeping a copy until its Expires time (and as an offline fallback).
async function cachedJson(url, key) {
  const cached = store.get(key);
  if (cached && Date.now() < cached.expires) return cached;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    if (cached) return { ...cached, offline: true };
    throw new Error("No connection. Check your internet and try again.");
  }
  if (!res.ok) {
    if (cached) return { ...cached, offline: true };
    const err = new Error(`The forecast service answered with an error (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const expires = Date.parse(res.headers.get("Expires")) || Date.now() + 30 * 60 * 1000;
  const entry = { expires, data };
  store.set(key, entry);
  return entry;
}

const getForecast = (lat, lon) => cachedJson(`${FORECAST_URL}?lat=${lat}&lon=${lon}`, `forecast:${lat},${lon}`);
const getLongRange = (lat, lon) => cachedJson(`${LONG_RANGE_URL}?lat=${lat}&lon=${lon}`, `longrange:${lat},${lon}`);

async function reverseGeocode(lat, lon) {
  const lang = encodeURIComponent(navigator.language || "en");
  const res = await fetch(`${GEOCODE_URL}/reverse?format=jsonv2&zoom=12&lat=${lat}&lon=${lon}&accept-language=${lang}`);
  if (!res.ok) return null;
  const j = await res.json();
  const a = j.address || {};
  return a.city || a.town || a.village || a.suburb || a.municipality || a.county || j.name || null;
}

async function searchPlaces(query) {
  const lang = encodeURIComponent(navigator.language || "en");
  const res = await fetch(`${GEOCODE_URL}/search?format=jsonv2&limit=8&addressdetails=1&accept-language=${lang}&q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error("Search failed");
  const list = await res.json();
  return list.map((p) => {
    const a = p.address || {};
    const name = p.name || a.city || a.town || a.village || p.display_name.split(",")[0];
    const region = [a.state || a.county, a.country].filter(Boolean).join(", ");
    return { name, region, lat: roundCoord(+p.lat), lon: roundCoord(+p.lon) };
  });
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Location isn't available on this device."));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: roundCoord(pos.coords.latitude), lon: roundCoord(pos.coords.longitude) }),
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED
        ? "Location access is off. Allow it in Settings, or search for a place."
        : "Couldn't find your location. Try again or search for a place.")),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

// ---------- Turning the timeseries into what we show ----------

function currentEntry(series, now) {
  return series.find((e) => Date.parse(e.time) + HOUR > now) || series[0];
}

function hourlyEntries(series, now) {
  return series
    .filter((e) => e.data.next_1_hours && Date.parse(e.time) + HOUR > now)
    .slice(0, 24);
}

// Groups the forecast into local calendar days: min/max temperature, total precipitation,
// and a daytime symbol (the 6-hour period starting closest to noon).
function dailySummaries(series, now) {
  const days = new Map();
  let coveredUntil = 0; // avoid counting the same rain twice when 1h and 6h periods overlap

  for (const e of series) {
    const t = new Date(e.time);
    const ms = t.getTime();
    if (ms + HOUR <= now) continue;

    const key = dayKey(t);
    let day = days.get(key);
    if (!day) {
      day = { date: t, min: Infinity, max: -Infinity, precip: 0, symbol: null, symbolDist: Infinity, entries: [] };
      days.set(key, day);
    }
    day.entries.push(e);

    const temp = e.data.instant.details.air_temperature;
    day.min = Math.min(day.min, temp);
    day.max = Math.max(day.max, temp);

    if (ms >= coveredUntil) {
      const period = e.data.next_1_hours || e.data.next_6_hours;
      if (period) {
        day.precip += period.details?.precipitation_amount ?? 0;
        coveredUntil = ms + (e.data.next_1_hours ? 1 : 6) * HOUR;
      }
    }

    const sixHour = e.data.next_6_hours?.summary?.symbol_code;
    if (sixHour) {
      const dist = Math.abs(t.getHours() - 12);
      if (dist < day.symbolDist) {
        day.symbol = sixHour;
        day.symbolDist = dist;
      }
    }
  }

  return [...days.values()].filter((d) => d.symbol);
}

// ---------- Rendering ----------

const nowSymbol = (entry) => (entry.data.next_1_hours || entry.data.next_6_hours).summary.symbol_code;

// Some symbols (cloudy, rain, fog…) have no _day/_night suffix, so borrow it from nearby hours.
function dayPeriod(series, index) {
  for (let off = 0; off < 6; off++) {
    for (const i of [index + off, index - off]) {
      const suffix = series[i]?.data.next_1_hours?.summary.symbol_code.split("_")[1];
      if (suffix) return suffix;
    }
  }
  const hour = new Date().getHours();
  return hour >= 7 && hour < 19 ? "day" : "night";
}

function renderNow(entry) {
  const d = entry.data.instant.details;
  const symbol = nowSymbol(entry);
  const precip = entry.data.next_1_hours?.details?.precipitation_amount ?? 0;

  $("now").innerHTML = `
    <div class="temp">${fmtTemp(d.air_temperature)}</div>
    <img class="icon" src="${iconUrl(symbol)}" alt="${esc(symbol.replace(/_/g, " "))}">
    <div class="facts">
      <span class="fact">${windArrow(d.wind_from_direction)} ${Math.round(d.wind_speed)} m/s</span>
      <span class="fact">${RAIN_ICON} ${precip.toFixed(1)} mm next hour</span>
      <span class="fact">${HUMIDITY_ICON} ${Math.round(d.relative_humidity)}%</span>
    </div>`;
  $("now").hidden = false;
}

function renderHourly(entries) {
  $("hourly").innerHTML = entries.map((e, i) => {
    const t = new Date(e.time);
    const d = e.data.instant.details;
    const symbol = e.data.next_1_hours.summary.symbol_code;
    const precip = e.data.next_1_hours.details?.precipitation_amount ?? 0;
    return `<div class="hour">
      <span class="time">${i === 0 ? "Now" : pad(t.getHours())}</span>
      <img src="${iconUrl(symbol)}" alt="${esc(symbol.replace(/_/g, " "))}" loading="lazy">
      <span class="t ${tempClass(d.air_temperature)}">${fmtTemp(d.air_temperature)}</span>
      <span class="p">${fmtPrecip(precip)}</span>
      <span class="w">${windArrow(d.wind_from_direction)}${Math.round(d.wind_speed)}</span>
    </div>`;
  }).join("");
  $("hourly-card").hidden = entries.length === 0;
}

const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

function dayName(date) {
  const key = dayKey(date);
  if (key === dayKey(new Date())) return "Today";
  if (key === dayKey(new Date(Date.now() + 24 * HOUR))) return "Tomorrow";
  return weekdayFmt.format(date);
}

let shownDays = [];

const CHEVRON = `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;

function renderDaily(days) {
  shownDays = days;
  $("daily").innerHTML = days.map((d, i) => `<li>
    <button class="day" type="button" data-day="${i}">
      <span class="name">${esc(dayName(d.date))}<small>${esc(shortDateFmt.format(d.date))}</small></span>
      <img src="${iconUrl(d.symbol)}" alt="${esc(d.symbol.replace(/_/g, " "))}" loading="lazy">
      <span class="temps"><span class="${tempClass(d.max)}">${fmtTemp(d.max)}</span><span class="min">${fmtTemp(d.min)}</span></span>
      <span class="p">${fmtPrecip(d.precip)}</span>
      ${CHEVRON}
    </button>
  </li>`).join("");
  $("daily-card").hidden = days.length === 0;
}

// One day in detail: hourly rows while MET has hourly data, then 6-hour periods ("14–20").
function openDay(day) {
  $("day-title").textContent = dayName(day.date);
  $("day-sub").innerHTML = `${esc(shortDateFmt.format(day.date))} · <span class="${tempClass(day.max)}">${fmtTemp(day.max)}</span> / ${fmtTemp(day.min)}${day.precip >= 0.05 ? ` · <span class="rain">${fmtPrecip(day.precip)}</span>` : ""}`;

  $("day-hours").innerHTML = day.entries.map((e) => {
    const period = e.data.next_1_hours || e.data.next_6_hours;
    if (!period) return "";
    const t = new Date(e.time);
    const label = e.data.next_1_hours ? pad(t.getHours()) : `${pad(t.getHours())}–${pad(new Date(t.getTime() + 6 * HOUR).getHours())}`;
    const d = e.data.instant.details;
    const symbol = period.summary.symbol_code;
    return `<li class="hour-row">
      <span class="time">${label}</span>
      <img src="${iconUrl(symbol)}" alt="${esc(symbol.replace(/_/g, " "))}">
      <span class="t ${tempClass(d.air_temperature)}">${fmtTemp(d.air_temperature)}</span>
      <span class="p">${fmtPrecip(period.details?.precipitation_amount ?? 0)}</span>
      <span class="w">${windArrow(d.wind_from_direction)}${Math.round(d.wind_speed)} m/s</span>
    </li>`;
  }).join("");

  openSheet($("day-sheet"));
}

// ---------- 21-day forecast ----------

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

// Rough box around Norway, Sweden, Finland and Denmark. MET's "not covered" reply has no CORS
// header, so the browser can't tell it from a network error; skip places clearly outside instead.
const inLongRangeArea = (p) => p.lat >= 54.4 && p.lat <= 71.5 && p.lon >= 4 && p.lon <= 31.7;

const tempColor = (t) => (t <= 0 ? "var(--cold)" : t < 15 ? "#f2a33a" : "var(--warm)");

function openLongRange() {
  if (!place) return;
  $("long-sub").textContent = place.name || "";
  $("long-days").innerHTML = `<li class="long-msg">Loading…</li>`;
  openSheet($("long-sheet"));
  getLongRange(place.lat, place.lon).then(renderLongRange).catch(() => {
    $("long-days").innerHTML = `<li class="long-msg">Couldn't load the 21-day forecast. It's only available for places in Norway, Sweden, Finland and Denmark, and needs an internet connection.</li>`;
  });
}

function renderLongRange(res) {
  const days = res.data.properties.timeseries
    .filter((e) => e.data.next_24_hours)
    .slice(0, 21)
    .map((e) => {
      const [y, m, d] = e.time.slice(0, 10).split("-").map(Number); // MET's days, not shifted by time zone
      return { date: new Date(y, m - 1, d), ...e.data.next_24_hours.details };
    });

  const low = (d) => d.air_temperature_min_percentile_10 ?? d.air_temperature_min;
  const high = (d) => d.air_temperature_max_percentile_90 ?? d.air_temperature_max;
  const lo = Math.min(...days.map(low));
  const hi = Math.max(...days.map(high));
  const pos = (t) => ((t - lo) / (hi - lo || 1)) * 100;
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });

  let week = null;
  $("long-days").innerHTML = days.map((d) => {
    const min = d.air_temperature_min, max = d.air_temperature_max;
    const wk = isoWeek(d.date);
    const header = wk !== week ? `<li class="week">Week ${wk}</li>` : "";
    week = wk;
    return `${header}<li class="long-row">
      <span class="date">${esc(weekday.format(d.date))}<small>${esc(shortDateFmt.format(d.date))}</small></span>
      <span class="lo">${fmtTemp(min)}</span>
      <span class="range">
        <span class="band" style="left:${pos(low(d))}%;width:${pos(high(d)) - pos(low(d))}%"></span>
        <span class="bar" style="left:${pos(min)}%;width:${Math.max(pos(max) - pos(min), 3)}%;background:linear-gradient(90deg, ${tempColor(min)}, ${tempColor(max)})"></span>
      </span>
      <span class="hi ${tempClass(max)}">${fmtTemp(max)}</span>
      <span class="p">${fmtPrecip(d.precipitation_amount) || "–"}<small>${Math.round(d.probability_of_precipitation ?? 0)}%</small></span>
    </li>`;
  }).join("");

  const updated = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(res.data.properties.meta.updated_at));
  $("long-sub").textContent = `${place.name ? `${place.name} · ` : ""}${res.offline ? "Offline, from" : "Updated"} ${updated}`;
}

// ---------- Bottom sheets (day detail, 21-day forecast) ----------

function openSheet(sheet) {
  sheet.showModal();
  sheet.querySelector(".day-sheet-body").scrollTop = 0;
}

// Slides the sheet down, then closes it. Also used after a swipe, continuing from where the finger let go.
function closeSheet(sheet) {
  if (!sheet.open || sheet.classList.contains("closing")) return;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    sheet.classList.remove("closing");
    sheet.style.transform = "";
    sheet.style.transition = "";
    sheet.close();
  };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return finish();
  sheet.classList.add("closing");
  sheet.addEventListener("animationend", finish, { once: true });
  setTimeout(finish, 400); // in case the animation event never arrives
}

// Swipe the sheet down by its top (grabber and title) to close it.
function setupSheet(sheet) {
  const handle = sheet.querySelector(".day-sheet-top");
  let start = null;

  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    start = { y: e.clientY, time: performance.now() };
    try { handle.setPointerCapture(e.pointerId); } catch { /* keep dragging without capture */ }
    sheet.style.transition = "none";
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start) return;
    sheet.style.transform = `translateY(${Math.max(0, e.clientY - start.y)}px)`;
  });
  const release = (e) => {
    if (!start) return;
    const dy = Math.max(0, e.clientY - start.y);
    const flick = dy / (performance.now() - start.time) > 0.6;
    start = null;
    if (dy > 120 || (flick && dy > 30)) {
      closeSheet(sheet);
    } else {
      sheet.style.transition = "transform .2s ease";
      sheet.style.transform = "";
    }
  };
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);

  // Tapping the dimmed page around the sheet closes it; so does Escape.
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(sheet); });
  sheet.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeSheet(sheet);
  });
}

function render(forecast) {
  const series = forecast.data.properties.timeseries;
  const now = Date.now();
  const current = currentEntry(series, now);
  renderNow(current);
  Sky.set({
    symbol: nowSymbol(current),
    wind: current.data.instant.details.wind_speed,
    period: dayPeriod(series, series.indexOf(current)),
  });
  renderHourly(hourlyEntries(series, now));
  renderDaily(dailySummaries(series, now));
  $("long-btn").hidden = !inLongRangeArea(place);

  const updated = new Date(forecast.data.properties.meta.updated_at);
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(updated);
  setStatus(forecast.offline ? `Offline: showing the forecast from ${time}` : `Forecast updated ${time}`);
}

// ---------- App flow ----------

let place = store.get("place"); // { lat, lon, name, source: "gps" | "search" }
let loading = false;

function showPlaceName() {
  $("place-name").textContent = place?.name || (place ? "Current location" : "Weather");
}

function showWelcome(show) {
  $("welcome").hidden = !show;
  if (show) {
    $("now").hidden = true;
    $("hourly-card").hidden = true;
    $("daily-card").hidden = true;
    $("long-btn").hidden = true;
  }
}

async function loadForecast() {
  if (!place || loading) return;
  loading = true;
  $("refresh-btn").classList.add("spinning");
  try {
    render(await getForecast(place.lat, place.lon));
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    loading = false;
    $("refresh-btn").classList.remove("spinning");
  }
}

function setPlace(next) {
  place = next;
  store.set("place", place);
  showPlaceName();
  showWelcome(false);
  return loadForecast();
}

async function useMyLocation() {
  closeSearch();
  setStatus("Finding your location…");
  try {
    const pos = await getPosition();
    const keepName = place?.source === "gps" && place.lat === pos.lat && place.lon === pos.lon ? place.name : null;
    await setPlace({ ...pos, name: keepName, source: "gps" });
    if (!keepName) {
      const name = await reverseGeocode(pos.lat, pos.lon).catch(() => null);
      if (name && place?.source === "gps") {
        place.name = name;
        store.set("place", place);
        showPlaceName();
      }
    }
  } catch (err) {
    setStatus(err.message, true);
    if (!place) showWelcome(true);
  }
}

// ---------- Search sheet ----------

function openSearch() {
  $("search-msg").textContent = "";
  $("search-results").innerHTML = "";
  $("search-input").value = "";
  $("search-sheet").showModal();
  $("search-input").focus();
}

function closeSearch() {
  if ($("search-sheet").open) $("search-sheet").close();
}

let lastResults = [];

async function runSearch(query) {
  if (!query.trim()) return;
  $("search-msg").textContent = "Searching…";
  $("search-results").innerHTML = "";
  try {
    lastResults = await searchPlaces(query.trim());
    $("search-msg").textContent = lastResults.length ? "" : "No places found.";
    $("search-results").innerHTML = lastResults.map((p, i) => `
      <li><button type="button" data-index="${i}">
        <strong>${esc(p.name)}</strong><small>${esc(p.region)}</small>
      </button></li>`).join("");
  } catch {
    $("search-msg").textContent = "Search isn't working right now. Check your connection.";
  }
}

// ---------- Wiring ----------

document.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "locate") useMyLocation();
  else if (action === "search") openSearch();
  else if (action === "close") closeSearch();
  else if (action === "close-sheet") closeSheet(e.target.closest("dialog"));
  else if (action === "long") openLongRange();

  const dayBtn = e.target.closest("#daily .day");
  if (dayBtn) openDay(shownDays[+dayBtn.dataset.day]);

  const result = e.target.closest("#search-results button");
  if (result) {
    const p = lastResults[+result.dataset.index];
    closeSearch();
    setPlace({ lat: p.lat, lon: p.lon, name: p.name, source: "search" });
  }
});

$("place-btn").addEventListener("click", openSearch);
$("refresh-btn").addEventListener("click", () => (place?.source === "gps" ? useMyLocation() : loadForecast()));
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch($("search-input").value);
});

// Re-check when the app comes back to the foreground; the cache decides whether to fetch.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && place) loadForecast();
});

setupSheet($("day-sheet"));
setupSheet($("long-sheet"));
showPlaceName();
if (!place) {
  showWelcome(true);
} else if (place.source === "gps") {
  loadForecast().then(useMyLocation);
} else {
  loadForecast();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* app still works without it */ });
}
