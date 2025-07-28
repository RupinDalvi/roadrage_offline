// Global variables for IndexedDB and ride state
let db;
let currentRideId = null;
let currentRideDataPoints = []; // Stores data points for the *current* ride
let accelerometerBuffer = []; // Buffer for raw accelerometer Z-axis values
let latestGpsPosition = null; // Stores the most recent raw GPS position
let watchId = null; // To store the ID returned by watchPosition
let motionListenerActive = false;
let dataCollectionInterval = null; // To store the interval for combined data processing

// Map variables
let map = null;
let currentLocationMarker = null;
let currentRidePath = null; // Leaflet polyline for the current ride's path
let historicalRoughnessLayer = null; // Leaflet layer group for historical data markers
let mapInitialized = false; // Flag to ensure map is only initialized once

// DOM Elements - Declare them here, but assign them inside DOMContentLoaded
let statusDiv;
let startButton;
let stopButton;
let dataPointsCounter;
let pastRidesList;
let rideDetailView;
let detailContent;
let closeDetailButton;

const DB_NAME = 'BikeRoughnessDB';
const DB_VERSION = 2; // *** IMPORTANT: Increment DB version for schema changes ***
const DATA_COLLECTION_INTERVAL_MS = 3000; // 3 seconds
const HISTORICAL_DATA_RADIUS_M = 150; // Radius for displaying previous roughness data

// --- IndexedDB Helper Function ---
// This function wraps an IDBRequest into a Promise,
// ensuring it resolves with event.target.result on success
// and rejects with event.target.error on error.
function promisifiedDbRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = (event) => {
            resolve(event.target.result);
        };
        request.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

// --- IndexedDB Initialization ---
function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            // Create object stores if they don't exist
            if (!db.objectStoreNames.contains('rides')) {
                db.createObjectStore('rides', { keyPath: 'rideId' });
                console.log('Object store "rides" created.');
            }
            if (!db.objectStoreNames.contains('rideDataPoints')) {
                db.createObjectStore('rideDataPoints', { keyPath: 'id' });
                const dataPointsStore = db.transaction.objectStore('rideDataPoints'); // Get reference for index creation
                dataPointsStore.createIndex('by_rideId', 'rideId', { unique: false });
                console.log('Object store "rideDataPoints" created.');
            }
            // *** NEW: RoughnessMap object store for global unique locations ***
            if (!db.objectStoreNames.contains('RoughnessMap')) {
                db.createObjectStore('RoughnessMap', { keyPath: 'geoId' });
                // We might add indexes for lat/lon if we want to do more complex spatial queries later,
                // but for 150m, getting all and filtering client-side is often simpler for MVP.
                console.log('Object store "RoughnessMap" created.');
            }
            console.log('IndexedDB upgrade complete.');
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('IndexedDB opened successfully.');
            resolve(db);
            loadPastRides(); // Load rides once DB is open
        };

        request.onerror = (event) => {
            console.error('IndexedDB error:', event.target.errorCode, event);
            statusDiv.textContent = 'Error opening database.';
            reject(event.target.errorCode);
        };
    });
}

// --- Map Initialization ---
function initializeMap() {
    if (mapInitialized) return;

    // Default view for Calgary
    map = L.map('map').setView([51.0447, -114.0719], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // Initialize layers
    historicalRoughnessLayer = L.layerGroup().addTo(map);
    currentRidePath = L.polyline([], { color: '#808080', weight: 4 }).addTo(map); // Default color for current path

    mapInitialized = true;
    console.log('Leaflet map initialized.');
}

// --- Utility Functions ---
function calculateVariance(data) {
    if (data.length === 0) return 0;
    const mean = data.reduce((sum, val) => sum + val, 0) / data.length;
    const variance = data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length;
    return variance;
}

// Grayscale color based on roughness (0=smooth, higher=rougher)
// Returns hex color string, e.g., #FFFFFF for 0, #000000 for max_roughness
function roughnessToGrayscale(roughness, maxRoughness = 100) { // Adjust maxRoughness based on observed data
    const normalized = Math.min(1, roughness / maxRoughness);
    const grayValue = Math.floor(255 * (1 - normalized)); // Invert: 255 for smooth, 0 for rough
    const hex = grayValue.toString(16).padStart(2, '0');
    return `#${hex}${hex}${hex}`;
}

// Generates a geographic ID for proximity-based updates (e.g., "45.1234_114.5678")
// Adjust precision for desired proximity: 4 decimal places is ~11 meters at equator
function getGeoId(latitude, longitude, precision = 4) {
    return `${latitude.toFixed(precision)}_${longitude.toFixed(precision)}`;
}

// Haversine formula for distance calculation between two lat/lon points in meters
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI / 180; // φ, λ in radians
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const d = R * c; // in metres
    return d;
}

