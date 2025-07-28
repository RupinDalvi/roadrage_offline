// --- Globals & State ---
let db, currentRideId = null;
let currentRideDataPoints = [], accelerometerBuffer = [];
let latestGpsPosition = null, watchId = null, motionListenerActive = false;
let dataCollectionInterval = null, lastLowPassZ = 0;

// Live map
let map, currentLocationMarker, currentRidePath, historicalRoughnessLayer;
let mapInitialized = false;

// Live chart
let vibrationChart, chartDataset = [];

// Recap map & chart
let recapMap, recapRidePath, recapHistoricalLayer, recapChart, recapHighlight;

// DOM refs
let statusDiv, startButton, stopButton, dataPointsCounter;
let pastRidesList, rideDetailView, detailContent, closeDetailButton;

// Constants
const DB_NAME = 'BikeRoughnessDB', DB_VERSION = 2;
const DATA_INTERVAL_MS = 3000, HIST_RADIUS = 150, PROXIMITY_RADIUS = 10;
const HPF_ALPHA = 0.8;
const ROUGH_THRESHOLDS = [0,3,6,9,15,21,30];
const ROUGH_COLORS     = ['#ffffff','#dddddd','#bbbbbb','#999999','#777777','#555555','#333333','#000000'];

// --- IndexedDB Helper ---
function promisifiedDbRequest(req) {
  return new Promise((res, rej) => {
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

// --- DB Initialization ---
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = e => {
      db = e.target.result;
      if (!db.objectStoreNames.contains('rides'))
        db.createObjectStore('rides', { keyPath: 'rideId' });
      if (!db.objectStoreNames.contains('rideDataPoints')) {
        const s = db.createObjectStore('rideDataPoints', { keyPath: 'id' });
        s.createIndex('by_rideId','rideId',{unique:false});
      }
      if (!db.objectStoreNames.contains('RoughnessMap'))
        db.createObjectStore('RoughnessMap',{keyPath:'geoId'});
    };
    request.onsuccess = e => {
      db = e.target.result;
      resolve(db);
      loadPastRides();
    };
    request.onerror = e => {
      console.error('DB error', e);
      statusDiv.textContent = 'Error opening database.';
      reject(e);
    };
  });
}

// --- Map Initialization ---
function initializeMap() {
  if (mapInitialized) return;
  map = L.map('map').setView([51.0447, -114.0719], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  setTimeout(() => map.invalidateSize(), 200);
  historicalRoughnessLayer = L.layerGroup().addTo(map);
  currentRidePath = L.polyline([], { weight: 5 }).addTo(map);
  mapInitialized = true;
}

// --- Live Chart Initialization ---
function initChart() {
  const canvas = document.getElementById('vibrationChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  vibrationChart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [{ label: 'Vibration', data: chartDataset, pointRadius: 4, borderWidth: 2, tension: 0.3 }] },
    options: {
      parsing: { xAxisKey: 'x', yAxisKey: 'y' },
      scales: {
        x: { type: 'time', time: { tooltipFormat: 'HH:mm:ss' } },
        y: { beginAtZero: true }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => `Roughness: ${ctx.parsed.y.toFixed(2)}`,
            afterBody: ctx => {
              const dp = chartDataset[ctx[0].dataIndex].meta;
              return `Lat: ${dp.latitude.toFixed(5)}, Lon: ${dp.longitude.toFixed(5)}`;
            }
          }
        }
      },
      onHover: (_, items) => {
        if (items.length) highlightPointOnMap(items[0].dataIndex);
      }
    }
  });
}

