// Global variables for IndexedDB and ride state
let db;
let currentRideId = null;
let currentRideDataPoints = [];
let accelerometerBuffer = [];
let lastGpsTimestamp = 0;
let lastGpsCoords = { latitude: 0, longitude: 0 };
let watchId = null; // To store the ID returned by watchPosition
let motionListenerActive = false;
let accelerometerInterval = null; // To store the interval for accelerometer processing

// DOM Elements
const statusDiv = document.getElementById('status');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const dataPointsCounter = document.getElementById('dataPointsCounter');
const pastRidesList = document.getElementById('pastRidesList');
const rideDetailView = document.getElementById('rideDetailView');
const detailContent = document.getElementById('detailContent');
const closeDetailButton = document.getElementById('closeDetailButton');

const DB_NAME = 'BikeRoughnessDB';
const DB_VERSION = 1;

// --- IndexedDB Initialization ---
function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            // Create object stores if they don't exist
            if (!db.objectStoreNames.contains('rides')) {
                db.createObjectStore('rides', { keyPath: 'rideId' });
            }
            if (!db.objectStoreNames.contains('rideDataPoints')) {
                const dataPointsStore = db.createObjectStore('rideDataPoints', { keyPath: 'id' });
                // Create an index on rideId for efficient querying
                dataPointsStore.createIndex('by_rideId', 'rideId', { unique: false });
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
            console.error('IndexedDB error:', event.target.errorCode);
            statusDiv.textContent = 'Error opening database.';
            reject(event.target.errorCode);
        };
    });
}

// --- Geolocation and DeviceMotion Handlers ---

// Calculate variance for roughness
function calculateVariance(data) {
    if (data.length === 0) return 0;
    const mean = data.reduce((sum, val) => sum + val, 0) / data.length;
    const variance = data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length;
    return variance;
}

// GPS success callback
function gpsSuccess(position) {
    const { latitude, longitude, altitude, accuracy } = position.coords;
    const timestamp = position.timestamp;

    // Throttle GPS updates: only record if moved significantly or enough time passed
    const distanceMoved = calculateDistance(
        lastGpsCoords.latitude, lastGpsCoords.longitude,
        latitude, longitude
    ); // Haversine formula for distance
    const timeElapsed = timestamp - lastGpsTimestamp;

    if (timeElapsed >= 2000 || distanceMoved >= 5) { // 2 seconds or 5 meters
        // Find the most recent roughness value from the buffer
        let roughnessValue = 0;
        if (accelerometerBuffer.length > 0) {
            roughnessValue = calculateVariance(accelerometerBuffer);
            accelerometerBuffer = []; // Clear buffer after processing
        }

        const dataPoint = {
            id: crypto.randomUUID(), // Generate a unique ID for each data point
            rideId: currentRideId,
            timestamp: timestamp,
            latitude: latitude,
            longitude: longitude,
            altitude: altitude,
            accuracy: accuracy,
            roughnessValue: roughnessValue
        };
        currentRideDataPoints.push(dataPoint);
        dataPointsCounter.textContent = `Data Points: ${currentRideDataPoints.length}`;
        lastGpsTimestamp = timestamp;
        lastGpsCoords = { latitude, longitude };
        statusDiv.textContent = `Recording... Lat: ${latitude.toFixed(4)}, Lon: ${longitude.toFixed(4)}, Roughness: ${roughnessValue.toFixed(2)}`;
    }
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
    stopRide(); // Stop ride on critical GPS error
}

// DeviceMotion handler
function handleMotion(event) {
    if (currentRideId && event.accelerationIncludingGravity) {
        // Collect Z-axis acceleration data
        accelerometerBuffer.push(event.accelerationIncludingGravity.z);
    }
}

// --- Ride Control Functions ---

