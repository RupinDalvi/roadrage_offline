// Global variables for IndexedDB and ride state
let db;
let currentRideId = null;
let currentRideDataPoints = [];
let accelerometerBuffer = [];
let latestGpsPosition = null;
let watchId = null;
let motionListenerActive = false;
let dataCollectionInterval = null;

// Low‑pass state for HPF
const HPF_ALPHA = 0.8;
let lastLowPassZ = 0;

// Map variables
let map, currentLocationMarker, currentRidePath, historicalRoughnessLayer;
let mapInitialized = false;

// Chart.js variables
let vibrationChart, chartDataset = [];

// DOM Elements
let statusDiv, startButton, stopButton, dataPointsCounter;
let pastRidesList, rideDetailView, detailContent, closeDetailButton;

// Constants
const DB_NAME = 'BikeRoughnessDB';
const DB_VERSION = 2;
const DATA_COLLECTION_INTERVAL_MS = 3000;
const HISTORICAL_DISPLAY_RADIUS_M = 150;
const PROXIMITY_MATCH_RADIUS_M = 10;

// Color scale
const ROUGH_THRESHOLDS = [0,3,6,9,15,21,30];
const ROUGH_COLORS     = ['#ffffff','#dddddd','#bbbbbb','#999999','#777777','#555555','#333333','#000000'];

function promisifiedDbRequest(request) {
  return new Promise((res, rej) => {
    request.onsuccess = e => res(e.target.result);
    request.onerror   = e => rej(e.target.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
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
    req.onsuccess = e => { db = e.target.result; resolve(db); loadPastRides(); };
    req.onerror   = e => { console.error(e); statusDiv.textContent='DB error'; reject(e); };
  });
}

function initializeMap() {
  if (mapInitialized) return;
  map = L.map('map').setView([51.0447,-114.0719],13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{ attribution:'&copy; OSM' }).addTo(map);
  setTimeout(()=>map.invalidateSize(),200);
  historicalRoughnessLayer = L.layerGroup().addTo(map);
  currentRidePath        = L.polyline([], { weight:5 }).addTo(map);
  mapInitialized = true;
}

function initChart() {
  const ctx = document.getElementById('vibrationChart').getContext('2d');
  vibrationChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Road vibration',
        data: chartDataset,
        pointRadius: 4,
        borderWidth: 2,
        tension: 0.3
      }]
    },
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
              const idx = ctx[0].dataIndex;
              const dp  = chartDataset[idx].meta;
              return `Lat: ${dp.latitude.toFixed(5)}, Lon: ${dp.longitude.toFixed(5)}`;
            }
          }
        }
      },
      onHover: (evt,items) => {
        if (items.length) highlightPointOnMap(items[0].dataIndex);
      }
    }
  });
}

function calculateVariance(arr) {
  if (!arr.length) return 0;
  const μ = arr.reduce((s,v)=>s+v,0)/arr.length;
  return arr.reduce((s,v)=>s+(v-μ)**2,0)/arr.length;
}