// --- Recap Map & Chart Initialization ---
function initRecapMap() {
  if (recapMap) recapMap.remove();
  recapMap = L.map('recapMap').setView([51.0447, -114.0719], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(recapMap);
  setTimeout(() => recapMap.invalidateSize(), 200);
  recapHistoricalLayer = L.layerGroup().addTo(recapMap);
  recapRidePath = L.polyline([], { weight: 5 }).addTo(recapMap);
}

function initRecapChart() {
  const canvas = document.getElementById('recapChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (recapChart) recapChart.destroy();
  recapChart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [{ label: 'Vibration', data: [], pointRadius: 4, borderWidth: 2, tension: 0.3 }] },
    options: {
      parsing: { xAxisKey: 'x', yAxisKey: 'y' },
      scales: {
        x: { type: 'time', time: { tooltipFormat: 'HH:mm:ss' } },
        y: { beginAtZero: true }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => `Roughness: ${ctx.parsed.y.toFixed(2)}`,
            afterBody: ctx => {
              const dp = recapChart.data.datasets[0].data[ctx[0].dataIndex].meta;
              return `Lat: ${dp.latitude.toFixed(5)}, Lon: ${dp.longitude.toFixed(5)}`;
            }
          }
        }
      },
      onHover: (_, items) => {
        if (items.length) highlightRecapPointOnMap(items[0].dataIndex);
      }
    }
  });
}

// --- Utility Functions ---
function calculateVariance(arr) {
  if (!arr.length) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}
