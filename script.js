// Global variables for IndexedDB and ride state
let db;
let currentRideId = null;
let currentRideDataPoints = []; // Stores data points for the *current* ride
let accelerometerBuffer = [];   // Buffer for raw accelerometer Z-axis values
let latestGpsPosition = null;   // Stores the most recent raw GPS position
let watchId = null;             // To store the ID returned by watchPosition
let motionListenerActive = false;
let dataCollectionInterval = null; // To store the interval for combined data processing

// Map variables
let map = null;
let currentLocationMarker = null;
let currentRidePath = null;          // Leaflet polyline for the current ride's path
let historicalRoughnessLayer = null; // Leaflet layer group for historical data markers
let mapInitialized = false;          // Flag to ensure map is only initialized once

// DOM Elements
let statusDiv;
let startButton;
let stopButton;
let dataPointsCounter;
let pastRidesList;
let rideDetailView;
let detailContent;
let closeDetailButton;

const DB_NAME = 'BikeRoughnessDB';
const DB_VERSION = 2;               // Increment on schema change
const DATA_COLLECTION_INTERVAL_MS = 3000; // 3 seconds
const HISTORICAL_DATA_RADIUS_M = 150;     // 150m radius for historical data

// --- IndexedDB Helper Function ---
function promisifiedDbRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = event => resolve(event.target.result);
        request.onerror   = event => reject(event.target.error);
    });
}

// --- IndexedDB Initialization ---
function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            db = event.target.result;
            if (!db.objectStoreNames.contains('rides')) {
                db.createObjectStore('rides', { keyPath: 'rideId' });
            }
            if (!db.objectStoreNames.contains('rideDataPoints')) {
                const store = db.createObjectStore('rideDataPoints', { keyPath: 'id' });
                store.createIndex('by_rideId', 'rideId', { unique: false });
            }
            if (!db.objectStoreNames.contains('RoughnessMap')) {
                db.createObjectStore('RoughnessMap', { keyPath: 'geoId' });
            }
        };

        request.onsuccess = event => {
            db = event.target.result;
            resolve(db);
            loadPastRides();
        };
        request.onerror = event => {
            console.error('IndexedDB error:', event.target.errorCode);
            statusDiv.textContent = 'Error opening database.';
            reject(event.target.errorCode);
        };
    });
}

// --- Map Initialization ---
function initializeMap() {
    if (mapInitialized) return;

    // Default to Calgary
    map = L.map('map').setView([51.0447, -114.0719], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // let Leaflet recalc its size after layout
    setTimeout(() => map.invalidateSize(), 200);

    historicalRoughnessLayer = L.layerGroup().addTo(map);
    currentRidePath = L.polyline([], { color: '#808080', weight: 4 }).addTo(map);

    mapInitialized = true;
}

// --- Utility Functions ---
function calculateVariance(data) {
    if (!data.length) return 0;
    const mean = data.reduce((sum, v) => sum + v, 0) / data.length;
    return data.reduce((sum, v) => sum + (v - mean) ** 2, 0) / data.length;
}
function roughnessToGrayscale(roughness, maxRoughness = 100) {
    const norm = Math.min(1, roughness / maxRoughness);
    const val  = Math.floor(255 * (1 - norm)).toString(16).padStart(2, '0');
    return `#${val}${val}${val}`;
}
function getGeoId(lat, lon, precision = 4) {
    return `${lat.toFixed(precision)}_${lon.toFixed(precision)}`;
}
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2 - lat1)*Math.PI/180, Δλ = (lon2 - lon1)*Math.PI/180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Sensor Handlers ---
function gpsSuccess(position) {
    latestGpsPosition = position;
}
function gpsError(error) {
    const messages = {
        1: 'GPS permission denied.',
        2: 'GPS position unavailable.',
        3: 'GPS request timed out.'
    };
    statusDiv.textContent = messages[error.code] || 'Unknown GPS error.';
    if (error.code === 1) stopRide();
}
function handleMotion(event) {
    const z = event.accelerationIncludingGravity?.z;
    if (typeof z === 'number') accelerometerBuffer.push(z);
}

