// Global variables for IndexedDB and ride state
let db;
let currentRideId = null;
let currentRideDataPoints = [];
let accelerometerBuffer = [];     // now stores high‑pass filtered values
let latestGpsPosition = null;
let watchId = null;
let motionListenerActive = false;
let dataCollectionInterval = null;

// Low‑pass state for HPF
const HPF_ALPHA = 0.8;
let lastLowPassZ = 0;

// Map variables
let map = null;
let currentLocationMarker = null;
let currentRidePath = null;
let historicalRoughnessLayer = null;
let mapInitialized = false;

// DOM Elements
let statusDiv, startButton, stopButton, dataPointsCounter;
let pastRidesList, rideDetailView, detailContent, closeDetailButton;

// Constants
const DB_NAME = 'BikeRoughnessDB';
const DB_VERSION = 2;
const DATA_COLLECTION_INTERVAL_MS = 3000;
const HISTORICAL_DISPLAY_RADIUS_M = 150;
const PROXIMITY_MATCH_RADIUS_M = 10;    // 10 m for “same” point

// color bins and thresholds
const ROUGH_THRESHOLDS = [0, 3, 6, 9, 15, 21, 30];
const ROUGH_COLORS     = [
  '#ffffff', // ≤0
  '#dddddd', // 0–3
  '#bbbbbb', // 3–6
  '#999999', // 6–9
  '#777777', // 9–15
  '#555555', // 15–21
  '#333333', // 21–30
  '#000000'  // >30
];

// --- IndexedDB Helper ---
function promisifiedDbRequest(request) {
  return new Promise((res, rej) => {
    request.onsuccess = e => res(e.target.result);
    request.onerror   = e => rej(e.target.error);
  });
}

// --- Open / Upgrade DB ---
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      db = e.target.result;
      if (!db.objectStoreNames.contains('rides'))
        db.createObjectStore('rides', { keyPath: 'rideId' });
      if (!db.objectStoreNames.contains('rideDataPoints')) {
        const s = db.createObjectStore('rideDataPoints', { keyPath: 'id' });
        s.createIndex('by_rideId', 'rideId', { unique: false });
      }
      if (!db.objectStoreNames.contains('RoughnessMap'))
        db.createObjectStore('RoughnessMap', { keyPath: 'geoId' });
    };
    req.onsuccess = e => {
      db = e.target.result;
      resolve(db);
      loadPastRides();
    };
    req.onerror = e => {
      console.error('DB open error', e);
      statusDiv.textContent = 'Error opening database.';
      reject(e);
    };
  });
}

