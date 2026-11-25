// services/version.js
// Версия сборки сервера: appVersion из package.json (номер выпуска, тег version_X_X_X_X)
// и короткий хеш коммита — им отличаются сборки между выпусками. Нет git — только номер.
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function readVersion() {
  try {
    return require(path.join(ROOT, 'package.json')).appVersion || 'неизвестна';
  } catch {
    return 'неизвестна';
  }
}

function readCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .toString().trim() || null;
  } catch {
    return null;
  }
}

const VERSION = readVersion();
const COMMIT = readCommit();
const LABEL = COMMIT ? `${VERSION} (сборка ${COMMIT})` : VERSION;

module.exports = { VERSION, COMMIT, LABEL };
