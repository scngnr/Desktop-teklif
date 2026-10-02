const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { shell } = require('electron');
const config = require('./config');
const ord = require('./metalixOrd');

function apiRoot() {
  const cfg = config.get();
  return config.buildApiRoot(cfg.baseUrl, cfg.firmaAdi).replace(/\/$/, '');
}

function authHeaders(extra) {
  const cfg = config.get();
  return {
    [cfg.authHeaderName || 'authtoken']: cfg.authToken,
    Accept: 'application/json, application/zip, text/csv, */*',
    ...(extra || {}),
  };
}

async function requestRaw(url, options) {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: authHeaders(options.headers),
    body: options.body,
  });
  const body = Buffer.from(await res.arrayBuffer());
  const headers = {};
  res.headers.forEach((value, key) => {
    headers[String(key).toLowerCase()] = value;
  });
  return { status: res.status, headers, body, url };
}

function shouldFallback(result) {
  if (!result || result.status !== 404) return false;
  const text = result.body ? result.body.toString('utf8').trim() : '';
  if (text.startsWith('{') || text.startsWith('[')) return false;
  return true;
}

async function requestFirst(paths, options) {
  const root = apiRoot();
  let last = null;
  for (let i = 0; i < paths.length; i += 1) {
    const url = ord.joinApiUrl(root, paths[i]);
    last = await requestRaw(url, options);
    if (!shouldFallback(last)) return last;
  }
  return last;
}

async function fetchGroups(moId) {
  const paths = ord.ordEndpointPaths(moId);
  if (!paths.ok) return paths;
  const result = await requestFirst(paths.paths, { method: 'GET' });
  const interpreted = ord.interpretGroups(result.status, result.body);
  interpreted.url = result.url;
  return interpreted;
}

async function downloadOrd(payload) {
  const mo = ord.validateMoId(payload && payload.moId);
  if (!mo.ok) return mo;
  const dir = ord.validateDir(payload && payload.dir);
  if (!dir.ok) return dir;
  const group = ord.validateGroup(payload && payload.group);
  if (!group.ok) return group;

  const paths = ord.ordEndpointPaths(mo.moId);
  const wireDir = ord.apiDir(dir.dir);
  const query = ord.ordDownloadQuery(wireDir, group.group);
  const getPaths = paths.paths.map((p) => p + '?' + query);
  let result = await requestFirst(getPaths, { method: 'GET' });
  let interpreted = ord.interpretOrdDownload(result.status, result.headers, result.body);
  if (ord.ordDownloadNeedsPost(interpreted)) {
    result = await requestFirst(paths.paths, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ dir: wireDir, group: group.group }),
    });
    interpreted = ord.interpretOrdDownload(result.status, result.headers, result.body);
  } else if (interpreted.code === 'dxf_missing') {
    try {
      const posted = await requestFirst(paths.paths, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ dir: wireDir, group: group.group }),
      });
      const postInterpreted = ord.interpretOrdDownload(posted.status, posted.headers, posted.body);
      if (postInterpreted.ok) {
        result = posted;
        interpreted = postInterpreted;
      }
    } catch {
      // GET zaten DXF zip hatasını verdi; POST ağı keserse o mesaj kalsın.
    }
  }
  if (!interpreted.ok) {
    interpreted.url = result.url;
    return interpreted;
  }

  const dest = ord.localDest(dir.dir);
  let files = [];
  try {
    files = ord.extractZip(interpreted.zip, dest);
  } catch (err) {
    return {
      ok: false,
      code: err.code || 'zip_invalid',
      error: ord.explainMetalixCode(err.code) || err.message || 'Zip açılamadı.',
    };
  }

  const ords = files
    .filter((file) => /\.ord$/i.test(file))
    .map((file) => {
      const text = ord.decodeOrdText(fs.readFileSync(file));
      const inspected = ord.inspectOrdText(text, dir.dir);
      return {
        path: file,
        lineCount: inspected.lineCount,
        warnings: inspected.warnings,
      };
    });

  return {
    ok: true,
    moId: mo.moId,
    dir: dir.dir,
    dest,
    group: group.group,
    filename: interpreted.filename,
    ordFiles: interpreted.ordFiles,
    missing: interpreted.missing,
    ordDir: interpreted.ordDir,
    fileCount: files.length,
    ords,
    url: result.url,
  };
}

function validateOrdFile(ordPath) {
  const target = String(ordPath || '').trim();
  if (!target || target.includes('\0')) {
    return { ok: false, code: 'ord_invalid', error: ord.explainMetalixCode('ord_invalid') };
  }
  if (!/\.ord$/i.test(target)) {
    return { ok: false, code: 'ord_invalid', error: ord.explainMetalixCode('ord_invalid') };
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, code: 'ord_missing', error: ord.explainMetalixCode('ord_missing') };
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'ord_missing', error: ord.explainMetalixCode('ord_missing') };
  }
  return { ok: true, ordPath: target };
}

