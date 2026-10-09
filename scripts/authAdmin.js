// serverApp/scripts/authAdmin.js
'use strict';

require('dotenv').config({ path: './conf.env' });

const path = require('path');
process.chdir(path.join(__dirname, '..')); // работаем из корня serverApp

const userStore = require('../services/userStore');

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'list': {
      const { users, datasources } = await userStore.loadUsers();
      console.log('Пользователи:');
      for (const u of users) {
        console.log(`  [${u.id}] ${u.username}  level=${u.permissionLevel}  dID=${u.dID}  mustChange=${!!u.mustChangePassword}`);
      }
      console.log('Источники данных:');
      for (const d of datasources) {
        console.log(`  [${d.id}] ${d.did} (${d.name || '—'})`);
      }
      break;
    }

    case 'setPassword': {
      const [username, newPassword] = args;
      if (!username || !newPassword) throw new Error('usage: setPassword <username> <newPassword>');
      const u = await userStore.setPassword(username, newPassword);
      console.log(`OK. Пароль для "${u.username}" обновлён.`);
      break;
    }

    case 'createUser': {
      const [username, password, level, dID, sourceName] = args;
      if (!username || !password || !level || !dID) {
        throw new Error('usage: createUser <username> <password> <level> <dID> [sourceName]');
      }
      const res = await userStore.registerUser(
        username, password, parseInt(level, 10), dID, sourceName || dID
      );
      console.log('OK. Создан пользователь:', res.user);
      break;
    }

    case 'bump': {
      const [username] = args;
      if (!username) throw new Error('usage: bump <username>');
      const v = await userStore.bumpTokenVersion(username);
      console.log(`OK. tokenVersion для "${username}" = ${v}. Все прежние JWT отозваны.`);
      break;
    }

    case 'setDID': {
      const [username, newDID, sourceName] = args;
      if (!username || !newDID) throw new Error('usage: setDID <username> <newDID> [sourceName]');
      const u = await userStore.changeUserDID(username, newDID, sourceName);
      console.log(`OK. Пользователь "${u.username}" теперь на dID="${u.dID}" (source="${u.dataSourceName}")`);
      console.log('Все прежние JWT этого пользователя отозваны (tokenVersion++).');
      break;
    }

    default:
      console.log([
        'Usage:',
        '  node scripts/authAdmin.js list',
        '  node scripts/authAdmin.js setPassword <username> <newPassword>',
        '  node scripts/authAdmin.js setDID <username> <newDID> [sourceName]',
        '  node scripts/authAdmin.js createUser <username> <password> <level> [dID] [sourceName]',
        '  node scripts/authAdmin.js bump <username>',
      ].join('\n'));
  }
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});