const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const servPORT = 3010;
const wsRedPORT = 9209;
// const wsDashPORT = 9202;

app.set(servPORT);
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

const WSSNodeRED = new WebSocket.Server ({port:wsRedPORT});

//const WSSDash = new WebSocket.Server ({port:wsDashPORT});

WSSNodeRED.on('connection', (ws) => {
    console.log('Client connected to NodeRED');
    const connectedClients = WSSNodeRED.clients.size;
    console.log(`Количество подключенных клиентов NodeRED: ${connectedClients}`);

        ws.on('message', (message) => {
        console.log('Received:', message);
        ws.send(`Echo: ${message}`);
    });
});



// wss.on('connection', (ws) => {
//   ws.on('message', (message) => {
//     console.log('Received:', message);
//     ws.send(`Echo: ${message}`);
//   });
// });

// server.on('upgrade', (request, socket, head) => {
//   wss.handleUpgrade(request, socket, head, (ws) => {
//     wss.emit('connection', ws, request);
//   });
// });

// app.get('/', (req, res) => {
//   res.sendFile(__dirname + '/index.html');
// });

// server.listen(3000, () => {
//   console.log('Server is listening on port 3000');
// });
