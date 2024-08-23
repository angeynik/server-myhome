const express = require('express');
const http = require('http');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const morgan = require('morgan');
const cors = require('cors');
//const path = require('path');


require('dotenv').config({ path: './conf.env' });

const servPORT = process.env.SERVER_PORT || 3010;
const wsRedPORT = process.env.WSR_PORT || 9200;
const wsDashPORT = process.env.WSD_PORT || 9202;

const app = express();
// app.set(servPORT);
// const server = http.createServer(app);

// server.listen(servPORT, () => {
//     console.log(`MyHome Server is running on port ${servPORT}`);
// });

const WebSocket = require('ws');

//устанавливаем соединение через Web Socket
const WSSNodeRED = new WebSocket.Server ({port:wsRedPORT});
const WSSDash = new WebSocket.Server ({port:wsDashPORT});

// Блок с переменными
let sendToDash = false;
let sendToRed = false;
const reconnectInterval = 100;
//let redConnection = false;
//let dashConnection = false;
let activeSocket = null; // Переменная для хранения активного подключения



// Работаем с NodeRED

WSSNodeRED.on('connection', (ws) => {

  console.log('Client connected to NodeRED');
  const connectedClients = WSSNodeRED.clients.size;
  console.log(`Количество подключенных клиентов NodeRED: ${connectedClients}`);
  // if (connectedClients > 1) {
  //   ws.close();
  // } else {
  //   activeSocket = ws; // Сохраняем активное подключение
  // }


  ws.on('message', (message) => {
      const data = message;
      console.log(`На порт ${wsRedPORT} от NodRED получено сообщение: ${message} `);
      sendToDash = true;
      // Передача сообщения на WSSDash
      WSSDash.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && sendToDash === true) {
            client.send(data, (error) => {
                if (error) {
                    console.error('Ошибка пересылки сообщения c NodeRED на Dashboard:', error);
                } else {
                    console.log(`На порт ${wsDashPORT} от NodeRED к Dashboard отправлено сообщение: ${data}`);                   
                }
                this.sendToDash = false;
            });
        }
    });
  });

  ws.on('error', (error) => {
      console.error('WebSocket error on NodeRED:', error);
  });

  ws.on('close', () => {
      console.log('NodeRED WebSocket connection closed');
      redConnection = false;
  });
//}

});



// Работаем с Dashboard
WSSDash.on('connection', (ws) => {
  console.log('Client connected to Dashboard');

  ws.on('message', (message) => {
      console.log(`На порт ${wsDashPORT} от Dashboard получено сообщение: ${message} `);
      sendToRed = true;
      // Передача сообщения на WSSDash
      WSSDash.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && sendToRed === true) {
            client.send(message, (error) => {
                if (error) {
                    console.error('Ошибка пересылки сообщения c Dashboard на NodeRED :', error);
                } else {
                    console.log(`На порт ${wsRedPORT} от Dashboard к NodeREDотправлено сообщение: ${message}`);
                }
                sendToDash = false;
            });
        }
    });
  });

  ws.on('error', (error) => {
      console.error('WebSocket error on Dashboard:', error);
  });

  ws.on('close', () => {
      console.log('Dash WebSocket connection closed');
  });
});







console.log(`WebSocket servers are running on ws://localhost:${wsRedPORT} and ws://localhost:${wsDashPORT}`);

setTimeout(() => {
    this.sendToDash = false;
}, this.reconnectInterval);


//   // проверяем соединение (контроль сообщения)
//       ws.on('message', message => {
//               try {
//                   console.log(`На порт ${wsDashPORT} от Dashboard получено сообщение: ${message} `);
//                   ws.send(JSON.stringify({ message }));
//               } catch (err) {
//                   console.error(err);
//               }
//               ws.send ('Сообщение получено'); 
//           });
// });