async function startRide() {
    if (currentRideId) return; // Already recording

    // Reset state for a new ride
    currentRideId = Date.now(); // Use timestamp as unique ride ID
    currentRideDataPoints = [];
    accelerometerBuffer = [];
    lastGpsTimestamp = 0;
    lastGpsCoords = { latitude: 0, longitude: 0 };
    dataPointsCounter.textContent = 'Data Points: 0';
    statusDiv.textContent = 'Requesting GPS and motion permissions...';

    try {
        // Request geolocation permission (watchPosition implicitly requests)
        // Start watching position
        watchId = navigator.geolocation.watchPosition(gpsSuccess, gpsError, {
            enableHighAccuracy: true,
            timeout: 10000, // 10 seconds timeout for initial fix
            maximumAge: 0 // No cached position
        });

        // Add device motion listener
        window.addEventListener('devicemotion', handleMotion);
        motionListenerActive = true;

        // Save initial ride entry to IndexedDB
        const transaction = db.transaction(['rides'], 'readwrite');
        const store = transaction.objectStore('rides');
        await store.add({
            rideId: currentRideId,
            startTime: currentRideId,
            endTime: null,
            duration: 0,
            totalDataPoints: 0,
            status: 'active'
        });
        await transaction.complete; // Wait for transaction to complete

        startButton.disabled = true;
        stopButton.disabled = false;
        statusDiv.textContent = 'Recording... Waiting for GPS fix.';
        console.log(`Ride ${currentRideId} started.`);

    } catch (error) {
        console.error('Error starting ride:', error);
        statusDiv.textContent = 'Failed to start ride. Check permissions and device support.';
        stopRide(); // Clean up if start fails
    }
}

async function stopRide() {
    if (!currentRideId) return; // Not recording

    // Stop sensor listeners
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (motionListenerActive) {
        window.removeEventListener('devicemotion', handleMotion);
        motionListenerActive = false;
    }

    statusDiv.textContent = 'Saving ride data...';

    try {
        const transaction = db.transaction(['rides', 'rideDataPoints'], 'readwrite');
        const ridesStore = transaction.objectStore('rides');
        const dataPointsStore = transaction.objectStore('rideDataPoints');

        // Add all collected data points to IndexedDB
        for (const dp of currentRideDataPoints) {
            await dataPointsStore.add(dp);
        }

        // Update the ride summary
        const ride = await ridesStore.get(currentRideId);
        if (ride) {
            ride.endTime = Date.now();
            ride.duration = Math.floor((ride.endTime - ride.startTime) / 1000); // in seconds
            ride.totalDataPoints = currentRideDataPoints.length;
            ride.status = 'completed';
            await ridesStore.put(ride); // Update the existing ride entry
        }
        await transaction.complete; // Wait for transaction to complete

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
        startButton.disabled = false;
        stopButton.disabled = true;
        dataPointsCounter.textContent = 'Data Points: 0';
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
        const allRides = await store.getAll();
        await transaction.complete;

        if (allRides.length === 0) {
            pastRidesList.innerHTML = '<li class="text-center text-gray-500">No past rides recorded.</li>';
            return;
        }

        // Sort by start time, newest first
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

        const ride = await ridesStore.get(rideId);
        const dataPoints = await rideIndex.getAll(rideId);
        await transaction.complete;

        if (!ride || dataPoints.length === 0) {
            detailContent.textContent = 'No details found for this ride.';
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
                           `Lat: ${dp.latitude.toFixed(5)} | ` +
                           `Lon: ${dp.longitude.toFixed(5)} | ` +
                           `Roughness: ${dp.roughnessValue.toFixed(3)}\n`;
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

// --- Utility Function (Haversine for distance calculation) ---
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

// --- Event Listeners ---
startButton.addEventListener('click', startRide);
stopButton.addEventListener('click', stopRide);
closeDetailButton.addEventListener('click', hideRideDetails);

// --- Initialize on DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', () => {
    openDb(); // Open IndexedDB and then load past rides
});
