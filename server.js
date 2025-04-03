const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const protobuf = require('protobufjs');
const fs = require('fs');
const csv = require('csv-parse');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the 'public' folder
app.use(express.static('public'));
app.use(express.json()); // For parsing JSON requests

// Set EJS as the view engine
app.set('view engine', 'ejs');

// MongoDB Connection
const uri = process.env.MONGODB_URI || 'mongodb+srv://ticketchecker:checker_DTC@821@cluster0.daitar2.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const client = new MongoClient(uri);
let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('busTrackerDB');
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection error:', err);
  }
}

connectDB();

// Load the GTFS-realtime proto file
const protoFile = 'gtfs-realtime.proto';
const root = protobuf.loadSync(protoFile);
const FeedMessage = root.lookupType('transit_realtime.FeedMessage');

// API endpoint
const url = 'https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=7pnJf5w6MCh0JWrdisnafk0YhnKfUqxx';

let busData = []; // Store the latest bus data
let busStops = []; // Store bus stop data from CSV
const clientZoomLevels = new Map(); // Store zoom levels for each client
const ZOOM_THRESHOLD = 14; // Minimum zoom level to send bus stops

// Function to parse CSV data
const parseCSV = (csvString) => {
  return new Promise((resolve, reject) => {
    const stops = [];
    csv.parse(csvString, {
      columns: true,
      skip_empty_lines: true
    })
      .on('data', (row) => {
        stops.push({
          name: row.stop_name || 'Unknown Stop',
          latitude: parseFloat(row.stop_lat),
          longitude: parseFloat(row.stop_lon)
        });
      })
      .on('end', () => {
        resolve(stops);
      })
      .on('error', (err) => {
        reject(err);
      });
  });
};

// Read the CSV file from the 'data' folder
const csvFilePath = 'data/stops.csv';
const csvString = fs.readFileSync(csvFilePath, 'utf8');

// Parse CSV data once on server start
parseCSV(csvString)
  .then(stops => {
    busStops = stops;
    console.log(`Parsed ${busStops.length} bus stops from CSV`);
  })
  .catch(err => {
    console.error('Error parsing CSV:', err);
  });

// Fetch and parse vehicle position data
const fetchBusData = async () => {
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = response.data;
    const message = FeedMessage.decode(new Uint8Array(buffer));
    const data = FeedMessage.toObject(message, {
      longs: String,
      enums: String,
      bytes: String,
    });

    busData = data.entity
      .filter(entity => entity.vehicle && entity.vehicle.position)
      .map(entity => ({
        busNo: entity.vehicle.vehicle.id || 'Unknown',
        routeNo: entity.vehicle.trip?.routeId || 'Unknown',
        latitude: entity.vehicle.position.latitude,
        longitude: entity.vehicle.position.longitude,
      }));

    console.log(`Fetched ${busData.length} buses`);

    // Emit updated bus data to each connected client
    io.sockets.sockets.forEach((socket) => {
      const zoomLevel = clientZoomLevels.get(socket.id) || 0;
      const updateData = { buses: busData };
      if (zoomLevel >= ZOOM_THRESHOLD) {
        updateData.busStops = busStops;
      }
      socket.emit('busUpdate', updateData);
    });
  } catch (error) {
    console.error('Error fetching bus data:', error.message);
  }
};

// Fetch data every 1 second (1000ms)
setInterval(fetchBusData, 1000);

// Serve the webpage
app.get('/', (req, res) => {
  res.render('index', { buses: busData, busStops: [] }); // Send empty busStops initially
});

// API to update bus check status
app.post('/api/checkBus', async (req, res) => {
  const { busNo, routeNo, nonTicketHolders, fineCollected } = req.body;
  try {
    const result = await db.collection('busChecks').updateOne(
      { busNo, timestamp: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }, // Unique per day
      { $set: { routeNo, checked: true, nonTicketHolders, fineCollected, timestamp: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API to record bus attendance
app.post('/api/recordAttendance', async (req, res) => {
  const { busNo, conductorName } = req.body;
  try {
    const result = await db.collection('busAttendance').insertOne({
      busNo,
      conductorName,
      timestamp: new Date()
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Handle socket connections
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Handle zoom level updates from clients
  socket.on('zoomLevel', (zoom) => {
    clientZoomLevels.set(socket.id, zoom);
    // Immediately send data with appropriate busStops based on zoom
    const updateData = { buses: busData };
    if (zoom >= ZOOM_THRESHOLD) {
      updateData.busStops = busStops;
    }
    socket.emit('busUpdate', updateData);
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    clientZoomLevels.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  fetchBusData(); // Initial fetch when server starts
});