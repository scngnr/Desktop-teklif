const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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

function runMetalixScript(options) {
  return new Promise((resolve) => {
    const args = ord.nestScriptArgs(options);
    const child = spawn(
      'powershell.exe',
      args,
      {
        env: process.env,
        windowsHide: true,
      }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      finish({ ok: false, error: err.message, stdout, stderr });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function openOrd(payload) {
  const file = validateOrdFile(payload && payload.ordPath);
  if (!file.ok) return file;
  const cfg = config.get();
  const options = ord.nestScriptOptions({
    sheetX: (payload && payload.sheetX) || cfg.metalixSheetX,
    sheetY: (payload && payload.sheetY) || cfg.metalixSheetY,
    reportTemplate:
      (payload && payload.reportTemplate) || config.getMetalixReportTemplate(),
  });
  if (!options.ok) return options;

  if (process.platform !== 'win32') {
    return {
      ok: false,
      code: 'script_windows_only',
      error: ord.explainMetalixCode('script_windows_only'),
    };
  }

  const scriptPath = config.getMetalixScriptPath();
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      mode: 'script',
      code: 'script_missing',
      error: ord.explainMetalixCode('script_missing') + ' ' + scriptPath,
    };
  }
  if (!fs.existsSync(options.reportTemplate)) {
    return {
      ok: false,
      mode: 'script',
      code: 'report_template_required',
      error: ord.explainMetalixCode('report_template_required') + ' ' + options.reportTemplate,
    };
  }

  const outCsv = path.join(
    path.dirname(file.ordPath),
    path.basename(file.ordPath, path.extname(file.ordPath)) + '_Perfex.csv'
  );
  const executed = await runMetalixScript({
    scriptPath,
    ordPath: file.ordPath,
    template: options.reportTemplate,
    outCsv,
    sheetX: options.sheetX,
    sheetY: options.sheetY,
    sheetQty: options.sheetQty,
  });
  const parsed = ord.parseNestScriptResult(
    executed.code,
    executed.stdout,
    [executed.error, executed.stderr].filter(Boolean).join('\n')
  );
  if (!parsed.ok) {
    return {
      ...parsed,
      mode: 'script',
    };
  }
  const reportPath = parsed.csvPath;
  if (!reportPath || !fs.existsSync(reportPath)) {
    return {
      ok: false,
      mode: 'script',
      code: 'report_missing',
      error: ord.explainMetalixCode('report_missing') + ' ' + (reportPath || outCsv),
      stdout: parsed.stdout,
      stderr: parsed.stderr,
    };
  }
  return {
    ok: true,
    mode: 'script',
    started: true,
    reportPath,
    incomplete: parsed.incomplete,
    unplacedParts: parsed.unplacedParts,
    orderedParts: parsed.orderedParts,
    placedParts: parsed.placedParts,
    warning: parsed.warning,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    message: parsed.incomplete
      ? 'Metalix raporu üretildi; ' + parsed.warning
      : 'Metalix betiği Perfex raporunu üretti: ' + path.basename(reportPath),
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
  const inspected = ord.inspectPerfexNestCsv(body.body.csv);
  interpreted.parts = inspected.parts;
  interpreted.partCount = inspected.partCount;
  interpreted.partIds = inspected.partIds;
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
  const text = ord.decodeTextBuffer(buf);
  return ord.prepareNestCsv(path.basename(target), text);
}

function isPerfexNestFile(filePath, prepared) {
  const file = prepared || readNestFile(filePath);
  return !!(file && file.ok && ord.isPerfexNestCsv(file.filename, file.csv));
}

async function processOrdBatch(downloaded, payload, onProgress) {
  const source = downloaded && downloaded.ok ? downloaded : null;
  if (!source) return downloaded || { ok: false, error: 'ORD indirilemedi.' };
  const ords = Array.isArray(source.ords) ? source.ords : [];
  if (!ords.length) {
    return { ...source, ok: false, code: 'ord_missing', error: ord.explainMetalixCode('ord_missing') };
  }

  const results = [];
  for (let index = 0; index < ords.length; index += 1) {
    const item = ords[index];
    const opened = await openOrd({
      ordPath: item.path,
      sheetX: payload && payload.sheetX,
      sheetY: payload && payload.sheetY,
      reportTemplate: payload && payload.reportTemplate,
      startNest: true,
    });
    const current = { ordPath: item.path, opened };
    if (!opened.ok) {
      results.push(current);
      if (onProgress) onProgress({ ok: false, index, total: ords.length, ...current, error: opened.error });
      continue;
    }

    const file = readNestFile(opened.reportPath);
    current.file = file;
    if (!file.ok || !isPerfexNestFile(opened.reportPath, file)) {
      current.posted = {
        ok: false,
        code: file.code || 'parse_failed',
        error: file.error || 'Üretilen dosya Perfex CSV değil.',
      };
    } else {
      current.posted = await submitNest({
        moId: source.moId,
        filename: file.filename,
        profile: 'metalix_perfex',
        csv: file.csv,
      });
    }
    results.push(current);
    if (onProgress) {
      onProgress({
        ok: !!current.posted.ok,
        index,
        total: ords.length,
        ordPath: item.path,
        reportPath: opened.reportPath,
        message: opened.message,
        incomplete: opened.incomplete,
        unplacedParts: opened.unplacedParts || 0,
        orderedParts: opened.orderedParts,
        placedParts: opened.placedParts,
        warning: opened.warning || '',
        output: opened.stdout,
        report: current.posted.report || null,
        partCount: current.posted.partCount || 0,
        partIds: current.posted.partIds || [],
        error: current.posted.error,
      });
    }
  }

  const failed = results.filter((item) => !item.opened.ok || !item.posted || !item.posted.ok);
  const incomplete = results.filter((item) => item.opened && item.opened.incomplete);
  return {
    ...source,
    ok: failed.length === 0,
    processed: results.length,
    uploaded: results.length - failed.length,
    incomplete: incomplete.length > 0,
    unplacedParts: incomplete.reduce(
      (total, item) => total + Number(item.opened.unplacedParts || 0),
      0
    ),
    warnings: incomplete.map((item) => ({
      ordPath: item.ordPath,
      warning: item.opened.warning,
      unplacedParts: item.opened.unplacedParts,
      orderedParts: item.opened.orderedParts,
      placedParts: item.opened.placedParts,
    })),
    partCount: results.reduce(
      (total, item) => total + Number((item.posted && item.posted.partCount) || 0),
      0
    ),
    partIds: [
      ...new Set(
        results.flatMap((item) =>
          item.posted && Array.isArray(item.posted.partIds) ? item.posted.partIds : []
        )
      ),
    ],
    results,
    error: failed.length
      ? failed
          .map((item) => path.basename(item.ordPath) + ': ' + ((item.posted && item.posted.error) || item.opened.error))
          .join('\n')
      : '',
  };
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
  const timers = new Map();
  const seen = new Set();
  let stopped = false;
  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (stopped || !filename || !/\.csv$/i.test(String(filename))) return;
      const full = path.resolve(root, String(filename));
      const prefix = root.endsWith(path.sep) ? root : root + path.sep;
      if (full !== root && !full.startsWith(prefix)) return;
      clearTimeout(timers.get(full));
      timers.set(full, setTimeout(() => {
        if (stopped) return;
        fs.stat(full, (err, first) => {
          if (stopped || err || !first.isFile() || first.size < 1) return;
          setTimeout(() => {
            fs.stat(full, (secondErr, second) => {
              if (
                stopped ||
                secondErr ||
                second.size !== first.size ||
                second.mtimeMs !== first.mtimeMs
              ) return;
              const key = full + ':' + second.size + ':' + second.mtimeMs;
              if (seen.has(key)) return;
              const file = readNestFile(full);
              if (!file.ok || !isPerfexNestFile(full, file)) return;
              seen.add(key);
              onFile(full, file);
            });
          }, 500);
        });
      }, 1000));
    });
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  const killer = setTimeout(() => stop(), 20 * 60 * 1000);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(killer);
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
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
  isPerfexNestFile,
  processOrdBatch,
  watchForNestCsv,
  stopNestWatch,
};
