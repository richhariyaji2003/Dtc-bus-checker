const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const protobuf = require('protobufjs');
const fs = require('fs');
const csv = require('csv-parse');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());
app.set('view engine', 'ejs');

// MongoDB Connection with Retry Logic
const uri = process.env.MONGODB_URI || 'mongodb+srv://ticketchecker:lq2MvkxmjWn8c8Ot@cluster0.daitar2.mongodb.net/busTrackerDB?retryWrites=true&w=majority';
const client = new MongoClient(uri);
let db;

async function connectDB() {
  let retries = 5;
  while (retries) {
    try {
      await client.connect();
      db = client.db('busTrackerDB');
      console.log('Successfully connected to MongoDB');
      break;
    } catch (err) {
      console.error('MongoDB connection error:', err.message);
      retries -= 1;
      if (retries === 0) {
        console.error('Max retries reached. Could not connect to MongoDB.');
        process.exit(1);
      }
      console.log(`Retrying connection (${5 - retries}/5)...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Load GTFS-realtime proto file
const protoFile = 'gtfs-realtime.proto';
const root = protobuf.loadSync(protoFile);
const FeedMessage = root.lookupType('transit_realtime.FeedMessage');

// GTFS API endpoint
const url = 'https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=7pnJf5w6MCh0JWrdisnafk0YhnKfUqxx';

let busData = [];
let busStops = [];
const clientZoomLevels = new Map();
const ZOOM_THRESHOLD = 14;

// Parse CSV data
const parseCSV = (csvString) => {
  return new Promise((resolve, reject) => {
    const stops = [];
    csv.parse(csvString, { columns: true, skip_empty_lines: true })
      .on('data', (row) => {
        stops.push({
          name: row.stop_name || 'Unknown Stop',
          latitude: parseFloat(row.stop_lat),
          longitude: parseFloat(row.stop_lon)
        });
      })
      .on('end', () => resolve(stops))
      .on('error', (err) => reject(err));
  });
};

// Read and parse CSV
const csvFilePath = 'data/stops.csv';
const csvString = fs.readFileSync(csvFilePath, 'utf8');
parseCSV(csvString)
  .then(stops => {
    busStops = stops;
    console.log(`Parsed ${busStops.length} bus stops from CSV`);
  })
  .catch(err => console.error('Error parsing CSV:', err));

// Fetch bus data with retry logic
const fetchBusData = async () => {
  let retries = 3;
  while (retries) {
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      const buffer = response.data;
      const message = FeedMessage.decode(new Uint8Array(buffer));
      const data = FeedMessage.toObject(message, { longs: String, enums: String, bytes: String });

      busData = data.entity
        .filter(entity => entity.vehicle && entity.vehicle.position)
        .map(entity => ({
          busNo: entity.vehicle.vehicle.id || 'Unknown',
          routeNo: entity.vehicle.trip?.routeId || 'Unknown',
          latitude: entity.vehicle.position.latitude,
          longitude: entity.vehicle.position.longitude,
        }));

      console.log(`Fetched ${busData.length} buses`);

      io.sockets.sockets.forEach((socket) => {
        const zoomLevel = clientZoomLevels.get(socket.id) || 0;
        const updateData = { buses: busData };
        if (zoomLevel >= ZOOM_THRESHOLD) updateData.busStops = busStops;
        socket.emit('busUpdate', updateData);
      });
      break;
    } catch (error) {
      console.error('Error fetching bus data:', error.message);
      retries -= 1;
      if (retries === 0) {
        console.error('Max retries reached for GTFS fetch.');
        break;
      }
      console.log(`Retrying GTFS fetch (${3 - retries}/3)...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

setInterval(fetchBusData, 1000);

// Serve webpage
app.get('/', (req, res) => {
  res.render('index', { buses: busData, busStops: [] });
});

// API to update bus check status
app.post('/api/checkBus', async (req, res) => {
  console.log('Received /api/checkBus request:', req.body);
  const { busNo, routeNo, nonTicketHolders, fineCollected } = req.body;

  if (!busNo || !routeNo || nonTicketHolders === undefined || fineCollected === undefined) {
    console.error('Invalid request body:', req.body);
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  if (!db) {
    console.error('Database not connected');
    return res.status(503).json({ success: false, error: 'Database not connected. Please try again later.' });
  }

  try {
    const result = await db.collection('busChecks').updateOne(
      { busNo, timestamp: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      { $set: { routeNo, checked: true, nonTicketHolders, fineCollected, timestamp: new Date() } },
      { upsert: true }
    );
    console.log('Bus check updated:', result);
    res.json({ success: true, result });
  } catch (err) {
    console.error('Error in /api/checkBus:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API to record bus attendance
app.post('/api/recordAttendance', async (req, res) => {
  console.log('Received /api/recordAttendance request:', req.body);
  const { busNo, conductorName } = req.body;

  if (!busNo || !conductorName) {
    console.error('Invalid request body:', req.body);
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  if (!db) {
    console.error('Database not connected');
    return res.status(503).json({ success: false, error: 'Database not connected. Please try again later.' });
  }

  try {
    const result = await db.collection('busAttendance').insertOne({
      busNo,
      conductorName,
      timestamp: new Date()
    });
    console.log('Attendance recorded:', result);
    res.json({ success: true, result });
  } catch (err) {
    console.error('Error in /api/recordAttendance:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Socket connections
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('zoomLevel', (zoom) => {
    clientZoomLevels.set(socket.id, zoom);
    const updateData = { buses: busData };
    if (zoom >= ZOOM_THRESHOLD) updateData.busStops = busStops;
    socket.emit('busUpdate', updateData);
  });
  socket.on('disconnect', () => {
    clientZoomLevels.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
async function startServer() {
  await connectDB();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    fetchBusData();
  });
}

startServer();