function getGeoId(lat,lon,prec=4){ return `${lat.toFixed(prec)}_${lon.toFixed(prec)}`; }
function toRad(d){return d*Math.PI/180;}
function dist(lat1,lon1,lat2,lon2){
  const R=6371e3,φ1=toRad(lat1),φ2=toRad(lat2),
        dφ=toRad(lat2-lat1),dλ=toRad(lon2-lon1),
        a=Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function roughnessToColor(r){
  for(let i=0;i<ROUGH_THRESHOLDS.length;i++){
    if(r<=ROUGH_THRESHOLDS[i])return ROUGH_COLORS[i];
  }
  return ROUGH_COLORS[ROUGH_COLORS.length-1];
}

function gpsSuccess(pos){ latestGpsPosition = pos; }
function gpsError(err){
  const m={1:'Permission denied',2:'Unavailable',3:'Timed out'};
  statusDiv.textContent = m[err.code]||'GPS error';
  if(err.code===1) stopRide();
}

function handleMotion(evt){
  const z=evt.accelerationIncludingGravity?.z;
  if(typeof z==='number'){
    lastLowPassZ = HPF_ALPHA*lastLowPassZ + (1-HPF_ALPHA)*z;
    accelerometerBuffer.push(z - lastLowPassZ);
  }
}

async function processCombinedDataPoint(){
  if(!currentRideId||!latestGpsPosition){
    statusDiv.textContent='Waiting GPS…'; return;
  }
  const {latitude,longitude,altitude,accuracy} = latestGpsPosition.coords;
  const t = latestGpsPosition.timestamp;
  const rough = calculateVariance(accelerometerBuffer);
  accelerometerBuffer=[];

  const dp = { id:crypto.randomUUID(), rideId:currentRideId,
               timestamp:t, latitude,longitude,altitude,accuracy,
               roughnessValue:rough };

  currentRideDataPoints.push(dp);
  dataPointsCounter.textContent = `Data Points: ${currentRideDataPoints.length}`;
  await updateRoughnessMap(dp);
  updateMapDisplay(dp);

  // add to chart
  const point = { x:new Date(t), y:rough, meta:dp };
  chartDataset.push(point);
  vibrationChart.update();

  statusDiv.textContent=`Lat ${latitude.toFixed(4)}, Lon ${longitude.toFixed(4)}, Rough ${rough.toFixed(2)}`;
}

async function updateRoughnessMap(dp){
  const tx = db.transaction('RoughnessMap','readwrite'),
        store = tx.objectStore('RoughnessMap'),
        all = await promisifiedDbRequest(store.getAll());

  const match = all.find(pt=>dist(pt.latitude,pt.longitude,dp.latitude,dp.longitude)<=PROXIMITY_MATCH_RADIUS_M);
  if(match){
    const upd={ ...match, latitude:dp.latitude,longitude:dp.longitude,
                roughnessValue:dp.roughnessValue, lastUpdated:dp.timestamp };
    await promisifiedDbRequest(store.put(upd));
  } else {
    await promisifiedDbRequest(store.put({
      geoId:getGeoId(dp.latitude,dp.longitude),
      latitude:dp.latitude, longitude:dp.longitude,
      roughnessValue:dp.roughnessValue, lastUpdated:dp.timestamp
    }));
  }
  await tx.complete;
}

function updateMapDisplay(dp){
  const latlng=[dp.latitude,dp.longitude];
  if(!currentLocationMarker) currentLocationMarker=L.marker(latlng).addTo(map);
  else                         currentLocationMarker.setLatLng(latlng);
  map.setView(latlng,Math.max(map.getZoom(),15));

  const path = currentRidePath.getLatLngs();
  const col  = roughnessToColor(dp.roughnessValue);
  if(path.length){
    const prev = path[path.length-1];
    L.polyline([prev,latlng],{color:col,weight:5}).addTo(map);
  } else {
    L.polyline([latlng,latlng],{color:col,weight:5}).addTo(map);
  }
  currentRidePath.addLatLng(latlng);
  updateHistoricalRoughnessDisplay(dp.latitude,dp.longitude);
}

async function updateHistoricalRoughnessDisplay(lat,lon){
  historicalRoughnessLayer.clearLayers();
  const tx = db.transaction('RoughnessMap','readonly'),
        all = await promisifiedDbRequest(tx.objectStore('RoughnessMap').getAll());
  all.forEach(pt=>{
    if(dist(lat,lon,pt.latitude,pt.longitude)<=HISTORICAL_DISPLAY_RADIUS_M){
      L.circleMarker([pt.latitude,pt.longitude],{
        radius:4, fillColor:roughnessToColor(pt.roughnessValue),
        color:'#000',weight:1,opacity:0.7,fillOpacity:0.7
      }).bindPopup(
        `Roughness: ${pt.roughnessValue.toFixed(2)}<br>`+
        `Updated: ${new Date(pt.lastUpdated).toLocaleDateString()}`
      ).addTo(historicalRoughnessLayer);
    }
  });
  await tx.complete;
}

// highlight a chart‑hovered point on map
let highlightMarker = null;
function highlightPointOnMap(idx){
  const dp = chartDataset[idx].meta;
  if(highlightMarker) map.removeLayer(highlightMarker);
  highlightMarker = L.circleMarker([dp.latitude,dp.longitude],{
    radius:10, color:'#ff0000', weight:2, fill:false
  }).addTo(map);
  setTimeout(()=>{ map.removeLayer(highlightMarker); highlightMarker=null; }, 3000);
}

// --- Start / Stop Ride ---
async function startRide(){
  if(currentRideId) return;
  currentRideId = Date.now();
  currentRideDataPoints = [];
  accelerometerBuffer = [];
  latestGpsPosition = null;
  dataPointsCounter.textContent='Data Points: 0';
  statusDiv.textContent='Requesting permissions…';

  if(currentRidePath) map.removeLayer(currentRidePath);
  currentRidePath = L.polyline([], { weight:5 }).addTo(map);
  if(currentLocationMarker) map.removeLayer(currentLocationMarker);
  historicalRoughnessLayer.clearLayers();

  watchId = navigator.geolocation.watchPosition(gpsSuccess, gpsError,{
    enableHighAccuracy:true, timeout:10000, maximumAge:0
  });

  if(typeof DeviceMotionEvent?.requestPermission==='function'){
    try{
      const resp = await DeviceMotionEvent.requestPermission();
      if(resp==='granted'){
        window.addEventListener('devicemotion',handleMotion);
        motionListenerActive = true;
      } else statusDiv.textContent='Motion denied.';
    }catch(e){
      console.error(e); statusDiv.textContent='Motion error.';
    }
  } else {
    window.addEventListener('devicemotion',handleMotion);
    motionListenerActive = true;
  }

  dataCollectionInterval = setInterval(processCombinedDataPoint, DATA_COLLECTION_INTERVAL_MS);

  const tx = db.transaction('rides','readwrite');
  await promisifiedDbRequest(tx.objectStore('rides').add({
    rideId:currentRideId,startTime:currentRideId,
    endTime:null,duration:0,totalDataPoints:0,status:'active'
  }));
  await tx.complete;

  // clear chart
  chartDataset.length = 0;
  vibrationChart.data.datasets[0].data = chartDataset;
  vibrationChart.update();

  startButton.disabled = true;
  stopButton.disabled = false;
  statusDiv.textContent='Recording… waiting for GPS.';
}

async function stopRide(){
  if(!currentRideId) return;
  if(watchId!==null){ navigator.geolocation.clearWatch(watchId); watchId=null; }
  if(motionListenerActive){ window.removeEventListener('devicemotion',handleMotion); motionListenerActive=false; }
  if(dataCollectionInterval!==null){ clearInterval(dataCollectionInterval); dataCollectionInterval=null; }

  statusDiv.textContent='Saving ride…';
  try{
    const tx = db.transaction(['rides','rideDataPoints'],'readwrite'),
          ridesStore = tx.objectStore('rides'),
          dpStore    = tx.objectStore('rideDataPoints');
    for(const dp of currentRideDataPoints) await promisifiedDbRequest(dpStore.put(dp));
    const rr = await promisifiedDbRequest(ridesStore.get(currentRideId));
    const upd = { ...rr,
      endTime:Date.now(),
      duration:Math.floor((Date.now()-rr.startTime)/1000),
      totalDataPoints:currentRideDataPoints.length,
      status:'completed'
    };
    await promisifiedDbRequest(ridesStore.put(upd));
    await tx.complete;
    statusDiv.textContent='Ride saved!';
  }catch(e){
    console.error(e); statusDiv.textContent='Save error.';
  }

  currentRideId = null;
  currentRideDataPoints = [];
  accelerometerBuffer = [];
  latestGpsPosition = null;
  startButton.disabled=false;
  stopButton.disabled=true;
  dataPointsCounter.textContent='Data Points: 0';
  if(currentRidePath) currentRidePath.setLatLngs([]);
  if(currentLocationMarker) map.removeLayer(currentLocationMarker);
  historicalRoughnessLayer.clearLayers();
  loadPastRides();
}

// --- Past Rides UI ---
async function loadPastRides(){
  pastRidesList.innerHTML = '';
  if(!db) return;
  try{
    const all = await promisifiedDbRequest(db.transaction('rides','readonly').objectStore('rides').getAll());
    if(!all.length){
      pastRidesList.innerHTML='<li>No past rides.</li>';
      return;
    }
    all.sort((a,b)=>b.startTime - a.startTime).forEach(r=>{
      const li=document.createElement('li');
      const start=new Date(r.startTime).toLocaleString(),
            m=Math.floor(r.duration/60), s=r.duration%60;
      li.innerHTML=`<strong>Start:</strong> ${start}<br>` +
                   `<strong>Dur:</strong> ${m}m ${s}s<br>` +
                   `<strong>Pts:</strong> ${r.totalDataPoints}`;
      li.onclick=() => showRideDetails(r.rideId);
      pastRidesList.appendChild(li);
    });
  }catch(e){
    console.error(e); statusDiv.textContent='Load rides error.';
  }
}

async function showRideDetails(rideId){
  rideDetailView.classList.remove('hidden');
  detailContent.textContent='Loading…';
  try{
    const tx = db.transaction(['rides','rideDataPoints'],'readonly'),
          rr = await promisifiedDbRequest(tx.objectStore('rides').get(rideId)),
          dps = await promisifiedDbRequest(tx.objectStore('rideDataPoints').index('by_rideId').getAll(rideId));
    await tx.complete;
    if(!rr||!dps.length){
      detailContent.textContent='No data'; return;
    }

    // populate chart & map for playback
    chartDataset.length=0;
    dps.forEach(dp=>{
      chartDataset.push({ x:new Date(dp.timestamp), y:dp.roughnessValue, meta:dp });
    });
    vibrationChart.update();

    // clear live path & redraw historical segment
    if(currentRidePath) map.removeLayer(currentRidePath);
    currentRidePath = L.polyline([], { weight:5 }).addTo(map);
    dps.forEach(dp => updateMapDisplay(dp));

    // fill detail panel
    let txt=`Ride ID: ${rr.rideId}\nStart: ${new Date(rr.startTime).toLocaleString()}\n`+
            `End: ${new Date(rr.endTime).toLocaleDateString()} ${new Date(rr.endTime).toLocaleTimeString()}\n`+
            `Duration: ${Math.floor(rr.duration/60)}m ${rr.duration%60}s\nPoints: ${rr.totalDataPoints}\n\n—Data Points—\n`;
    dps.forEach(dp=>{
      txt+=`${new Date(dp.timestamp).toLocaleTimeString()} | `+
           `Lat ${dp.latitude.toFixed(5)}, Lon ${dp.longitude.toFixed(5)} | `+
           `Rough ${dp.roughnessValue.toFixed(3)}\n`;
    });
    detailContent.textContent = txt;
  }catch(e){
    console.error(e); detailContent.textContent='Error loading details.';
  }
}
function hideRideDetails(){
  rideDetailView.classList.add('hidden');
  detailContent.textContent='';
}

// --- Init on load ---
document.addEventListener('DOMContentLoaded', ()=>{
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
  openDb().then(initChart);
});
