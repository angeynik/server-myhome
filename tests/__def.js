

const handleShutdown = async () => {
  console.log('Shutting down server...');

  try {
    // Закрываем все пулы соединений с базами данных
    await DBManager.closeAllPools();
    console.log('✅ Все соединения с базами данных закрыты.');

    // Закрытие WebSocket-соединений через WSSNodeRED
    await new Promise((resolve, reject) => {
      if (!WSSNodeRED || typeof WSSNodeRED.close !== 'function') {
        console.error('❌ Ошибка: Передан невалидный объект WebSocket-сервера');
        return reject(new Error('Передан невалидный объект WebSocket-сервера'));
      }
      WSSNodeRED.close((err) => {
        if (err) {
          console.error(`🛑 Ошибка закрытия WebSocket-сервера: ${err.message}`);
          return reject(err);
        }
        console.log('✅ WebSocket-сервер успешно остановлен');
        resolve();
      });
    });

    console.log('Все WebSocket-соединения закрыты.');

    // Закрытие HTTP-сервера, если он все еще запущен
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            console.error('Ошибка при закрытии HTTP-сервера:', err);
            return reject(err);
          }
          //console.log('HTTP-сервер успешно остановлен.');
          resolve();
        });
      });
    } else {
      console.log('HTTP-сервер уже не запущен.');
    }

    //console.log('Сервер остановлен. Задержка 2 секунды перед завершением процесса...');
    setTimeout(() => process.exit(0), 2000);
  } catch (error) {
    console.error('Ошибка при завершении работы сервера:', error);
    process.exit(1);
  }
};
















  // server.listen(servPORT, () => {
  //   console.log(`MyHome Server is running on port ${servPORT}`);
  // });

  // const handleShutdown = async () => {
  //   console.log('Shutting down server...');
  //   try {
  //     // Закрываем все пулы соединений с базами данных
  //     await DBManager.closeAllPools();
  //     console.log('✅ Все соединения с базами данных закрыты.');

  //   // Закрываем все активные WebSocket-соединения
  //   console.log('Closing all WebSocket connections...');
  //   // WSSNodeRED.close((error) => {
  //   //       if (error) {
  //   //       console.error('Произошла ошибка при закрытии WSSNodeRED:', error.message);
  //   //       return;
  //   //       }
  //   //       console.log('✅ Сервер WSSNodeRED успешно закрыт');
  //   //         console.log('Состояние сервера:');
  //   //         console.log('Address:', WSSNodeRED.address()); // Вернет `null`
  //   //         console.log('Pending connections:', WSSNodeRED._pendingConnections); // 0
  //   //   });
  //   // WSSNodeRED_OUT.close((error) => {
  //   //       if (error) {
  //   //       console.error('Произошла ошибка при закрытии WSSNodeRED_OUT:', error.message);
  //   //       return;
  //   //       }
  //   //       console.log('✅ Сервер WSSNodeRED_OUT успешно закрыт');
  //   //   });
  //   // WSSDash.close((error) => {
  //   //       if (error) {
  //   //       console.error('Произошла ошибка при закрытии WSSDash:', error.message);
  //   //       return;
  //   //       }
  //   //       console.log('✅ Сервер WSSDash успешно закрыт');
  //   //   });
   
  //   const shutdownServer = (serverInstance) => {
  // // Проверка на валидный экземпляр сервера
  // if (!serverInstance || typeof serverInstance.close !== 'function') {
  //   console.error('❌ Ошибка: Передан невалидный объект сервера');
  //   return false;
  // }

  // // Проверка состояния сервера через внутренние свойства
  // const isAlreadyClosed = 
  //   serverInstance._server === null || 
  //   serverInstance._server === undefined;
    
  // if (isAlreadyClosed) {
  //   console.log('ℹ️ Сервер уже закрыт');
  //   return true;
  // }

  // // Закрытие сервера с обработкой результата
  // serverInstance.close((err) => {
  //   if (err) {
  //     console.error(`🛑 Ошибка закрытия сервера: ${err.message}`);
  //     return false;
  //   }
    
  //   console.log('✅ Сервер успешно остановлен');
  //   console.log('Проверочные параметры:');
  //   console.log('Server address:', serverInstance.address()); // Должен быть null
  //   console.log('Server connections:', serverInstance.clients?.size); // Должно быть 0
    
  //   return true;
  // });
  //   };

  //   shutdownServer(WSSNodeRED);
  //   // shutdownServer(WSSNodeRED_OUT);
  //   // shutdownServer(WSSDash);


  //   console.log('Все WebSocket-соединения закрыты.');

  //     // server.close(() => {
  //     //   console.log('Server has been shut down.');
  //     //   process.exit(0); // Завершаем процесс после закрытия сервера
  //     // });
  //     server.close((err) => {
  //       if (err) {
  //         console.error('Ошибка при закрытии сервера:', err);
  //         process.exit(1); // Завершаем процесс с кодом ошибки
  //       } else {
  //         console.log('Сервер успешно остановлен. Задержка 2 секунды перед завершением процесса...');
  //         setTimeout(() => {
  //           process.exit(0); // Завершаем процесс после задержки в 2 секунды
  //         }, 2000);
  //       }
  //     });


    
  //   } catch (error) {
  //     console.error('Ошибка при завершении работы сервера:', error);
  //     process.exit(1); // Завершаем процесс с кодом ошибки
  //   }
  // };

