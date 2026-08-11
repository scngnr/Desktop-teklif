const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { app, shell } = require('electron');
const { LICENSE_BASE, getMacAddress, getLicenseBase } = require('./licenseService');
const config = require('./config');

const BOOT_MODULE = 'AutoStartOnDesktopOpen';
const FALLBACK_BOOT_MODULE = 'AutoStartOnExcelOpen';
const QUEUE_AFTER = new Set(['HeartbeatPing', 'InstallTeklifAgent']);

let bootStarted = false;
let queueTimer = null;

function agentDir() {
  return path.join(app.getPath('userData'), 'TeklifAgent');
}

function autoStartStatePath() {
  return path.join(agentDir(), 'auto-start.json');
}

function bootFlagPath() {
  return path.join(agentDir(), 'boot-chain.done');
}

function ensureAgentDir() {
  fs.mkdirSync(agentDir(), { recursive: true });
}

function readAutoStartState() {
  try {
    ensureAgentDir();
    if (!fs.existsSync(autoStartStatePath())) return {};
    return JSON.parse(fs.readFileSync(autoStartStatePath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeAutoStartState(state) {
  ensureAgentDir();
  fs.writeFileSync(autoStartStatePath(), JSON.stringify(state, null, 2), 'utf8');
}

function getApiBaseUrl() {
  try {
    const fromConfig = String(
      (config.get() && config.get().apiBaseUrl) || ''
    ).trim();
    let base = fromConfig || getLicenseBase() || LICENSE_BASE;
    while (base.endsWith('/')) base = base.slice(0, -1);
    return `${base}/`;
  } catch {
    return `${LICENSE_BASE}/`;
  }
}

function getBootSessionId() {
  return `${os.hostname()}|${Math.floor(Date.now() / 86400000)}|${process.pid}`;
}

function isBootAutoStartDone() {
  try {
    if (!fs.existsSync(bootFlagPath())) return false;
    const saved = String(fs.readFileSync(bootFlagPath(), 'utf8') || '').trim();
    // Aynı takvim günü içinde bir kez (Excel VBA boot zincirine benzer)
    const dayKey = new Date().toISOString().slice(0, 10);
    return saved === dayKey || saved === getBootSessionId();
  } catch {
    return false;
  }
}

function markBootAutoStartDone() {
  ensureAgentDir();
  const dayKey = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(bootFlagPath(), dayKey, 'utf8');
}

function isAutoStartRunOnceDone(methodName) {
  const key = `done_${String(methodName || '').trim().toLowerCase()}`;
  const state = readAutoStartState();
  return String(state[key] || '').toLowerCase() === 'true';
}

function markAutoStartRunOnceDone(methodName) {
  const key = String(methodName || '').trim().toLowerCase();
  const state = readAutoStartState();
  state[`done_${key}`] = 'true';
  state[`doneAt_${key}`] = new Date().toISOString();
  writeAutoStartState(state);
}

function clearAutoStartRunOnce(methodName) {
  const key = String(methodName || '').trim().toLowerCase();
  const state = readAutoStartState();
  delete state[`done_${key}`];
  delete state[`doneAt_${key}`];
  writeAutoStartState(state);
}

function shouldRunAutoStartModule(methodName, runOnce) {
  if (!runOnce) return true;
  return !isAutoStartRunOnceDone(methodName);
}

function extractCodeFromJson(jsonText) {
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && typeof parsed.code === 'string') return parsed.code;
  } catch {
    // legacy parse
  }
  const p1 = jsonText.indexOf('"code"');
  if (p1 < 0) return jsonText;
  const colon = jsonText.indexOf(':', p1);
  const startQ = jsonText.indexOf('"', colon + 1);
  const endQ = jsonText.lastIndexOf('"');
  if (startQ < 0 || endQ <= startQ) return '';
  let temp = jsonText.slice(startQ + 1, endQ);
  temp = temp
    .replace(/\\"/g, '"')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
  return temp;
}

function extractJsonStringNearKey(jsonText, keyPos) {
  const colonPos = jsonText.indexOf(':', keyPos);
  if (colonPos < 0) return '';
  const startQ = jsonText.indexOf('"', colonPos);
  if (startQ < 0) return '';
  const endQ = jsonText.indexOf('"', startQ + 1);
  if (endQ < 0) return '';
  return jsonText.slice(startQ + 1, endQ);
}

function extractJsonBoolNear(jsonText, anchorPos, keyName) {
  const p = jsonText.indexOf(`"${keyName}"`, anchorPos);
  if (p < 0 || p > anchorPos + 400) return false;
  const slice = jsonText.slice(p, p + 24);
  return /true/i.test(slice);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildModuleContext(quiet) {
  return {
    app,
    shell,
    quiet: !!quiet,
    getMacAddress,
    getApiBaseUrl,
    getConfig: () => config.getPublic(),
    userDataPath: app.getPath('userData'),
    agentDir: agentDir(),
    runRemoteCode: (methodName, extraParam) =>
      runRemoteCode(methodName, extraParam, false),
    runRemoteCodeQuiet: (methodName, extraParam) =>
      runRemoteCode(methodName, extraParam, true),
    runAutoStartModule: (methodName, runOnce) =>
      runAutoStartModule(methodName, !!runOnce),
    executeFirmAutoStartList: (jsonText) => executeFirmAutoStartList(jsonText),
    markAutoStartRunOnceDone,
    clearAutoStartRunOnce,
    isAutoStartRunOnceDone,
    log: (...args) => console.log('[remoteModule]', ...args),
  };
}

async function executeDynamicFunction(codeContent, param, quiet) {
  const code = String(codeContent || '');
  if (
    /^\s*(Option\s+Explicit|Public\s+Sub|Private\s+Sub|Public\s+Function|Private\s+Function|Sub\s+\w+)/im.test(
      code
    )
  ) {
    throw new Error(
      'Sunucu VBA kodu döndürdü. Desktop uygulama için JavaScript DynamicFunc modülü gerekli.'
    );
  }

  const context = buildModuleContext(quiet);
  const sandbox = {
    console,
    require,
    module: { exports: {} },
    exports: {},
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch,
    URL,
    URLSearchParams,
    context,
    param: param === undefined ? '' : param,
    DynamicFunc: undefined,
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  const wrapped = `
    "use strict";
    ${codeContent}
    ;(async () => {
      if (typeof DynamicFunc === "function") {
        return await DynamicFunc(context, param);
      }
      const exp = module.exports;
      if (typeof exp === "function") {
        return await exp(context, param);
      }
      if (exp && typeof exp.DynamicFunc === "function") {
        return await exp.DynamicFunc(context, param);
      }
      if (exp && typeof exp.default === "function") {
        return await exp.default(context, param);
      }
      return null;
    })();
  `;

  const script = new vm.Script(wrapped, { filename: 'RemoteModule.js' });
  const result = script.runInNewContext(sandbox, {
    timeout: 120000,
    displayErrors: true,
  });
  return await result;
}

async function fetchRemoteModuleCode(methodName) {
  const apiUrl = `${getApiBaseUrl()}module/`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Client': 'desktop-teklif',
    },
    body: JSON.stringify({
      methodName,
      client: 'desktop-teklif',
      platform: process.platform,
    }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`Sunucu hatası ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const code = extractCodeFromJson(text);
  if (!code || !String(code).trim()) {
    throw new Error('Sunucudan kod içeriği boş.');
  }
  return { code, raw: text, apiUrl };
}

async function runRemoteCode(methodName, extraParam, quiet = false) {
  const name = String(methodName || '').trim();
  if (!name) throw new Error('methodName boş.');

  console.log(`[remoteModule] RunRemoteCode başladı: ${name}`);
  const dynParam =
    extraParam === undefined || extraParam === null || extraParam === ''
      ? quiet
        ? ''
        : getApiBaseUrl()
      : extraParam;

  try {
    const { code, apiUrl } = await fetchRemoteModuleCode(name);
    console.log(
      `[remoteModule] Kod alındı (${code.length} karakter) — ${apiUrl}`
    );
    const result = await executeDynamicFunction(code, dynParam, quiet);

    if (QUEUE_AFTER.has(name)) {
      if (queueTimer) clearTimeout(queueTimer);
      queueTimer = setTimeout(() => {
        runRemoteCode('InstallCommandQueue', undefined, true).catch((err) => {
          console.log(
            '[remoteModule] InstallCommandQueue hata:',
            err.message || err
          );
        });
      }, 3000);
    }

    console.log(`[remoteModule] RunRemoteCode tamamlandı: ${name}`);
    return { ok: true, methodName: name, result };
  } catch (err) {
    console.log(
      `[remoteModule] RunRemoteCode hata (${name}):`,
      err.message || err
    );
    if (quiet) throw err;
    return { ok: false, methodName: name, error: err.message || String(err) };
  }
}

async function runRemoteCodeQuiet(methodName, extraParam) {
  return runRemoteCode(methodName, extraParam, true);
}

async function runAutoStartModule(methodName, runOnce) {
  const name = String(methodName || '').trim();
  if (!name) return { ok: false, skipped: true, reason: 'empty' };
  if (name.toLowerCase() === 'getlicense') {
    return { ok: false, skipped: true, reason: 'getLicense' };
  }
  if (!shouldRunAutoStartModule(name, runOnce)) {
    console.log(`[remoteModule] RunOnce atlandı: ${name}`);
    return { ok: true, skipped: true, reason: 'runOnce' };
  }

  try {
    await runRemoteCodeQuiet(name);
    if (runOnce) markAutoStartRunOnceDone(name);
    return { ok: true, methodName: name };
  } catch (err) {
    console.log(
      `[remoteModule] RunRemoteCodeQuiet hata, normal deneniyor: ${name}`,
      err.message || err
    );
    const fallback = await runRemoteCode(name, undefined, false);
    if (fallback.ok && runOnce) markAutoStartRunOnceDone(name);
    return fallback;
  }
}

async function executeFirmAutoStartList(jsonText) {
  const text = String(jsonText || '');
  if (!text || /"modules"\s*:\s*\[\s*\]/i.test(text)) {
    return { ok: true, ran: [] };
  }

  const ran = [];
  let searchFrom = 0;
  while (true) {
    const pos = text.indexOf('"methodName"', searchFrom);
    if (pos < 0) break;

    const methodName = extractJsonStringNearKey(text, pos);
    if (!methodName) break;

    let delaySeconds = 0;
    const delayPos = text.indexOf('"delaySeconds"', pos);
    if (delayPos > 0 && delayPos < pos + 400) {
      delaySeconds = Number.parseInt(text.slice(delayPos + 14, delayPos + 24), 10) || 0;
    }
    const runOnce = extractJsonBoolNear(text, pos, 'runOnce');

    if (delaySeconds > 0) {
      await delay(delaySeconds * 1000);
    }

    const result = await runAutoStartModule(methodName, runOnce);
    ran.push({ methodName, runOnce, result });
    searchFrom = pos + methodName.length + 10;
  }

  return { ok: true, ran };
}

async function runBootAutoStartIfNeeded() {
  if (bootStarted) return { ok: true, skipped: true, reason: 'in-flight' };
  if (isBootAutoStartDone()) {
    return { ok: true, skipped: true, reason: 'already-done' };
  }

  bootStarted = true;
  console.log('[remoteModule] Boot auto-start zinciri başlıyor...');

  try {
    try {
      await runRemoteCodeQuiet(BOOT_MODULE);
    } catch (err) {
      console.log(
        `[remoteModule] ${BOOT_MODULE} yok/hata, fallback deneniyor:`,
        err.message || err
      );
      await runRemoteCodeQuiet(FALLBACK_BOOT_MODULE);
    }
    markBootAutoStartDone();
    console.log('[remoteModule] Boot auto-start tamamlandı.');
    return { ok: true };
  } catch (err) {
    bootStarted = false;
    console.log('[remoteModule] Boot auto-start hata:', err.message || err);
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  getApiBaseUrl,
  runRemoteCode,
  runRemoteCodeQuiet,
  runAutoStartModule,
  executeFirmAutoStartList,
  runBootAutoStartIfNeeded,
  isAutoStartRunOnceDone,
  markAutoStartRunOnceDone,
  clearAutoStartRunOnce,
  shouldRunAutoStartModule,
  isBootAutoStartDone,
  markBootAutoStartDone,
  BOOT_MODULE,
  FALLBACK_BOOT_MODULE,
};