// --- Sensor Data Collection & Processing ---

// GPS success callback - just updates latestGpsPosition
function gpsSuccess(position) {
    latestGpsPosition = position;
    // console.log(`Raw GPS: ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`);
}

// GPS error callback
function gpsError(error) {
    let errorMessage = 'An unknown GPS error occurred.';
    switch (error.code) {
        case error.PERMISSION_DENIED:
            errorMessage = 'GPS permission denied. Please enable location services for this site.';
            break;
        case error.POSITION_UNAVAILABLE:
            errorMessage = 'GPS position unavailable. Check your device settings.';
            break;
        case error.TIMEOUT:
            errorMessage = 'GPS request timed out. Trying again...';
            break;
    }
    statusDiv.textContent = errorMessage;
    console.error('GPS Error:', error);
    if (error.code === error.PERMISSION_DENIED) {
        stopRide();
    }
}

// DeviceMotion handler - just buffers accelerometer data
function handleMotion(event) {
    if (event.accelerationIncludingGravity) {
        const z = event.accelerationIncludingGravity.z;
        if (typeof z === 'number' && !isNaN(z)) {
             accelerometerBuffer.push(z);
        }
    }
}

// Main function to process combined sensor data every X seconds
async function processCombinedDataPoint() {
    if (!currentRideId || !latestGpsPosition) {
        statusDiv.textContent = 'Recording... Waiting for GPS fix.';
        return; // Wait for first GPS fix
    }

    const { latitude, longitude, altitude, accuracy } = latestGpsPosition.coords;
    const timestamp = latestGpsPosition.timestamp;

    let roughnessValue = 0;
    if (accelerometerBuffer.length > 0) {
        roughnessValue = calculateVariance(accelerometerBuffer);
        accelerometerBuffer = []; // Clear buffer after processing
    }

    const dataPoint = {
        id: crypto.randomUUID(),
        rideId: currentRideId, // Link to current ride history
        timestamp: timestamp,
        latitude: latitude,
        longitude: longitude,
        altitude: altitude,
        accuracy: accuracy,
        roughnessValue: roughnessValue
    };

    // 1. Add to current ride's history data
    currentRideDataPoints.push(dataPoint);
    dataPointsCounter.textContent = `Data Points: ${currentRideDataPoints.length}`;

    // 2. Update RoughnessMap (global map data)
    await updateRoughnessMap(dataPoint);

    // 3. Update Map UI
    updateMapDisplay(dataPoint);

    statusDiv.textContent = `Recording... Lat: ${latitude.toFixed(4)}, Lon: ${longitude.toFixed(4)}, Roughness: ${roughnessValue.toFixed(2)}`;
}

// --- RoughnessMap (Global Data) Management ---
async function updateRoughnessMap(newDataPoint) {
    const geoId = getGeoId(newDataPoint.latitude, newDataPoint.longitude);
    const roughnessMapTx = db.transaction(['RoughnessMap'], 'readwrite');
    const roughnessMapStore = roughnessMapTx.objectStore('RoughnessMap');

    try {
        const existingEntry = await promisifiedDbRequest(roughnessMapStore.get(geoId));

        let entryToSave;
        if (existingEntry) {
            // Overwrite existing data at the same geoId
            entryToSave = {
                ...existingEntry, // Keep existing properties
                latitude: newDataPoint.latitude, // Update with more precise current location
                longitude: newDataPoint.longitude,
                roughnessValue: newDataPoint.roughnessValue, // Overwrite roughness
                lastUpdated: newDataPoint.timestamp // Update timestamp
            };
            console.log(`Updated RoughnessMap for ${geoId} with new roughness: ${newDataPoint.roughnessValue.toFixed(2)}`);
        } else {
            // Add new entry
            entryToSave = {
                geoId: geoId,
                latitude: newDataPoint.latitude,
                longitude: newDataPoint.longitude,
                roughnessValue: newDataPoint.roughnessValue,
                lastUpdated: newDataPoint.timestamp
            };
            console.log(`Added new RoughnessMap entry for ${geoId} with roughness: ${newDataPoint.roughnessValue.toFixed(2)}`);
        }
        await promisifiedDbRequest(roughnessMapStore.put(entryToSave));
        await roughnessMapTx.complete;
    } catch (error) {
        console.error('Error updating RoughnessMap:', error);
    }
}