// --- Core Data Loop ---
async function processCombinedDataPoint() {
    if (!currentRideId || !latestGpsPosition) {
        statusDiv.textContent = 'Recording… waiting for GPS fix.';
        return;
    }

    const { latitude, longitude, altitude, accuracy } = latestGpsPosition.coords;
    const timestamp = latestGpsPosition.timestamp;
    const roughness = accelerometerBuffer.length
        ? calculateVariance(accelerometerBuffer)
        : 0;
    accelerometerBuffer = [];

    const point = {
        id: crypto.randomUUID(),
        rideId: currentRideId,
        timestamp,
        latitude, longitude, altitude, accuracy,
        roughnessValue: roughness
    };
    currentRideDataPoints.push(point);
    dataPointsCounter.textContent = `Data Points: ${currentRideDataPoints.length}`;

    await updateRoughnessMap(point);
    updateMapDisplay(point);

    statusDiv.textContent = `Lat ${latitude.toFixed(4)}, Lon ${longitude.toFixed(4)}, Roughness ${roughness.toFixed(2)}`;
}

// --- IndexedDB: RoughnessMap ops ---
async function updateRoughnessMap(dp) {
    const geoId = getGeoId(dp.latitude, dp.longitude);
    const tx = db.transaction('RoughnessMap', 'readwrite');
    const store = tx.objectStore('RoughnessMap');
    const existing = await promisifiedDbRequest(store.get(geoId));

    const entry = existing
        ? { ...existing, latitude: dp.latitude, longitude: dp.longitude,
            roughnessValue: dp.roughnessValue, lastUpdated: dp.timestamp }
        : { geoId, latitude: dp.latitude, longitude: dp.longitude,
            roughnessValue: dp.roughnessValue, lastUpdated: dp.timestamp };

    await promisifiedDbRequest(store.put(entry));
    await tx.complete;
}

// --- Map Rendering ---
function updateMapDisplay(dp) {
    const latlng = [dp.latitude, dp.longitude];

    if (!currentLocationMarker) {
        currentLocationMarker = L.marker(latlng).addTo(map);
    } else {
        currentLocationMarker.setLatLng(latlng);
    }

    map.setView(latlng, Math.max(map.getZoom(), 15));

    // draw just the newest segment
    const path = currentRidePath.getLatLngs();
    if (path.length) {
        const prev = path[path.length - 1];
        L.polyline([prev, latlng], {
            color: roughnessToGrayscale(dp.roughnessValue),
            weight: 5
        }).addTo(map);
    } else {
        L.polyline([latlng, latlng], {
            color: roughnessToGrayscale(dp.roughnessValue), weight: 5
        }).addTo(map);
    }
    currentRidePath.addLatLng(latlng);

    // overlay nearby historical roughness
    updateHistoricalRoughnessDisplay(dp.latitude, dp.longitude);
}
async function updateHistoricalRoughnessDisplay(lat, lon) {
    historicalRoughnessLayer.clearLayers();
    const tx = db.transaction('RoughnessMap', 'readonly');
    const all = await promisifiedDbRequest(tx.objectStore('RoughnessMap').getAll());
    all.forEach(pt => {
        if (calculateDistance(lat, lon, pt.latitude, pt.longitude) <= HISTORICAL_DATA_RADIUS_M) {
            L.circleMarker([pt.latitude, pt.longitude], {
                radius: 4,
                fillColor: roughnessToGrayscale(pt.roughnessValue),
                color: '#000', weight: 1, opacity: 0.7, fillOpacity: 0.7
            })
            .bindPopup(`Roughness: ${pt.roughnessValue.toFixed(2)}<br>Updated: ${new Date(pt.lastUpdated).toLocaleDateString()}`)
            .addTo(historicalRoughnessLayer);
        }
    });
    await tx.complete;
}