fsfdvbsfb



let isShuttingDown = false; 
let forceShutdownTimer;
  const handleShutdown = async () => {
    console.log('Shutting down server...');
    try {
      // Закрываем все пулы соединений с базами данных
      await DBManager.closeAllPools();
      console.log('Все соединения с базами данных закрыты.');
      server.close(() => {
        console.log('Server has been shut down.');
        setTimeout(() => {
          console.log('Все соединения с базами данных закрыты.');
          process.exit(0); // Завершаем процесс после задержки в 2 секунды
        }, 2000);
      });
    } catch (error) {
      console.error('Ошибка при завершении работы сервера:', error);
      process.exit(1); // Завершаем процесс с кодом ошибки
    }
  };
// const handleShutdown = () => {
//   console.log('\n🛑 Получен сигнал завершения. Начинаю остановку сервера...');
  
//   server.close((err) => {
//     if (err) {
//       if (err.code === 'ERR_SERVER_NOT_RUNNING') {
//         console.log('ℹ️ Сервер уже был остановлен ранее');
//       } else {
//         console.error(`⛔ Критическая ошибка при остановке сервера: ${err.message}`);
//       }
//     } else {
//       console.log('✅ Сервер успешно остановлен');
//     }
    
//     // Добавляем визуальное разделение перед завершением
//     console.log('──────────────────────────────────────');
//     console.log('Процесс Node.js завершает работу...');
//     console.log('──────────────────────────────────────');
    
//     setTimeout(() => process.exit(err ? 1 : 0), 1000); // 1000ms задержка
//   });
// };
// const handleShutdown = async () => {
//   // Функция для безопасного вывода
//   const safeWrite = (message) => {
//     try {
//       process.stderr.write(message + '\n');
//     } catch (e) {
//       // Игнорируем ошибки вывода
//     }
//   };

//   safeWrite('\n🛑 Получен сигнал завершения. Начинаю остановку сервера...');

//   try {
//     // 1. Закрываем соединения с БД
//     await DBManager.closeAllPools();
//     safeWrite('✅ Все соединения с базами данных закрыты.');

//     // 2. Закрываем WebSocket серверы
//     const closeWebSocketServer = (server, name) => {
//       return new Promise((resolve) => {
//         if (!server || typeof server.close !== 'function') {
//           safeWrite(`ℹ️ ${name}: невалидный сервер или уже закрыт`);
//           return resolve();
//         }

//         server.close((err) => {
//           if (err) {
//             safeWrite(`🛑 ${name}: ошибка закрытия - ${err.message}`);
//           } else {
//             safeWrite(`✅ ${name}: успешно закрыт`);
//           }
//           resolve();
//         });
//       });
//     };

//     await closeWebSocketServer(WSSNodeRED, 'WSSNodeRED');
//     await closeWebSocketServer(WSSNodeRED_OUT, 'WSSNodeRED_OUT');
//     await closeWebSocketServer(WSSDash, 'WSSDash');
//     safeWrite('Все WebSocket-соединения закрыты.');

//     // 3. Закрываем Express сервер
//     if (!server.listening) {
//       safeWrite('ℹ️ Сервер Express не запущен или уже остановлен');
//     } else {
//       await new Promise((resolve) => {
//         server.close((err) => {
//           if (err) {
//             safeWrite(`⛔ Ошибка закрытия сервера: ${err.message}`);
//           } else {
//             safeWrite('✅ Сервер Express успешно остановлен');
//           }
//           resolve();
//         });
//       });
//     }

//   } catch (error) {
//     safeWrite(`⚠️ Критическая ошибка: ${error.message}`);
//   } finally {
//     // Гарантированное завершение процесса
//     setTimeout(() => process.exit(0), 100);
//   }
// };

// const handleShutdown = async () => {
//   if (isShuttingDown) {
//     safeWrite('ℹ️ Завершение уже начато, ожидайте...');
//     return;
//   }
  
//   isShuttingDown = true;
//   safeWrite('\n🛑 Получен сигнал завершения. Начинаю остановку сервера...');

//   try {
//     // 1. Закрываем соединения с БД
//     await DBManager.closeAllPools();
//     safeWrite('✅ Все соединения с базами данных закрыты.');