// --- Map Display Functions ---
function updateMapDisplay(dataPoint) {
    const latlng = [dataPoint.latitude, dataPoint.longitude];

    // Update current location marker
    if (!currentLocationMarker) {
        currentLocationMarker = L.marker(latlng).addTo(map);
    } else {
        currentLocationMarker.setLatLng(latlng);
    }

    // Update map view to follow rider
    map.setView(latlng, map.getZoom() > 15 ? map.getZoom() : 15); // Zoom in if not already very close

    // Update current ride path
    const currentPathLatLngs = currentRidePath.getLatLngs();
    if (currentPathLatLngs.length > 0) {
        // Create a new polyline segment for just the last part to color it
        const prevLatLng = currentPathLatLngs[currentPathLatLngs.length - 1];
        L.polyline([prevLatLng, latlng], {
            color: roughnessToGrayscale(dataPoint.roughnessValue),
            weight: 5
        }).addTo(map);
    } else {
        // For the very first point, add it and it will be part of the first segment
        L.polyline([latlng, latlng], { // A tiny segment to show the start point's color
            color: roughnessToGrayscale(dataPoint.roughnessValue),
            weight: 5
        }).addTo(map);
    }
    // Add the new point to the currentRidePath's internal list for future segments
    currentRidePath.addLatLng(latlng);


    // Update historical roughness data on map
    updateHistoricalRoughnessDisplay(dataPoint.latitude, dataPoint.longitude);
}

async function updateHistoricalRoughnessDisplay(currentLat, currentLon) {
    historicalRoughnessLayer.clearLayers(); // Clear previous historical markers

    const roughnessMapTx = db.transaction(['RoughnessMap'], 'readonly');
    const roughnessMapStore = roughnessMapTx.objectStore('RoughnessMap');

    try {
        const allRoughnessPoints = await promisifiedDbRequest(roughnessMapStore.getAll());
        await roughnessMapTx.complete;

        allRoughnessPoints.forEach(point => {
            const distance = calculateDistance(currentLat, currentLon, point.latitude, point.longitude);
            if (distance <= HISTORICAL_DATA_RADIUS_M) {
                // Add a circle marker for historical points within radius
                L.circleMarker([point.latitude, point.longitude], {
                    radius: 4,
                    fillColor: roughnessToGrayscale(point.roughnessValue),
                    color: '#000',
                    weight: 1,
                    opacity: 0.7,
                    fillOpacity: 0.7
                })
                .bindPopup(`Roughness: ${point.roughnessValue.toFixed(2)}<br>Updated: ${new Date(point.lastUpdated).toLocaleDateString()}`)
                .addTo(historicalRoughnessLayer);
            }
        });
    } catch (error) {
        console.error('Error loading historical roughness data:', error);
    }
}


// --- Ride Control Functions ---

async function startRide() {
    if (currentRideId) return; // Already recording

    // Reset state for a new ride
    currentRideId = Date.now(); // Use timestamp as unique ride ID
    currentRideDataPoints = [];
    accelerometerBuffer = [];
    latestGpsPosition = null; // Clear latest GPS for new ride
    dataPointsCounter.textContent = 'Data Points: 0';
    statusDiv.textContent = 'Requesting GPS and motion permissions...';

    // Clear previous map path and markers for new ride
    if (currentRidePath) {
        currentRidePath.setLatLngs([]); // Reset polyline
        map.removeLayer(currentRidePath); // Remove old polyline
    }
    currentRidePath = L.polyline([], { color: '#808080', weight: 5 }).addTo(map); // Add new polyline
    
    if (currentLocationMarker) {
        map.removeLayer(currentLocationMarker);
        currentLocationMarker = null; // Remove old marker
    }
    historicalRoughnessLayer.clearLayers(); // Clear historical layer too

    try {
        // Start watching raw GPS position
        watchId = navigator.geolocation.watchPosition(gpsSuccess, gpsError, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        });

        // Add device motion listener
        if ('DeviceMotionEvent' in window) {
            window.addEventListener('devicemotion', handleMotion);
            motionListenerActive = true;
            console.log('DeviceMotion listener attached.');
        } else {
            console.warn('DeviceMotionEvent not supported on this device/browser. Roughness data may not be recorded.');
            statusDiv.textContent = 'Device motion not supported. Roughness data may not be recorded.';
        }

        // Start interval for processing combined data every 3 seconds
        dataCollectionInterval = setInterval(processCombinedDataPoint, DATA_COLLECTION_INTERVAL_MS);
        console.log(`Data collection interval started (every ${DATA_COLLECTION_INTERVAL_MS / 1000}s).`);

        // Save initial ride entry to IndexedDB
        const transaction = db.transaction(['rides'], 'readwrite');
        const store = transaction.objectStore('rides');
        await promisifiedDbRequest(store.add({
            rideId: currentRideId,
            startTime: currentRideId,
            endTime: null,
            duration: 0,
            totalDataPoints: 0,
            status: 'active'
        }));
        await transaction.complete;

        startButton.disabled = true;
        stopButton.disabled = false;
        statusDiv.textContent = 'Recording... Waiting for GPS fix.';
        console.log(`Ride ${currentRideId} started.`);

    } catch (error) {
        console.error('Error starting ride:', error);
        statusDiv.textContent = 'Failed to start ride. Check permissions and device support.';
        startButton.disabled = false;
        stopButton.disabled = true;
        // Clean up any started listeners if an error occurred during setup
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
    }
}

