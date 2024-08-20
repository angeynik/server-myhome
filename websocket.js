const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ 
    port: process.env.WS_PORT || 9200, 
});

wss.on('connection', function connection(ws) {
    console.log('Connection from ' + req.socket.remoteAddress);
});



// wss.on('connection', function connection(ws) {
//     const ip = req.socket.remoteAddress;
//     console.log('Connection from ' + ip);

//     ws.on('error', console.error);
  
//     ws.on('message', function message(data, isBinary) {
//       wss.clients.forEach(function each(client) {
//         if (client !== ws && client.readyState === WebSocket.OPEN) {
//           client.send(data, { binary: isBinary });
//         }
//       });
//     });
//   });