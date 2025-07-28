// Global variables for IndexedDB and ride state
let db;
let currentRideId = null;
let currentRideDataPoints = [];
let accelerometerBuffer = [];
let lastGpsTimestamp = 0;
let lastGpsCoords = { latitude: 0, longitude: 0 };
let watchId = null; // To store the ID returned by watchPosition
let motionListenerActive = false;

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
const DB_VERSION = 1;

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
                const dataPointsStore = db.createObjectStore('rideDataPoints', { keyPath: 'id' });
                // Create an index on rideId for efficient querying
                dataPointsStore.createIndex('by_rideId', 'rideId', { unique: false });
                console.log('Object store "rideDataPoints" created.');
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
        let roughnessValue = 0;
        if (accelerometerBuffer.length > 0) {
            roughnessValue = calculateVariance(accelerometerBuffer);
            // console.log(`Processed ${accelerometerBuffer.length} accel points. Roughness: ${roughnessValue.toFixed(3)}`); // Debugging line
            accelerometerBuffer = []; // Clear buffer after processing
        } else {
            // console.log("Accelerometer buffer was empty when GPS point arrived."); // Debugging line
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
    // Automatically stop ride on critical errors like permission denied
    if (error.code === error.PERMISSION_DENIED) {
        stopRide();
    }
}

// DeviceMotion handler
function handleMotion(event) {
    if (currentRideId && event.accelerationIncludingGravity) {
        const z = event.accelerationIncludingGravity.z;
        if (typeof z === 'number' && !isNaN(z)) { // Ensure it's a valid number
             accelerometerBuffer.push(z);
            //  console.log(`Accel Z: ${z.toFixed(2)} (Buffer size: ${accelerometerBuffer.length})`); // Debugging line
        }
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
        watchId = navigator.geolocation.watchPosition(gpsSuccess, gpsError, {
            enableHighAccuracy: true,
            timeout: 10000, // 10 seconds timeout for initial fix
            maximumAge: 0 // No cached position
        });

        // Add device motion listener
        if ('DeviceMotionEvent' in window) { // Check if DeviceMotionEvent is supported
            window.addEventListener('devicemotion', handleMotion);
            motionListenerActive = true;
            console.log('DeviceMotion listener attached.');
        } else {
            console.warn('DeviceMotionEvent not supported on this device/browser. Roughness data may not be recorded.');
            statusDiv.textContent = 'Device motion not supported. Roughness data may not be recorded.';
        }


        // Save initial ride entry to IndexedDB
        const transaction = db.transaction(['rides'], 'readwrite');
        const store = transaction.objectStore('rides');
        await promisifiedDbRequest(store.add({ // Use the helper
            rideId: currentRideId,
            startTime: currentRideId,
            endTime: null,
            duration: 0,
            totalDataPoints: 0,
            status: 'active'
        }));
        await transaction.complete; // Wait for transaction to complete

        startButton.disabled = true;
        stopButton.disabled = false;
        statusDiv.textContent = 'Recording... Waiting for GPS fix.';
        console.log(`Ride ${currentRideId} started.`);

    } catch (error) {
        console.error('Error starting ride:', error);
        statusDiv.textContent = 'Failed to start ride. Check permissions and device support.';
        // Ensure buttons are reset if start fails
        startButton.disabled = false;
        stopButton.disabled = true;
        // Attempt to clean up any started listeners if an error occurred during setup
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
        if (motionListenerActive) {
            window.removeEventListener('devicemotion', handleMotion);
            motionListenerActive = false;
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

    statusDiv.textContent = 'Saving ride data...';

    try {
        const transaction = db.transaction(['rides', 'rideDataPoints'], 'readwrite');
        const ridesStore = transaction.objectStore('rides');
        const dataPointsStore = transaction.objectStore('rideDataPoints');

        // Add all collected data points to IndexedDB
        for (const dp of currentRideDataPoints) {
            await promisifiedDbRequest(dataPointsStore.put(dp)); // Use the helper
        }

        // Update the ride summary
        const existingRide = await promisifiedDbRequest(ridesStore.get(currentRideId));
       
        if (existingRide) {
            // *** CRITICAL FIX FOR DATACLONEERROR & DataError ***
            // Explicitly create a new object and assign properties, ensuring 'rideId' is there.
            const rideToUpdate = {
                rideId: existingRide.rideId, // Ensure rideId is copied from the fetched object
                startTime: existingRide.startTime,
                endTime: Date.now(),
                duration: Math.floor((Date.now() - existingRide.startTime) / 1000), // in seconds
                totalDataPoints: currentRideDataPoints.length,
                status: 'completed'
            };

            // Verify rideId exists on the object to be stored,
            // this handles the "key path did not yield a value" DataError.
            if (typeof rideToUpdate.rideId === 'undefined' || rideToUpdate.rideId === null) {
                console.error("Error: rideId is missing or null for object to be stored.", rideToUpdate);
                throw new Error("Cannot save ride: rideId is missing.");
            }

            await promisifiedDbRequest(ridesStore.put(rideToUpdate)); // Use the helper
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
        
        // *** CRITICAL FIX FOR .sort IS NOT A FUNCTION ***
        // Use the promisified helper to ensure we get the actual result array.
        const allRides = await promisifiedDbRequest(store.getAll()); 
        
        await transaction.complete; // Ensure transaction completes after getting data

        // Explicitly check if it's an array for maximum robustness
        if (!Array.isArray(allRides)) {
            console.error('store.getAll() did not return an array despite promisified request:', allRides);
            statusDiv.textContent = 'Error: Unexpected data type for past rides.';
            return; // Exit if not an array
        }

        if (allRides.length === 0) {
            pastRidesList.innerHTML = '<li class="text-center text-gray-500">No past rides recorded.</li>';
            console.log('No past rides found.');
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
                           `Lat: ${dp.latitude?.toFixed(5) ?? 'N/A'} | ` + // Added nullish coalescing for safety
                           `Lon: ${dp.longitude?.toFixed(5) ?? 'N/A'} | ` +
                           `Roughness: ${dp.roughnessValue?.toFixed(3) ?? 'N/A'}\n`; // Added nullish coalescing for safety
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

    openDb(); // Open IndexedDB and then load past rides
});