// --- Map Init ---
function initializeMap() {
  if (mapInitialized) return;
  map = L.map('map').setView([51.0447, -114.0719], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // allow layout to settle
  setTimeout(() => map.invalidateSize(), 200);

  historicalRoughnessLayer = L.layerGroup().addTo(map);
  currentRidePath = L.polyline([], { weight: 5 }).addTo(map);
  mapInitialized = true;
}

// --- Utils ---
function calculateVariance(arr) {
  if (!arr.length) return 0;
  const μ = arr.reduce((sum, v) => sum + v, 0) / arr.length;
  return arr.reduce((sum, v) => sum + (v - μ) ** 2, 0) / arr.length;
}
function getGeoId(lat, lon, prec = 4) {
  return `${lat.toFixed(prec)}_${lon.toFixed(prec)}`;
}
function toRadians(deg) { return deg * Math.PI/180; }
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = toRadians(lat1), φ2 = toRadians(lat2);
  const Δφ = toRadians(lat2 - lat1), Δλ = toRadians(lon2 - lon1);
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// choose color bin
function roughnessToColor(r) {
  for (let i = 0; i < ROUGH_THRESHOLDS.length; i++) {
    if (r <= ROUGH_THRESHOLDS[i]) return ROUGH_COLORS[i];
  }
  return ROUGH_COLORS[ROUGH_COLORS.length - 1];
}

// --- Sensor Handlers ---
function gpsSuccess(pos) {
  latestGpsPosition = pos;
}
function gpsError(err) {
  const msgs = {
    1: 'GPS permission denied.',
    2: 'GPS unavailable.',
    3: 'GPS timed out.'
  };
  statusDiv.textContent = msgs[err.code] || 'Unknown GPS error.';
  if (err.code === 1) stopRide();
}
function handleMotion(evt) {
  const z = evt.accelerationIncludingGravity?.z;
  if (typeof z === 'number') {
    // high‑pass filter
    lastLowPassZ = HPF_ALPHA * lastLowPassZ + (1 - HPF_ALPHA) * z;
    const high = z - lastLowPassZ;
    accelerometerBuffer.push(high);
  }
}

// --- Combine data every 3s ---
async function processCombinedDataPoint() {
  if (!currentRideId || !latestGpsPosition) {
    statusDiv.textContent = 'Waiting for GPS fix…';
    return;
  }

  const { latitude, longitude, altitude, accuracy } = latestGpsPosition.coords;
  const timestamp = latestGpsPosition.timestamp;
  const roughness = calculateVariance(accelerometerBuffer);
  accelerometerBuffer = [];

  const dp = {
    id: crypto.randomUUID(),
    rideId: currentRideId,
    timestamp, latitude, longitude,
    altitude, accuracy, roughnessValue: roughness
  };

  currentRideDataPoints.push(dp);
  dataPointsCounter.textContent = `Data Points: ${currentRideDataPoints.length}`;

  await updateRoughnessMap(dp);
  updateMapDisplay(dp);
  statusDiv.textContent = `Lat ${latitude.toFixed(4)}, Lon ${longitude.toFixed(4)}, Rough ${roughness.toFixed(2)}`;
}

// --- RoughnessMap store ops with proximity matching ---
async function updateRoughnessMap(dp) {
  const tx = db.transaction('RoughnessMap', 'readwrite');
  const store = tx.objectStore('RoughnessMap');
  const all = await promisifiedDbRequest(store.getAll());

  // find any existing point within 10m
  let match = all.find(pt =>
    calculateDistance(pt.latitude, pt.longitude, dp.latitude, dp.longitude)
    <= PROXIMITY_MATCH_RADIUS_M
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
    const geoId = getGeoId(dp.latitude, dp.longitude);
    await promisifiedDbRequest(store.put({
      geoId,
      latitude: dp.latitude,
      longitude: dp.longitude,
      roughnessValue: dp.roughnessValue,
      lastUpdated: dp.timestamp
    }));
  }
  await tx.complete;
}

// --- Map rendering of current + historical ---
function updateMapDisplay(dp) {
  const latlng = [dp.latitude, dp.longitude];

  // current marker
  if (!currentLocationMarker) {
    currentLocationMarker = L.marker(latlng).addTo(map);
  } else {
    currentLocationMarker.setLatLng(latlng);
  }
  map.setView(latlng, Math.max(map.getZoom(), 15));

  // draw only newest segment
  const path = currentRidePath.getLatLngs();
  const color = roughnessToColor(dp.roughnessValue);
  if (path.length) {
    const prev = path[path.length - 1];
    L.polyline([prev, latlng], { color, weight: 5 }).addTo(map);
  } else {
    L.polyline([latlng, latlng], { color, weight: 5 }).addTo(map);
  }
  currentRidePath.addLatLng(latlng);

  // overlay nearby historical
  updateHistoricalRoughnessDisplay(dp.latitude, dp.longitude);
}

async function updateHistoricalRoughnessDisplay(lat, lon) {
  historicalRoughnessLayer.clearLayers();
  const tx = db.transaction('RoughnessMap', 'readonly');
  const all = await promisifiedDbRequest(tx.objectStore('RoughnessMap').getAll());

  all.forEach(pt => {
    if (calculateDistance(lat, lon, pt.latitude, pt.longitude) <= HISTORICAL_DISPLAY_RADIUS_M) {
      L.circleMarker([pt.latitude, pt.longitude], {
        radius: 4,
        fillColor: roughnessToColor(pt.roughnessValue),
        color: '#000',
        weight: 1,
        opacity: 0.7,
        fillOpacity: 0.7
      })
      .bindPopup(`Roughness: ${pt.roughnessValue.toFixed(2)}<br>Updated: ${new Date(pt.lastUpdated).toLocaleDateString()}`)
      .addTo(historicalRoughnessLayer);
    }
  });
  await tx.complete;
}

// --- Start / Stop Ride ---
async function startRide() {
  if (currentRideId) return;

  // reset
  currentRideId = Date.now();
  currentRideDataPoints = [];
  accelerometerBuffer = [];
  latestGpsPosition = null;
  dataPointsCounter.textContent = 'Data Points: 0';
  statusDiv.textContent = 'Requesting permissions…';

  // clear old layers
  if (currentRidePath) map.removeLayer(currentRidePath);
  currentRidePath = L.polyline([], { weight: 5 }).addTo(map);
  if (currentLocationMarker) map.removeLayer(currentLocationMarker);
  historicalRoughnessLayer.clearLayers();

  // GPS watch
  watchId = navigator.geolocation.watchPosition(gpsSuccess, gpsError, {
    enableHighAccuracy: true, timeout: 10000, maximumAge: 0
  });

  // accelerometer permission + listener
  if (typeof DeviceMotionEvent?.requestPermission === 'function') {
    try {
      const resp = await DeviceMotionEvent.requestPermission();
      if (resp === 'granted') {
        window.addEventListener('devicemotion', handleMotion);
        motionListenerActive = true;
      } else {
        statusDiv.textContent = 'Motion permission denied.';
      }
    } catch (err) {
      console.error('Motion permission error', err);
      statusDiv.textContent = 'Error requesting motion permission.';
    }
  } else {
    window.addEventListener('devicemotion', handleMotion);
    motionListenerActive = true;
  }

  // start data loop
  dataCollectionInterval =
    setInterval(processCombinedDataPoint, DATA_COLLECTION_INTERVAL_MS);

  // record ride meta
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

  startButton.disabled = true;
  stopButton.disabled = false;
  statusDiv.textContent = 'Recording… waiting for GPS fix.';
}

async function stopRide() {
  if (!currentRideId) return;

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (motionListenerActive) {
    window.removeEventListener('devicemotion', handleMotion);
    motionListenerActive = false;
  }
  if (dataCollectionInterval !== null) {
    clearInterval(dataCollectionInterval);
    dataCollectionInterval = null;
  }

  statusDiv.textContent = 'Saving ride…';

  try {
    const tx = db.transaction(['rides','rideDataPoints'], 'readwrite');
    const ridesStore = tx.objectStore('rides');
    const dpStore    = tx.objectStore('rideDataPoints');

    for (const dp of currentRideDataPoints) {
      await promisifiedDbRequest(dpStore.put(dp));
    }

    const rideRec = await promisifiedDbRequest(ridesStore.get(currentRideId));
    const updated = {
      ...rideRec,
      endTime: Date.now(),
      duration: Math.floor((Date.now() - rideRec.startTime)/1000),
      totalDataPoints: currentRideDataPoints.length,
      status: 'completed'
    };
    await promisifiedDbRequest(ridesStore.put(updated));
    await tx.complete;
    statusDiv.textContent = 'Ride saved!';
  } catch (err) {
    console.error('Save error', err);
    statusDiv.textContent = 'Error saving ride.';
  }

  // reset UI state
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

// --- Past Rides List & Details ---
async function loadPastRides() {
  pastRidesList.innerHTML = '';
  if (!db) return;

  try {
    const tx = db.transaction('rides','readonly');
    const all = await promisifiedDbRequest(tx.objectStore('rides').getAll());
    await tx.complete;

    if (!all.length) {
      pastRidesList.innerHTML = '<li>No past rides recorded.</li>';
      return;
    }

    all.sort((a,b) => b.startTime - a.startTime).forEach(r => {
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
  } catch (err) {
    console.error('Load rides error', err);
    statusDiv.textContent = 'Error loading past rides.';
  }
}

async function showRideDetails(rideId) {
  rideDetailView.classList.remove('hidden');
  detailContent.textContent = 'Loading…';
  try {
    const tx = db.transaction(['rides','rideDataPoints'],'readonly');
    const rideRec = await promisifiedDbRequest(tx.objectStore('rides').get(rideId));
    const dps     = await promisifiedDbRequest(
      tx.objectStore('rideDataPoints').index('by_rideId').getAll(rideId)
    );
    await tx.complete;

    if (!rideRec || !dps.length) {
      detailContent.textContent = 'No data.';
      return;
    }

    let txt = `Ride ID: ${rideRec.rideId}\nStart: ${new Date(rideRec.startTime).toLocaleString()}\n` +
              `End: ${new Date(rideRec.endTime).toLocaleString()}\n` +
              `Duration: ${Math.floor(rideRec.duration/60)}m ${rideRec.duration%60}s\n` +
              `Points: ${rideRec.totalDataPoints}\n\n— Data Points —\n`;

    dps.forEach(dp => {
      txt += `${new Date(dp.timestamp).toLocaleTimeString()} | ` +
             `Lat ${dp.latitude.toFixed(5)}, Lon ${dp.longitude.toFixed(5)} | ` +
             `Rough ${dp.roughnessValue.toFixed(3)}\n`;
    });
    detailContent.textContent = txt;
  } catch (err) {
    console.error('Details error', err);
    detailContent.textContent = 'Error loading details.';
  }
}
function hideRideDetails() {
  rideDetailView.classList.add('hidden');
  detailContent.textContent = '';
}

// --- Initialization on load ---
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
});
