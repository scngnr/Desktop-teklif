const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_ITEMS = 20;

function historyPath() {
  return path.join(app.getPath('userData'), 'teklif-history.json');
}

function load() {
  try {
    const file = historyPath();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(items) {
  const file = historyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(items.slice(0, MAX_ITEMS), null, 2), 'utf8');
}

function add(entry) {
  const items = load().filter(
    (x) => !(x.teklifName === entry.teklifName && x.destPath === entry.destPath)
  );
  items.unshift({
    teklifName: entry.teklifName || '',
    proposalId: entry.proposalId || 0,
    destPath: entry.destPath || '',
    createdAt: entry.createdAt || new Date().toISOString(),
  });
  save(items);
  return items;
}

module.exports = { load, add, MAX_ITEMS };
