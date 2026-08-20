'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ensureClaudeFolderTrusted } = loadTs('src/main/config.ts');

test('Claude folder trust can target a non-host home without losing existing state', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claude-trust-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, '.claude.json');
  fs.writeFileSync(configPath, JSON.stringify({ numStartups: 4, projects: { '/existing': { allowedTools: [] } } }));

  ensureClaudeFolderTrusted('/mnt/c/Users/carbo/.munder_7', home);

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.numStartups, 4);
  assert.deepEqual(config.projects['/existing'], { allowedTools: [] });
  assert.equal(config.projects['/mnt/c/Users/carbo/.munder_7'].hasTrustDialogAccepted, true);
});