function getGeoId(lat, lon, prec = 4) {
  return `${lat.toFixed(prec)}_${lon.toFixed(prec)}`;
}
function toRad(d) { return d * Math.PI / 180; }
function dist(lat1, lon1, lat2, lon2) {
  const R = 6371e3,
        φ1 = toRad(lat1), φ2 = toRad(lat2),
        dφ = toRad(lat2 - lat1), dλ = toRad(lon2 - lon1),
        a = Math.sin(dφ/2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function roughnessToColor(r) {
  for (let i = 0; i < ROUGH_THRESHOLDS.length; i++) {
    if (r <= ROUGH_THRESHOLDS[i]) return ROUGH_COLORS[i];
  }
  return ROUGH_COLORS[ROUGH_COLORS.length - 1];
}

// --- Sensor Handlers ---
function gpsSuccess(pos) { latestGpsPosition = pos; }
function gpsError(err) {
  const msgs = {1:'Permission denied',2:'Unavailable',3:'Timed out'};
  statusDiv.textContent = msgs[err.code] || 'GPS error';
  if (err.code === 1) stopRide();
}
function handleMotion(evt) {
  const z = evt.accelerationIncludingGravity?.z;
  if (typeof z === 'number') {
    lastLowPassZ = HPF_ALPHA * lastLowPassZ + (1 - HPF_ALPHA) * z;
    accelerometerBuffer.push(z - lastLowPassZ);
  }
}

// --- Core Data Loop ---
async function processCombinedDataPoint() {
  if (!currentRideId || !latestGpsPosition) {
    statusDiv.textContent = 'Waiting for GPS…';
    return;
  }
  const { latitude, longitude, altitude, accuracy } = latestGpsPosition.coords;
  const timestamp = latestGpsPosition.timestamp;
  const roughness = calculateVariance(accelerometerBuffer);
  accelerometerBuffer = [];

  const dp = {
    id: crypto.randomUUID(),
    rideId: currentRideId,
    timestamp, latitude, longitude, altitude, accuracy,
    roughnessValue: roughness
  };

  currentRideDataPoints.push(dp);
  dataPointsCounter.textContent = `Data Points: ${currentRideDataPoints.length}`;
  await updateRoughnessMap(dp);
  updateMapDisplay(dp);

  if (vibrationChart) {
    const pt = { x: new Date(timestamp), y: roughness, meta: dp };
    chartDataset.push(pt);
    vibrationChart.update();
  }

  statusDiv.textContent = `Lat ${latitude.toFixed(4)}, Lon ${longitude.toFixed(4)}, Rough ${roughness.toFixed(2)}`;
}

// --- RoughnessMap Management ---
async function updateRoughnessMap(dp) {
  const tx = db.transaction('RoughnessMap', 'readwrite');
  const store = tx.objectStore('RoughnessMap');
  const all = await promisifiedDbRequest(store.getAll());

  const match = all.find(pt =>
    dist(pt.latitude, pt.longitude, dp.latitude, dp.longitude) <= PROXIMITY_RADIUS
  );

  if (match) {
    const updated = {
      ...match,
      latitude: dp.latitude,
      longitude: dp.longitude,
      roughnessValue: dp.roughnessValue,
      lastUpdated: dp.timestamp
    };
    await promisifiedDbRequest(store.put(updated));
  } else {
    await promisifiedDbRequest(store.put({
      geoId: getGeoId(dp.latitude, dp.longitude),
      latitude: dp.latitude,
      longitude: dp.longitude,
      roughnessValue: dp.roughnessValue,
      lastUpdated: dp.timestamp
    }));
  }
  await tx.complete;
}

// --- Live Map Rendering ---
function updateMapDisplay(dp) {
  const latlng = [dp.latitude, dp.longitude];
  if (!currentLocationMarker) currentLocationMarker = L.marker(latlng).addTo(map);
  else                          currentLocationMarker.setLatLng(latlng);
  map.setView(latlng, Math.max(map.getZoom(), 15));

  const path = currentRidePath.getLatLngs();
  const col  = roughnessToColor(dp.roughnessValue);
  if (path.length) {
    const prev = path[path.length - 1];
    L.polyline([prev, latlng], { color: col, weight: 5 }).addTo(map);
  }
  currentRidePath.addLatLng(latlng);

  updateHistoricalDisplay(dp.latitude, dp.longitude, historicalRoughnessLayer, map);
}

// --- Historical Overlay Helper ---
async function updateHistoricalDisplay(lat, lon, layerGroup, targetMap) {
  layerGroup.clearLayers();
  const tx = db.transaction('RoughnessMap', 'readonly');
  const all = await promisifiedDbRequest(tx.objectStore('RoughnessMap').getAll());
  all.forEach(pt => {
    if (dist(lat, lon, pt.latitude, pt.longitude) <= HIST_RADIUS) {
      L.circleMarker([pt.latitude, pt.longitude], {
        radius: 4,
        fillColor: roughnessToColor(pt.roughnessValue),
        color: '#000', weight: 1, opacity: 0.7, fillOpacity: 0.7
      })
      .bindPopup(
        `Roughness: ${pt.roughnessValue.toFixed(2)}<br>` +
        `Updated: ${new Date(pt.lastUpdated).toLocaleDateString()}`
      )
      .addTo(layerGroup);
    }
  });
  await tx.complete;
}

// --- Highlight on Hover ---
function highlightPointOnMap(idx) {
  if (!chartDataset[idx]) return;
  const dp = chartDataset[idx].meta;
  if (recapHighlight) map.removeLayer(recapHighlight);
  recapHighlight = L.circleMarker([dp.latitude, dp.longitude], {
    radius: 10, color: '#f00', weight: 2, fill: false
  }).addTo(map);
  setTimeout(() => map.removeLayer(recapHighlight), 3000);
}
function highlightRecapPointOnMap(idx) {
  const data = recapChart?.data?.datasets[0]?.data;
  if (!data || !data[idx]) return;
  const dp = data[idx].meta;
  if (recapHighlight) recapMap.removeLayer(recapHighlight);
  recapHighlight = L.circleMarker([dp.latitude, dp.longitude], {
    radius: 10, color: '#f00', weight: 2, fill: false
  }).addTo(recapMap);
  setTimeout(() => recapMap.removeLayer(recapHighlight), 3000);
}

// --- Start & Stop Ride ---
async function startRide() {
  if (currentRideId) return;
  currentRideId = Date.now();
  currentRideDataPoints = [];
  accelerometerBuffer = [];
  latestGpsPosition = null;
  dataPointsCounter.textContent = 'Data Points: 0';
  statusDiv.textContent = 'Requesting permissions…';

  if (currentRidePath) map.removeLayer(currentRidePath);
  currentRidePath = L.polyline([], { weight: 5 }).addTo(map);
  if (currentLocationMarker) map.removeLayer(currentLocationMarker);
  historicalRoughnessLayer.clearLayers();

  watchId = navigator.geolocation.watchPosition(gpsSuccess, gpsError, {
    enableHighAccuracy: true, timeout: 10000, maximumAge: 0
  });

  if (typeof DeviceMotionEvent?.requestPermission === 'function') {
    try {
      const resp = await DeviceMotionEvent.requestPermission();
      if (resp === 'granted') {
        window.addEventListener('devicemotion', handleMotion);
        motionListenerActive = true;
      } else {
        statusDiv.textContent = 'Motion permission denied.';
      }
    } catch (e) {
      console.error(e);
      statusDiv.textContent = 'Error requesting motion permission.';
    }
  } else {
    window.addEventListener('devicemotion', handleMotion);
    motionListenerActive = true;
  }

  dataCollectionInterval = setInterval(processCombinedDataPoint, DATA_INTERVAL_MS);

  const tx = db.transaction('rides', 'readwrite');
  await promisifiedDbRequest(tx.objectStore('rides').add({
    rideId: currentRideId,
    startTime: currentRideId,
    endTime: null,
    duration: 0,
    totalDataPoints: 0,
    status: 'active'
  }));
  await tx.complete;

  // reset live chart
  if (vibrationChart) {
    chartDataset.length = 0;
    vibrationChart.data.datasets[0].data = chartDataset;
    vibrationChart.update();
  }

  startButton.disabled = true;
  stopButton.disabled = false;
  statusDiv.textContent = 'Recording… waiting for GPS.';
}

async function stopRide() {
  if (!currentRideId) return;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (motionListenerActive) { window.removeEventListener('devicemotion', handleMotion); motionListenerActive = false; }
  if (dataCollectionInterval !== null) { clearInterval(dataCollectionInterval); dataCollectionInterval = null; }

  statusDiv.textContent = 'Saving ride…';

  try {
    const tx = db.transaction(['rides','rideDataPoints'], 'readwrite');
    const ridesStore = tx.objectStore('rides');
    const dpStore    = tx.objectStore('rideDataPoints');

    for (const dp of currentRideDataPoints) {
      await promisifiedDbRequest(dpStore.put(dp));
    }

    const rr = await promisifiedDbRequest(ridesStore.get(currentRideId));
    const upd = {
      ...rr,
      endTime: Date.now(),
      duration: Math.floor((Date.now() - rr.startTime)/1000),
      totalDataPoints: currentRideDataPoints.length,
      status: 'completed'
    };
    await promisifiedDbRequest(ridesStore.put(upd));
    await tx.complete;

    statusDiv.textContent = 'Ride saved!';
  } catch (e) {
    console.error(e);
    statusDiv.textContent = 'Error saving ride.';
  }

  currentRideId = null;
  currentRideDataPoints = [];
  accelerometerBuffer = [];
  latestGpsPosition = null;
  startButton.disabled = false;
  stopButton.disabled = true;
  dataPointsCounter.textContent = 'Data Points: 0';
  if (currentRidePath) currentRidePath.setLatLngs([]);
  if (currentLocationMarker) map.removeLayer(currentLocationMarker);
  historicalRoughnessLayer.clearLayers();

  loadPastRides();
}

// --- Past Rides & Recap ---
async function loadPastRides() {
  pastRidesList.innerHTML = '';
  if (!db) return;
  try {
    const all = await promisifiedDbRequest(db.transaction('rides','readonly').objectStore('rides').getAll());
    if (!all.length) {
      pastRidesList.innerHTML = '<li>No past rides recorded.</li>';
      return;
    }
    all.sort((a,b)=>b.startTime - a.startTime).forEach(r => {
      const li = document.createElement('li');
      const start = new Date(r.startTime).toLocaleString();
      const m = Math.floor(r.duration/60), s = r.duration%60;
      li.innerHTML = `
        <strong>Start:</strong> ${start}<br>
        <strong>Duration:</strong> ${m}m ${s}s<br>
        <strong>Points:</strong> ${r.totalDataPoints}
      `;
      li.onclick = () => showRideDetails(r.rideId);
      pastRidesList.appendChild(li);
    });
  } catch (e) {
    console.error(e);
    statusDiv.textContent = 'Error loading past rides.';
  }
}

async function showRideDetails(rideId) {
  rideDetailView.classList.remove('hidden');
  detailContent.textContent = 'Loading…';

  initRecapMap();
  initRecapChart();

  const tx = db.transaction(['rides','rideDataPoints'],'readonly');
  const rideRec = await promisifiedDbRequest(tx.objectStore('rides').get(rideId));
  const dps     = await promisifiedDbRequest(
    tx.objectStore('rideDataPoints').index('by_rideId').getAll(rideId)
  );
  await tx.complete;

  if (!rideRec || !dps.length) {
    detailContent.textContent = 'No data for this ride.';
    return;
  }

  // Recap chart
  const data = dps.map(dp => ({ x: new Date(dp.timestamp), y: dp.roughnessValue, meta: dp }));
  if (recapChart) {
    recapChart.data.datasets[0].data = data;
    recapChart.update();
  }

  // Recap map
  recapRidePath.setLatLngs([]);
  recapHistoricalLayer.clearLayers();
  dps.forEach(dp => {
    const latlng = [dp.latitude, dp.longitude];
    const pts = recapRidePath.getLatLngs();
    const col = roughnessToColor(dp.roughnessValue);
    if (pts.length) {
      const prev = pts[pts.length - 1];
      L.polyline([prev, latlng], { color: col, weight: 5 }).addTo(recapMap);
    }
    recapRidePath.addLatLng(latlng);
  });
  const last = dps[dps.length - 1];
  updateHistoricalDisplay(last.latitude, last.longitude, recapHistoricalLayer, recapMap);

  // Text details
  let txt = `Ride ID: ${rideRec.rideId}\n` +
            `Start: ${new Date(rideRec.startTime).toLocaleString()}\n` +
            `End: ${new Date(rideRec.endTime).toLocaleString()}\n` +
            `Duration: ${Math.floor(rideRec.duration/60)}m ${rideRec.duration%60}s\n` +
            `Points: ${rideRec.totalDataPoints}\n\n— Data Points —\n`;
  dps.forEach(dp => {
    txt += `${new Date(dp.timestamp).toLocaleTimeString()} | ` +
           `Lat ${dp.latitude.toFixed(5)}, Lon ${dp.longitude.toFixed(5)} | ` +
           `Rough ${dp.roughnessValue.toFixed(3)}\n`;
  });
  detailContent.textContent = txt;
}

function hideRideDetails() {
  rideDetailView.classList.add('hidden');
  detailContent.textContent = '';
}

// --- Bootstrap on load ---
document.addEventListener('DOMContentLoaded', () => {
  statusDiv         = document.getElementById('status');
  startButton       = document.getElementById('startButton');
  stopButton        = document.getElementById('stopButton');
  dataPointsCounter = document.getElementById('dataPointsCounter');
  pastRidesList     = document.getElementById('pastRidesList');
  rideDetailView    = document.getElementById('rideDetailView');
  detailContent     = document.getElementById('detailContent');
  closeDetailButton = document.getElementById('closeDetailButton');

  startButton.addEventListener('click', startRide);
  stopButton.addEventListener('click', stopRide);
  closeDetailButton.addEventListener('click', hideRideDetails);

  initializeMap();
  openDb();
  initChart();
});