async function stopRide() {
    if (!currentRideId) return; // Not recording

    // Stop sensor listeners
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        console.log('GPS watch cleared.');
    }
    if (motionListenerActive) {
        window.removeEventListener('devicemotion', handleMotion);
        motionListenerActive = false;
        console.log('DeviceMotion listener removed.');
    }
    if (dataCollectionInterval !== null) {
        clearInterval(dataCollectionInterval);
        dataCollectionInterval = null;
        console.log('Data collection interval cleared.');
    }

    statusDiv.textContent = 'Saving ride data...';

    try {
        const transaction = db.transaction(['rides', 'rideDataPoints'], 'readwrite');
        const ridesStore = transaction.objectStore('rides');
        const dataPointsStore = transaction.objectStore('rideDataPoints');

        // Add all collected data points for the current ride to IndexedDB
        for (const dp of currentRideDataPoints) {
            await promisifiedDbRequest(dataPointsStore.put(dp));
        }

        // Update the ride summary
        const existingRide = await promisifiedDbRequest(ridesStore.get(currentRideId));
       
        if (existingRide) {
            const rideToUpdate = {
                rideId: existingRide.rideId,
                startTime: existingRide.startTime,
                endTime: Date.now(),
                duration: Math.floor((Date.now() - existingRide.startTime) / 1000), // in seconds
                totalDataPoints: currentRideDataPoints.length,
                status: 'completed'
            };

            if (typeof rideToUpdate.rideId === 'undefined' || rideToUpdate.rideId === null) {
                console.error("Error: rideId is missing or null for object to be stored.", rideToUpdate);
                throw new Error("Cannot save ride: rideId is missing.");
            }

            await promisifiedDbRequest(ridesStore.put(rideToUpdate));
        }
        await transaction.complete;

        statusDiv.textContent = `Ride ${currentRideId} saved successfully!`;
        console.log(`Ride ${currentRideId} stopped and saved.`);

    } catch (error) {
        console.error('Error saving ride data:', error);
        statusDiv.textContent = 'Error saving ride data.';
    } finally {
        // Reset ride state
        currentRideId = null;
        currentRideDataPoints = [];
        accelerometerBuffer = [];
        latestGpsPosition = null; // Clear latest GPS position
        startButton.disabled = false;
        stopButton.disabled = true;
        dataPointsCounter.textContent = 'Data Points: 0';
        
        // Clear current ride path from map
        if (currentRidePath) {
            currentRidePath.setLatLngs([]);
            if(currentLocationMarker) map.removeLayer(currentLocationMarker); // Remove location marker
            currentLocationMarker = null;
        }
        historicalRoughnessLayer.clearLayers(); // Clear historical layer after ride ends

        loadPastRides(); // Refresh the list of past rides
    }
}

