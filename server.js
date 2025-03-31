const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const protobuf = require('protobufjs');
const xml2js = require('xml2js');
const fs = require('fs'); // Add this to read the file

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the 'public' folder
app.use(express.static('public'));

// Set EJS as the view engine
app.set('view engine', 'ejs');

// Load the GTFS-realtime proto file
const protoFile = 'gtfs-realtime.proto';
const root = protobuf.loadSync(protoFile);
const FeedMessage = root.lookupType('transit_realtime.FeedMessage');

// API endpoint
const url = 'https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=7pnJf5w6MCh0JWrdisnafk0YhnKfUqxx';

let busData = []; // Store the latest bus data
let busStops = []; // Store bus stop data from KML

// Function to parse KML data
const parseKML = (kmlString) => {
    return new Promise((resolve, reject) => {
        xml2js.parseString(kmlString, (err, result) => {
            if (err) return reject(err);

            const placemarks = result.kml.Document[0].Folder[0].Placemark;
            const stops = placemarks.map(placemark => {
                const coords = placemark.Point[0].coordinates[0].split(',').map(Number);
                const data = placemark.ExtendedData[0].SchemaData[0].SimpleData;
                const name = data.find(d => d.$.name === 'BS_NM_STND')?._;
                return {
                    name: name || 'Unknown Stop',
                    longitude: coords[0],
                    latitude: coords[1]
                };
            });
            resolve(stops);
        });
    });
};

// Read the KML file from the 'data' folder
const kmlFilePath = 'data/delhi_bus_stops.kml';
const kmlString = fs.readFileSync(kmlFilePath, 'utf8');

// Parse KML data once on server start
parseKML(kmlString).then(stops => {
    busStops = stops;
    console.log(`Parsed ${busStops.length} bus stops from KML`);
}).catch(err => {
    console.error('Error parsing KML:', err);
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

        // Emit the updated bus data and bus stops to all connected clients
        io.emit('busUpdate', { buses: busData, busStops });
    } catch (error) {
        console.error('Error fetching bus data:', error.message);
    }
};

// Fetch data every 1 second (1000ms)
setInterval(fetchBusData, 1000);

// Serve the webpage
app.get('/', (req, res) => {
    res.render('index', { buses: busData, busStops });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    fetchBusData(); // Initial fetch when server starts
});