//     // 2. Закрываем WebSocket-серверы
//     const wsServers = [
//       { name: 'WSSNodeRED', instance: WSSNodeRED },
//       { name: 'WSSNodeRED_OUT', instance: WSSNodeRED_OUT },
//       { name: 'WSSDash', instance: WSSDash }
//     ];
    
//     await Promise.all(wsServers.map(server => 
//       new Promise(resolve => {
//         if (server.instance && typeof server.instance.close === 'function') {
//           server.instance.close(err => {
//             if (err) {
//               safeWrite(`🛑 ${server.name}: ошибка закрытия - ${err.message}`);
//             } else {
//               safeWrite(`✅ ${server.name}: успешно закрыт`);
//             }
//             resolve();
//           });
//         } else {
//           safeWrite(`ℹ️ ${server.name}: невалидный сервер или уже закрыт`);
//           resolve();
//         }
//       })
//     ));

//     safeWrite('✅ Все WebSocket-соединения закрыты.');

//     // 3. Закрываем Express сервер
//     if (server && server.listening) {
//       await new Promise(resolve => {
//         server.close(err => {
//           if (err) {
//             safeWrite(`⛔ Ошибка закрытия сервера: ${err.message}`);
//           } else {
//             safeWrite('✅ Сервер Express успешно остановлен');
//           }
//           resolve();
//         });
//       });
//     } else {
//       safeWrite('ℹ️ Сервер Express не запущен или уже остановлен');
//     }

//     // Очистка таймера принудительного завершения
//     clearTimeout(forceShutdownTimer);

//     safeWrite('🎯 Завершение выполнено успешно.');

//   } catch (error) {
//     safeWrite(`⚠️ Критическая ошибка: ${error.message}`);
//   } finally {
//     // Таймер принудительного завершения
//     forceShutdownTimer = setTimeout(() => {
//       safeWrite('⏱️ Принудительное завершение по таймауту');
//       process.exit(1);
//     }, 5000);
//   }
// };



// const handleShutdown = async () => {
//   if (isShuttingDown) {
//     safeWrite('ℹ️ Завершение уже начато, ожидайте...');
//     return;
//   }
  
//   isShuttingDown = true;
//   safeWrite('\n🛑 Получен сигнал завершения. Начинаю остановку сервера...');

//   try {
//     // 1. Закрываем соединения с БД
//     await DBManager.closeAllPools();
//     safeWrite('✅ Все соединения с базами данных закрыты.');

//     // 2. Закрываем WebSocket-серверы
//     const wsServers = [
//       { name: 'WSSNodeRED', instance: WSSNodeRED },
//       { name: 'WSSNodeRED_OUT', instance: WSSNodeRED_OUT },
//       { name: 'WSSDash', instance: WSSDash }
//     ];
    
//     await Promise.all(wsServers.map(server => 
//       new Promise(resolve => {
//         if (server.instance && typeof server.instance.close === 'function') {
//           server.instance.close(err => {
//             if (err) {
//               safeWrite(`🛑 ${server.name}: ошибка закрытия - ${err.message}`);
//             } else {
//               safeWrite(`✅ ${server.name}: успешно закрыт`);
//             }
//             resolve();
//           });
//         } else {
//           safeWrite(`ℹ️ ${server.name}: невалидный сервер или уже закрыт`);
//           resolve();
//         }
//       })
//     ));

//     safeWrite('✅ Все WebSocket-соединения закрыты.');

//     // 3. Закрываем Express сервер
//     if (server && server.listening) {
//       await new Promise(resolve => {
//         server.close(err => {
//           if (err) {
//             safeWrite(`⛔ Ошибка закрытия сервера: ${err.message}`);
//           } else {
//             safeWrite('✅ Сервер Express успешно остановлен');
//           }
//           resolve();
//         });
//       });
//     } else {
//       safeWrite('ℹ️ Сервер Express не запущен или уже остановлен');
//     }

//     // Очистка таймера принудительного завершения
//     clearTimeout(forceShutdownTimer);

//     safeWrite('🎯 Завершение выполнено успешно.');

//     // Завершение процесса, если все сервисы корректно закрыты
//     process.exit(0);

//   } catch (error) {
//     safeWrite(`⚠️ Критическая ошибка: ${error.message}`);
//   } finally {
//     // Таймер принудительного завершения (на случай зависания процессов)
//     forceShutdownTimer = setTimeout(() => {
//       safeWrite('⏱️ Принудительное завершение по таймауту');
//       process.exit(1);
//     }, 1000);
//   }
// };

// Функция безопасного вывода
const safeWrite = (message) => {
  try {
    process.stderr.write(message + '\n');
  } catch (e) {
    // Игнорируем ошибки вывода
  }
};

// Обработчики сигналов
process.on('SIGINT', () => handleShutdown());
process.on('SIGTERM', () => handleShutdown());