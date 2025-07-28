// --- Frontend Logic ---
const startStopButton = document.getElementById('startStopButton');
const statusDisplay = document.getElementById('status');
const mapContainer = document.getElementById('map');
const roughnessValueDisplay = document.getElementById('roughnessValue');
const reportList = document.getElementById('reportList');

let map;
let recording = false;
let roughnessData = []; // Array to store roughness readings
let currentRoughness = 0;  // Current estimated roughness value


// Initialize Map
function initMap() {
    map = L.map('map').setView([51.505, -0.09], 13); // London as default view

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
}


// Function to update the map with current location and roughness
function updateMap() {
  if (recording) {
      const lat = navigator.geolocation.getCurrentPosition(position => {
          map.addLayer(L.marker([position.coords.latitude, position.coords.longitude]))
              .bindPopup(`Lat: ${position.coords.latitude}<br>Lon: ${position.coords.longitude}<br>Roughness: ${currentRoughness}`);

      });
  }
}


// Function to display roughness value
function updateRoughnessDisplay(roughness) {
    roughnessValueDisplay.textContent = roughness;
}



startStopButton.addEventListener('click', () => {
    if (recording) {
        stopRecording();
    } else {
        startRecording();
    }
});

// --- Recording Logic ---
function startRecording() {
    recording = true;
    statusDisplay.textContent = 'Recording...';
    roughnessData = []; // Reset data on new recording
    currentRoughness = 0;  //Reset current roughness value
    map.removeLayers(); // Clear the map

    navigator.geolocation.watchPosition(
        (position) => {
            const latitude = position.coords.latitude;
            const longitude = position.coords.longitude;

            // Get accelerometer data (if available and supported by browser)
            navigator.getSensorData({
                accelerometer: {
                    samplingRate: 50 // Samples per second
                }
            }, (sensorData) => {
                // Process accelerometer data to estimate roughness (simplified example)
                const accelerationX = sensorData.accelerometer.data[0];
                const accelerationY = sensorData.accelerometer.data[1];

                // Roughness estimation:  Higher acceleration values -> higher roughness
                currentRoughness = Math.abs(accelerationX) + Math.abs(accelerationY); //Simple sum of absolute values

                roughnessData.push({ latitude, longitude, roughness: currentRoughness, timestamp: Date.now() });
                updateRoughnessDisplay(currentRoughness);
                updateMap();  // Update the map with new location and roughness
            }, (error) => {
                console.error('Accelerometer data retrieval error:', error);
            });

        },
        (error) => {
            console.error('Geolocation error:', error);
            statusDisplay.textContent = 'Geolocation Error';
        }
    );
}


function stopRecording() {
    recording = false;
    statusDisplay.textContent = 'Recording Stopped';

    // Process the recorded data (e.g., save to database)
    processData(roughnessData);
}



// --- Data Processing & Storage ---
function processData(data) {
  // In a real application, you'd send this data to your backend API
  console.log('Recorded Data:', data);

  // Example: Display report in the UI (simplified)
    const reportList = document.getElementById('reportList');
    data.forEach(item => {
        const listItem = document.createElement('li');
        listItem.textContent = `Timestamp: ${new Date(item.timestamp)}, Lat: ${item.latitude}, Lon: ${item.longitude}, Roughness: ${item.roughness}`;
        reportList.appendChild(listItem);
    });

}


// --- Initialization ---
initMap(); // Initialize the map when the page loads