// --- Ride Control ---
async function startRide() {
    if (currentRideId) return;

    // reset state
    currentRideId = Date.now();
    currentRideDataPoints = [];
    accelerometerBuffer = [];
    latestGpsPosition = null;
    dataPointsCounter.textContent = 'Data Points: 0';
    statusDiv.textContent = 'Requesting permissions…';

    // reset map overlays & path
    if (currentRidePath) map.removeLayer(currentRidePath);
    currentRidePath = L.polyline([], { color: '#808080', weight: 5 }).addTo(map);
    if (currentLocationMarker) map.removeLayer(currentLocationMarker);
    historicalRoughnessLayer.clearLayers();

    // 1) GPS
    watchId = navigator.geolocation.watchPosition(gpsSuccess, gpsError, {
        enableHighAccuracy: true, timeout: 10000, maximumAge: 0
    });

    // 2) Accelerometer permission (iOS/modern Android)
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
            console.error('Motion permission error:', err);
            statusDiv.textContent = 'Error requesting motion permission.';
        }
    } else {
        // fallback
        window.addEventListener('devicemotion', handleMotion);
        motionListenerActive = true;
    }

    // 3) start the 3s data pump
    dataCollectionInterval = setInterval(processCombinedDataPoint, DATA_COLLECTION_INTERVAL_MS);

    // save initial ride record
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

    // write data points + update ride summary
    try {
        const tx = db.transaction(['rides', 'rideDataPoints'], 'readwrite');
        const ridesStore = tx.objectStore('rides');
        const dpStore    = tx.objectStore('rideDataPoints');

        for (const dp of currentRideDataPoints) {
            await promisifiedDbRequest(dpStore.put(dp));
        }

        const rideRecord = await promisifiedDbRequest(ridesStore.get(currentRideId));
        const updated = {
            ...rideRecord,
            endTime: Date.now(),
            duration: Math.floor((Date.now() - rideRecord.startTime)/1000),
            totalDataPoints: currentRideDataPoints.length,
            status: 'completed'
        };
        await promisifiedDbRequest(ridesStore.put(updated));
        await tx.complete;

        statusDiv.textContent = `Ride saved!`;
    } catch (err) {
        console.error('Error saving ride:', err);
        statusDiv.textContent = 'Error saving ride data.';
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

// --- Past Rides UI ---
async function loadPastRides() {
    pastRidesList.innerHTML = '';
    if (!db) return;

    try {
        const tx = db.transaction('rides', 'readonly');
        const all = await promisifiedDbRequest(tx.objectStore('rides').getAll());
        await tx.complete;

        if (!all.length) {
            pastRidesList.innerHTML = '<li>No past rides recorded.</li>';
            return;
        }

        all.sort((a,b) => b.startTime - a.startTime).forEach(r => {
            const li = document.createElement('li');
            const start = new Date(r.startTime).toLocaleString();
            const durM = Math.floor(r.duration/60), durS = r.duration % 60;
            li.innerHTML = `
                <strong>Start:</strong> ${start}<br>
                <strong>Duration:</strong> ${durM}m ${durS}s<br>
                <strong>Points:</strong> ${r.totalDataPoints}
            `;
            li.onclick = () => showRideDetails(r.rideId);
            pastRidesList.appendChild(li);
        });
    } catch (err) {
        console.error('Error loading past rides:', err);
        statusDiv.textContent = 'Error loading past rides.';
    }
}

async function showRideDetails(rideId) {
    rideDetailView.classList.remove('hidden');
    detailContent.textContent = 'Loading…';

    try {
        const tx = db.transaction(['rides','rideDataPoints'],'readonly');
        const rideRec = await promisifiedDbRequest(tx.objectStore('rides').get(rideId));
        const dps = await promisifiedDbRequest(tx.objectStore('rideDataPoints').index('by_rideId').getAll(rideId));
        await tx.complete;

        if (!rideRec || !dps.length) {
            detailContent.textContent = 'No data.';
            return;
        }

        let txt = `Ride ID: ${rideRec.rideId}\nStart: ${new Date(rideRec.startTime).toLocaleString()}\n` +
                  `End: ${new Date(rideRec.endTime).toLocaleString()}\nDuration: ${Math.floor(rideRec.duration/60)}m ${rideRec.duration%60}s\n` +
                  `Points: ${rideRec.totalDataPoints}\n\n--- Data Points ---\n`;

        dps.forEach(dp => {
            txt += `${new Date(dp.timestamp).toLocaleTimeString()} | ` +
                   `Lat ${dp.latitude.toFixed(5)}, Lon ${dp.longitude.toFixed(5)} | ` +
                   `Roughness ${dp.roughnessValue.toFixed(3)}\n`;
        });
        detailContent.textContent = txt;
    } catch (err) {
        console.error('Error showing details:', err);
        detailContent.textContent = 'Error loading ride details.';
    }
}
function hideRideDetails() {
    rideDetailView.classList.add('hidden');
    detailContent.textContent = '';
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    statusDiv          = document.getElementById('status');
    startButton        = document.getElementById('startButton');
    stopButton         = document.getElementById('stopButton');
    dataPointsCounter  = document.getElementById('dataPointsCounter');
    pastRidesList      = document.getElementById('pastRidesList');
    rideDetailView     = document.getElementById('rideDetailView');
    detailContent      = document.getElementById('detailContent');
    closeDetailButton  = document.getElementById('closeDetailButton');

    startButton.addEventListener('click', startRide);
    stopButton.addEventListener('click', stopRide);
    closeDetailButton.addEventListener('click', hideRideDetails);

    initializeMap();
    openDb();
});
