const express = require('express');
const http = require('http');
// const axios = require('axios');
// const { v4: uuidv4 } = require('uuid');
// const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');

const pino = require('pino'); // Подключаем pino для логирования
const logDirectory = process.env.LOG_DIRECTORY || './logs';
const log_level = process.env.PINO_LOG_LEVEL || 'info';

// Логирование Сервера
const ServerTransport = pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'fatal.log'), // Логи уровня fatal
        level: 'fatal',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'error.log'), // Логи уровня error
        level: 'error',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'warn.log'), // Логи уровня warn
        level: 'warn',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'info.log'), // Логи уровня info
        level: 'info',
        mkdir: true,
        colorize: false,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'debug.log'), // Логи уровня debug
        level: 'debug',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty', // Консольный вывод
      options: {
        level: 'debug',
        colorize: true,
        destination: process.stdout.fd,
      },
    },
    
  ],
});

const Slogger = pino({ level: log_level }, ServerTransport);
module.exports = Slogger;

// Логирование Клиента
const ClientTransport = pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'client_fatal.log'), // Логи уровня fatal
        level: 'fatal',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'client_error.log'), // Логи уровня error
        level: 'error',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'client_warn.log'), // Логи уровня warn
        level: 'warn',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'client_info.log'), // Логи уровня info
        level: 'info',
        mkdir: true,
        colorize: false,
      },
    },
   
  ],
});

const Clogger = pino({ level: log_level }, ClientTransport); 
module.exports = Clogger;

require('dotenv').config({ path: './conf.env' }); // Подключаем .ENV файл с переменными окружения

const servPORT = process.env.SERVER_PORT || 3010;
const wsRedPORT = process.env.WSR_PORT || 9200;
const wsDashPORT = process.env.WSD_PORT || 9202;

// Создаем директорию, если она не существует
const clientLogDir = './logs';
if (!fs.existsSync(clientLogDir)) {
    fs.mkdirSync(clientLogDir);
}

const app = express();
app.set(servPORT);
const server = http.createServer(app);
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());


//Работа с логами с Клиента
app.post('/log', (req, res) => {
    if (req.body.type === 'error') {
        Clogger.error(req.body.message);
    } else if (req.body.type === 'warn') {
        Clogger.warn(req.body.message);
    } else if (req.body.type === 'info') {
        Clogger.info(req.body.message);
    } else if (req.body.type === 'fatal') {
        Clogger.fatal(req.body.message);
    } else {
        Clogger.info('Получено сообщение неопределенного ТИПА с Логами от Клиента (VUE js):', req.body.message);
    }
});


//Запуск сервера
server.listen(servPORT, () => {
    console.log(`MyHome Server is running on port ${servPORT}`);
});


const WebSocket = require('ws');
const { mkdir } = require('fs');

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
  Slogger.info('Client connected to NodeRED');
  const connectedClients = WSSNodeRED.clients.size;
  Slogger.info(`Количество подключенных клиентов NodeRED: ${connectedClients}`);
  ws.on('message', (message) => {
      const data = message;
      Slogger.info(`На порт ${wsRedPORT} от NodRED получено сообщение: ${data},`);
      sendToDash = true;
      // Передача сообщения на WSSDash
      WSSDash.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && sendToDash === true) {
            client.send(data, (error) => {
                if (error) {
                    Slogger.error('Ошибка пересылки сообщения c NodeRED на Dashboard:', error);
                } else {
                    Slogger.info(`На порт ${wsDashPORT} от NodeRED к Dashboard отправлено сообщение: ${data}`);                   
                }
                this.sendToDash = false;
            });
        }
    });
  });

  ws.on('error', (error) => {
      Slogger.error('WebSocket error on NodeRED:', error);
  });

  ws.on('close', () => {
      Slogger.info('NodeRED WebSocket connection closed');
      redConnection = false;
  });
//}

});

// Работаем с Dashboard
WSSDash.on('connection', (ws) => {
  Slogger.info('Client connected to Dashboard');

  ws.on('message', (message) => {
      Slogger.info(`На порт ${wsDashPORT} от Dashboard получено сообщение: ${message} `);
      sendToRed = true;
      // Передача сообщения на WSSDash
      WSSDash.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && sendToRed === true) {
            client.send(message, (error) => {
                if (error) {
                    Slogger.error('Ошибка пересылки сообщения c Dashboard на NodeRED :', error);
                } else {
                    Slogger.info(`На порт ${wsRedPORT} от Dashboard к NodeREDотправлено сообщение: ${message}`);
                }
                sendToDash = false;
            });
        }
    });
  });

  ws.on('error', (error) => {
      Slogger.error('WebSocket error on Dashboard:', error);
  });

  ws.on('close', () => {
      Slogger.info('Dash WebSocket connection closed');
  });
});

Slogger.info(`WebSocket servers are running on ws://localhost:${wsRedPORT} and ws://localhost:${wsDashPORT}`);
//logger.debug(`WebSocket servers are running on ws://localhost:${wsRedPORT} and ws://localhost:${wsDashPORT}`);
setTimeout(() => {
    this.sendToDash = false;
}, this.reconnectInterval);