function runMetalixCom(env) {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ord.METALIX_PS],
      {
        env: { ...process.env, ...env },
        windowsHide: true,
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      resolve({ ok: false, error: err.message, stdout, stderr });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function openWithShell(ordPath) {
  const opened = await shell.openPath(ordPath);
  if (opened) return { ok: false, mode: 'shell', error: opened };
  return { ok: true, mode: 'shell' };
}

async function openOrd(payload) {
  const file = validateOrdFile(payload && payload.ordPath);
  if (!file.ok) return file;
  const startNest = !!(payload && payload.startNest);
  const sizes = ord.sheetSizeEnv({
    ordPath: file.ordPath,
    sheetX: payload && payload.sheetX,
    sheetY: payload && payload.sheetY,
    startNest,
  });

  if (startNest && !sizes.ok) return sizes;

  if (process.platform === 'win32' && sizes.ok) {
    const com = await runMetalixCom(sizes.env);
    if (com.ok) {
      const nestMatch = /NEST\s+(-?\d+)/.exec(com.stdout || '');
      const nestCode = nestMatch ? Number(nestMatch[1]) : null;
      let message = 'ORD Metalix AutoNest içine yüklendi.';
      if (startNest) {
        message =
          nestCode === 0
            ? 'Bütün parçalar yerleşti.'
            : 'Yerleşim bitti. Bazı parçalar yerleşmemiş olabilir.';
      }
      return { ok: true, mode: 'com', started: startNest, nestCode, message };
    }
    const fallback = await openWithShell(file.ordPath);
    return {
      ok: fallback.ok,
      mode: 'shell-fallback',
      error: (com.stderr || com.error || '').trim() || 'OptiMech açılamadı.',
      message: fallback.ok
        ? 'ORD dosyası ilişkili programla açıldı.'
        : 'ORD dosyası açılamadı.',
    };
  }

  const opened = await openWithShell(file.ordPath);
  if (!opened.ok) return opened;
  return {
    ok: true,
    mode: 'shell',
    message: startNest
      ? 'Yerleşim Windows üzerinde OptiMech.Document ile başlar. ORD dosyası açıldı.'
      : 'ORD dosyası açıldı.',
  };
}

async function submitNest(payload) {
  const paths = ord.nestEndpointPaths(payload && payload.moId);
  if (!paths.ok) return paths;
  const body = ord.nestJsonBody({
    filename: payload && payload.filename,
    profile: payload && payload.profile,
    csv: payload && payload.csv,
  });
  if (!body.ok) return body;
  const result = await requestFirst(paths.paths, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body.body),
  });
  const interpreted = ord.interpretNestPost(result.status, result.body);
  interpreted.url = result.url;
  return interpreted;
}

async function listReports(moId) {
  const paths = ord.nestEndpointPaths(moId);
  if (!paths.ok) return paths;
  const result = await requestFirst(paths.paths, { method: 'GET' });
  const interpreted = ord.interpretNestList(result.status, result.body);
  interpreted.url = result.url;
  return interpreted;
}

function readNestFile(filePath) {
  const target = String(filePath || '').trim();
  if (!target || target.includes('\0')) {
    return { ok: false, code: 'csv_required', error: ord.explainMetalixCode('csv_required') };
  }
  let buf;
  try {
    buf = fs.readFileSync(target);
  } catch (err) {
    return { ok: false, code: 'csv_required', error: err.message || 'CSV okunamadı.' };
  }
  const text = ord.decodeOrdText(buf);
  return ord.prepareNestCsv(path.basename(target), text);
}

let nestWatchStop = null;

function stopNestWatch() {
  if (nestWatchStop) {
    nestWatchStop();
    nestWatchStop = null;
  }
}

function watchForNestCsv(dir, onFile) {
  stopNestWatch();
  const root = ord.localDest(dir);
  let timer = null;
  let stopped = false;
  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (stopped || !filename || !/\.(csv|txt)$/i.test(String(filename))) return;
      const full = path.resolve(root, String(filename));
      const prefix = root.endsWith(path.sep) ? root : root + path.sep;
      if (full !== root && !full.startsWith(prefix)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (stopped) return;
        fs.stat(full, (err, stat) => {
          if (stopped || err || !stat.isFile() || stat.size < 1) return;
          onFile(full);
        });
      }, 700);
    });
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  const killer = setTimeout(() => stop(), 20 * 60 * 1000);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(killer);
    clearTimeout(timer);
    try {
      watcher.close();
    } catch {
      // kapanmış olabilir
    }
  }
  nestWatchStop = stop;
  return { ok: true };
}

module.exports = {
  fetchGroups,
  downloadOrd,
  openOrd,
  submitNest,
  listReports,
  readNestFile,
  watchForNestCsv,
  stopNestWatch,
};