// --- Past Rides Display ---
async function loadPastRides() {
    pastRidesList.innerHTML = ''; // Clear existing list
    if (!db) {
        statusDiv.textContent = 'Database not ready.';
        return;
    }

    try {
        const transaction = db.transaction(['rides'], 'readonly');
        const store = transaction.objectStore('rides');
        
        const allRides = await promisifiedDbRequest(store.getAll()); 
        
        await transaction.complete;

        if (!Array.isArray(allRides)) {
            console.error('store.getAll() did not return an array despite promisified request:', allRides);
            statusDiv.textContent = 'Error: Unexpected data type for past rides.';
            return;
        }

        if (allRides.length === 0) {
            pastRidesList.innerHTML = '<li class="text-center text-gray-500">No past rides recorded.</li>';
            console.log('No past rides found.');
            return;
        }

        allRides.sort((a, b) => b.startTime - a.startTime);

        allRides.forEach(ride => {
            const listItem = document.createElement('li');
            listItem.dataset.rideId = ride.rideId;
            const startDate = new Date(ride.startTime).toLocaleString();
            const durationMinutes = Math.floor(ride.duration / 60);
            const durationSeconds = ride.duration % 60;

            listItem.innerHTML = `
                <strong>Ride started:</strong> ${startDate}<br>
                <strong>Duration:</strong> ${durationMinutes}m ${durationSeconds}s<br>
                <strong>Data Points:</strong> ${ride.totalDataPoints}
            `;
            listItem.addEventListener('click', () => showRideDetails(ride.rideId));
            pastRidesList.appendChild(listItem);
        });
        console.log('Past rides loaded successfully.');
    } catch (error) {
        console.error('Error loading past rides:', error);
        statusDiv.textContent = 'Error loading past rides.';
    }
}

async function showRideDetails(rideId) {
    detailContent.textContent = 'Loading ride data...';
    rideDetailView.classList.remove('hidden');

    try {
        const transaction = db.transaction(['rides', 'rideDataPoints'], 'readonly');
        const ridesStore = transaction.objectStore('rides');
        const dataPointsStore = transaction.objectStore('rideDataPoints');
        const rideIndex = dataPointsStore.index('by_rideId');

        const ride = await promisifiedDbRequest(ridesStore.get(rideId));
        const dataPoints = await promisifiedDbRequest(rideIndex.getAll(rideId));

        await transaction.complete;

        if (!ride || !Array.isArray(dataPoints) || dataPoints.length === 0) {
            detailContent.textContent = 'No details found for this ride.';
            console.warn(`No ride data found for ID: ${rideId}. Ride:`, ride, 'Data points:', dataPoints);
            return;
        }

        let detailsText = `Ride ID: ${ride.rideId}\n`;
        detailsText += `Start Time: ${new Date(ride.startTime).toLocaleString()}\n`;
        detailsText += `End Time: ${ride.endTime ? new Date(ride.endTime).toLocaleString() : 'N/A'}\n`;
        detailsText += `Duration: ${ride.duration ? `${Math.floor(ride.duration / 60)}m ${ride.duration % 60}s` : 'N/A'}\n`;
        detailsText += `Total Data Points: ${ride.totalDataPoints}\n\n`;
        detailsText += '--- Data Points ---\n';

        dataPoints.forEach(dp => {
            detailsText += `Timestamp: ${new Date(dp.timestamp).toLocaleTimeString()} | ` +
                           `Lat: ${dp.latitude?.toFixed(5) ?? 'N/A'} | ` +
                           `Lon: ${dp.longitude?.toFixed(5) ?? 'N/A'} | ` +
                           `Roughness: ${dp.roughnessValue?.toFixed(3) ?? 'N/A'}\n`;
        });

        detailContent.textContent = detailsText;

    } catch (error) {
        console.error('Error showing ride details:', error);
        detailContent.textContent = 'Error loading ride details.';
    }
}

function hideRideDetails() {
    rideDetailView.classList.add('hidden');
    detailContent.textContent = '';
}

// --- Initialize on DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', () => {
    // Assign DOM elements AFTER the DOM is fully loaded
    statusDiv = document.getElementById('status');
    startButton = document.getElementById('startButton');
    stopButton = document.getElementById('stopButton');
    dataPointsCounter = document.getElementById('dataPointsCounter');
    pastRidesList = document.getElementById('pastRidesList');
    rideDetailView = document.getElementById('rideDetailView');
    detailContent = document.getElementById('detailContent');
    closeDetailButton = document.getElementById('closeDetailButton');

    // Attach event listeners AFTER elements are assigned
    startButton.addEventListener('click', startRide);
    stopButton.addEventListener('click', stopRide);
    closeDetailButton.addEventListener('click', hideRideDetails);

    // Initial check for DeviceMotionEvent support when the app loads
    if (!('DeviceMotionEvent' in window)) {
        console.warn('DeviceMotionEvent is not supported in this browser/device.');
        statusDiv.textContent = 'Device motion (accelerometer) not supported. Roughness data will not be available.';
    }

    initializeMap(); // Initialize the map here
    openDb(); // Open IndexedDB and then load past rides
});
