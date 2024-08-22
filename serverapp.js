const express = require('express');
const http = require('http');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const morgan = require('morgan');
const cors = require('cors');
//const path = require('path');
const WebSocket = require('ws');

require('dotenv').config({ path: './conf.env' });

const servPORT = process.env.SERVER_PORT || 3010;
const wsRedPORT = process.env.WSR_PORT || 9200;
const wsDashPORT = process.env.WSD_PORT || 9202;

const app = express();
app.set(servPORT);
const server = http.createServer(app);

server.listen(servPORT, () => {
    console.log(`MyHome Server is running on port ${servPORT}`);
});

//устанавливаем соединение через Web Socket
const WSSNodeRED = new WebSocket.Server ({port:wsRedPORT});
const WSSDash = new WebSocket.Server ({port:wsDashPORT});

// Работаем с NodeRED
WSSNodeRED.on('connection', ws => {
    // проверяем соединение (контроль сообщения)
        ws.on('message', message => {
                try {
                    console.log(`На порт ${wsRedPORT} от NodRED получено сообщение: ${message} `);
                    ws.send(JSON.stringify({ message }));
                } catch (err) {
                    console.error(err);
                }
                ws.send ('Сообщение получено'); 
            });
});



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
WSSNodeRED.on ('connection', ws => {
  // проверяем соединение (контроль сообщения)
      ws.on('message', message => {
              try {
                  console.log(`На порт ${wsRedPORT} от NodRED получено сообщение: ${message} `);
                  ws.send(JSON.stringify({ message }));
              } catch (err) {
                  console.error(err);
              }
              ws.send ('Сообщение получено'); 
          });
});
WSSNodeRED.onmessage = (message) => {
    console.log(message.data);
};

WSSDash.on ('connection', ws => {
  // проверяем соединение (контроль сообщения)
      ws.on('message', message => {
              try {
                  console.log(`На порт ${wsDashPORT} от Dashboard получено сообщение: ${message} `);
                  ws.send(JSON.stringify({ message }));
              } catch (err) {
                  console.error(err);
              }
              ws.send ('Сообщение получено'); 
          });
});