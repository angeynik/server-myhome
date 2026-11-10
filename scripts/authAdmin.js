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
        console.log(
          `  [${u.id}] ${u.username}  level=${u.permissionLevel}  dID=${u.dID}  ` +
          `disabled=${!!u.disabled}  mustChange=${!!u.mustChangePassword}  telegram=${u.telegram?.chatId ? 'yes' : 'no'}`
        );
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
    case 'deleteUser': {
      const [username] = args;
      if (!username) throw new Error('usage: deleteUser <username>');
      const res = await userStore.deleteUser(username);

      console.log(`OK. Пользователь "${res.username}" удалён (dID="${res.dID}").`);

      if (res.otherUsersOnSameDID > 0) {
        console.log(`  ℹ️ На dID="${res.dID}" осталось ещё пользователей: ${res.otherUsersOnSameDID} — источник данных не тронут.`);
      } else {
        console.log(`  ⚠️ На dID="${res.dID}" больше никого не осталось.`);
        console.log(`     Запись в datasources и файл configData/${res.dID}.json НЕ удалены — почистите вручную, если нужно.`);
      }
      break;
    }
        case 'deleteDataSource': {
      const [did] = args;
      if (!did) throw new Error('usage: deleteDataSource <dID>');
      try {
        const res = await userStore.deleteDataSource(did);
        console.log(`OK. Источник данных "${res.did}"${res.name ? ` (${res.name})` : ''} удалён.`);
        console.log(`  Файл configData/${res.did}.json НЕ удалён — удалите вручную, если не нужен.`);
      } catch (e) {
        if (e.code === 'DATASOURCE_IN_USE') {
          console.error(`Ошибка: ${e.message}`);
          console.error('Сначала переведите пользователей на другой dID (setDID) или удалите их (deleteUser).');
          process.exit(2);
        }
        throw e;
      }
      break;
    }

    case 'cleanDataSources': {
      const res = await userStore.cleanDataSources();
      if (res.removedCount === 0) {
        console.log(`Нечего чистить: источников ${res.keptCount}, все используются.`);
      } else {
        console.log(`OK. Удалено источников: ${res.removedCount} (осталось ${res.keptCount} из ${res.before}).`);
        for (const d of res.removed) {
          console.log(`  - ${d.did}${d.name ? ` (${d.name})` : ''}`);
        }
        console.log('  Файлы configData/<dID>.json НЕ тронуты — проверьте вручную:');
        for (const d of res.removed) {
          console.log(`    configData/${d.did}.json`);
        }
      }
      break;
    }

    case 'show': {
      const [username] = args;
      if (!username) throw new Error('usage: show <username>');
      const u = await userStore.findUser(username);
      if (!u) throw new Error('Пользователь не найден');
      console.log(JSON.stringify(userStore.toPublic(u), null, 2));
      break;
    }

    case 'setLevel': {
      const [username, level] = args;
      if (!username || !level) throw new Error('usage: setLevel <username> <1|2|3>');
      const { user } = await userStore.updateUser(username, { permissionLevel: level });
      console.log(`OK. "${user.username}": level=${user.permissionLevel}. Прежние JWT отозваны.`);
      break;
    }

    case 'disable':
    case 'enable': {
      const [username] = args;
      if (!username) throw new Error(`usage: ${cmd} <username>`);
      const { user } = await userStore.updateUser(username, { disabled: cmd === 'disable' });
      console.log(`OK. "${user.username}": disabled=${user.disabled}.`);
      break;
    }

    case 'setEmail': {
      const [username, email] = args;
      if (!username) throw new Error('usage: setEmail <username> [email]');
      const { user } = await userStore.updateUser(username, { email: email || null });
      console.log(`OK. "${user.username}": email=${user.email || '—'}.`);
      break;
    }

    case 'unlinkTelegram': {
      const [username] = args;
      if (!username) throw new Error('usage: unlinkTelegram <username>');
      const user = await userStore.clearTelegram(username);
      console.log(`OK. Telegram отвязан у "${user.username}".`);
      break;
    }

    default:
      console.log([
        'Usage:',
        '  node scripts/authAdmin.js list',
        '  node scripts/authAdmin.js show <username>',
        '  node scripts/authAdmin.js setPassword <username> <newPassword>',
        '  node scripts/authAdmin.js setDID <username> <newDID> [sourceName]',
        '  node scripts/authAdmin.js createUser <username> <password> <level> [dID] [sourceName]',
        '  node scripts/authAdmin.js bump <username>',
        '  node scripts/authAdmin.js setLevel <username> <1|2|3>',
        '  node scripts/authAdmin.js disable <username>',
        '  node scripts/authAdmin.js enable <username>',
        '  node scripts/authAdmin.js setEmail <username> [email]',
        '  node scripts/authAdmin.js unlinkTelegram <username>',
        '  node scripts/authAdmin.js deleteUser <username>',
        '  node scripts/authAdmin.js deleteDataSource <dID>',
        '  node scripts/authAdmin.js cleanDataSources',
      ].join('\n'));
  }
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});