const express = require('express');
const http = require('http');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const morgan = require('morgan');
const cors = require('cors');
//const path = require('path');
const WebSocket = require('ws');

const servPORT = process.env.SERVER_PORT || 3010;
const wsPORT = process.env.WS_PORT || 9200;

const app = express();
app.set(servPORT);
const server = http.createServer(app);

server.listen(servPORT, () => {
    console.log(`MyHome Server is running on port ${servPORT}`);
});

//устанавливаем соединение через Web Socket
const WSServer = new WebSocket.Server ({port:wsPORT}); 
// WSServer.on ('connection', ws => {
//    ws.on ('message', message => {
//        console.log (`Message:  ${message}`); 
//    // Устанавливаем соединение
//    const data = JSON.parse(message);
//         if (data.type === 'requestUuid') {
//         const uuid = uuidv4();
//         ws.send(JSON.stringify({ uuid }));
//         console.log(`Отправлен UUID: ${uuid}`);
//         //ws.send ({uuid}); 
//         }
//    });
//    ws.send ('first mess'); 

// });
WSServer.on ('connection', ws => {
  // проверяем соединение (контроль сообщения)
      ws.on('message', message => {
              try {
                  console.log(`На порт ${wsPORT} от NodRED получено сообщение: ${message} `);
              } catch (err) {
                  console.error(err);
              }
          });
        });
