const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

function getSampleFolderCandidates() {
  const cfg = config.get();
  const desktop = path.join(os.homedir(), 'Desktop');
  const workspaceRoot = path.join(__dirname, '..');
  const candidates = [
    path.join(desktop, cfg.sampleFolderName),
    path.join(workspaceRoot, cfg.sampleFolderName),
  ];

  // Paketlenmiş exe: resources/örnek klasör
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, cfg.sampleFolderName));
  }

  return candidates;
}

function resolveSampleFolder() {
  const cfg = config.get();
  for (const candidate of getSampleFolderCandidates()) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  throw new Error(
    `Örnek klasör bulunamadı: "${cfg.sampleFolderName}"\n` +
      getSampleFolderCandidates().join('\n')
  );
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function findTeklifSubfolder(teklifFolderPath) {
  const cfg = config.get();
  const preferred = path.join(teklifFolderPath, cfg.teklifSubfolder);
  if (fs.existsSync(preferred)) return preferred;

  const entries = fs.readdirSync(teklifFolderPath);
  const match = entries.find((name) => /^4-teklif$/i.test(name));
  if (match) return path.join(teklifFolderPath, match);

  throw new Error(`"4-Teklif" alt klasörü bulunamadı: ${teklifFolderPath}`);
}

function isYeniTeklifExcel(fileName) {
  const excelExts = ['.xlsx', '.xlsm', '.xlsb', '.xls'];
  const ext = path.extname(fileName).toLowerCase();
  if (!excelExts.includes(ext)) return false;
  const base = path.basename(fileName, path.extname(fileName));
  return /^Yeni Teklif V1\.21/i.test(base);
}

function renameTeklifExcels(teklifFolderPath, teklifName) {
  const cfg = config.get();
  const teklifSub = findTeklifSubfolder(teklifFolderPath);
  const renamed = [];

  for (const file of fs.readdirSync(teklifSub)) {
    const full = path.join(teklifSub, file);
    if (!fs.statSync(full).isFile()) continue;
    if (!isYeniTeklifExcel(file)) continue;

    const ext = path.extname(file);
    const dest = path.join(teklifSub, `${teklifName}${ext}`);
    if (fs.existsSync(dest)) {
      throw new Error(`Hedef excel zaten var: ${dest}`);
    }
    fs.renameSync(full, dest);
    renamed.push(dest);
  }

  if (renamed.length === 0) {
    throw new Error(
      `"${cfg.excelNamePrefix}" excel dosyası bulunamadı: ${teklifSub}`
    );
  }
  return renamed;
}

function sanitizeNamePart(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
}

/** Teklif no + isteğe bağlı müşteri adı → klasör/excel adı */
function buildFolderLabel(teklifName, customerName) {
  const base = sanitizeNamePart(teklifName);
  if (!base) throw new Error('Geçersiz teklif adı.');
  const customer = sanitizeNamePart(customerName);
  return customer ? `${base} ${customer}` : base;
}

function createTeklifFolder(teklifName, customerName) {
  const folderLabel = buildFolderLabel(teklifName, customerName);

  const sampleSource = resolveSampleFolder();
  const desktop = path.join(os.homedir(), 'Desktop');
  const destPath = path.join(desktop, folderLabel);

  if (fs.existsSync(destPath)) {
    throw new Error(`Hedef klasör zaten mevcut: ${destPath}`);
  }

  copyDirRecursive(sampleSource, destPath);
  const renamedExcels = renameTeklifExcels(destPath, folderLabel);

  return {
    destPath,
    sampleSource,
    renamedExcels,
    folderLabel,
  };
}

module.exports = {
  resolveSampleFolder,
  createTeklifFolder,
  buildFolderLabel,
  sanitizeNamePart,
  getSampleFolderCandidates,
};
