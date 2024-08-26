const express = require('express');
const http = require('http');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const morgan = require('morgan');
const cors = require('cors');
//const path = require('path');

const pino = require('pino');
const logDirectory = process.env.LOG_DIRECTORY || './pino_logs';
const transport = pino.transport({
  target: 'pino-pretty',
  options: { colorize: true }, // Настройки для pino-pretty
  debug: pino.transport({
    target: 'pino/file',
    options: { destination: `${logDirectory}/debug.log` },
  }),
  info: pino.transport({
    target: 'pino/file',
    options: { destination: `${logDirectory}/info.log` },
  }),
  warn: pino.transport({
    target: 'pino/file',
    options: { destination: `${logDirectory}/warn.log` },
  }),
  error: pino.transport({
    target: 'pino/file',
    options: { destination: `${logDirectory}/error.log` },
  }),
});

const logger = pino({ level: 'debug' }, transport);
module.exports = logger;

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

  //console.log('Client connected to NodeRED');
  logger.info('Client connected to NodeRED');
  const connectedClients = WSSNodeRED.clients.size;
  logger.info(`Количество подключенных клиентов NodeRED: ${connectedClients}`);
  // if (connectedClients > 1) {
  //   ws.close();
  // } else {
  //   activeSocket = ws; // Сохраняем активное подключение
  // }


  ws.on('message', (message) => {
      const data = message;
      logger.info(`На порт ${wsRedPORT} от NodRED получено сообщение: ${message} `);
      sendToDash = true;
      // Передача сообщения на WSSDash
      WSSDash.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && sendToDash === true) {
            client.send(data, (error) => {
                if (error) {
                    logger.error('Ошибка пересылки сообщения c NodeRED на Dashboard:', error);
                } else {
                    logger.info(`На порт ${wsDashPORT} от NodeRED к Dashboard отправлено сообщение: ${data}`);                   
                }
                this.sendToDash = false;
            });
        }
    });
  });

  ws.on('error', (error) => {
      logger.error('WebSocket error on NodeRED:', error);
  });

  ws.on('close', () => {
      logger.info('NodeRED WebSocket connection closed');
      redConnection = false;
  });
//}

});



// Работаем с Dashboard
WSSDash.on('connection', (ws) => {
  logger.info('Client connected to Dashboard');

  ws.on('message', (message) => {
      logger.info(`На порт ${wsDashPORT} от Dashboard получено сообщение: ${message} `);
      sendToRed = true;
      // Передача сообщения на WSSDash
      WSSDash.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && sendToRed === true) {
            client.send(message, (error) => {
                if (error) {
                    logger.error('Ошибка пересылки сообщения c Dashboard на NodeRED :', error);
                } else {
                    logger.info(`На порт ${wsRedPORT} от Dashboard к NodeREDотправлено сообщение: ${message}`);
                }
                sendToDash = false;
            });
        }
    });
  });

  ws.on('error', (error) => {
      logger.error('WebSocket error on Dashboard:', error);
  });

  ws.on('close', () => {
      logger.info('Dash WebSocket connection closed');
  });
});







logger.info(`WebSocket servers are running on ws://localhost:${wsRedPORT} and ws://localhost:${wsDashPORT}`);

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