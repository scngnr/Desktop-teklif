const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const ord = require('../src/metalixOrd');
const identity = require('../src/desktopIdentity');

function crc32(data) {
  return zlib.crc32(Buffer.from(data)) >>> 0;
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  files.forEach((file) => {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data);
    const method = file.method === 8 ? 8 : 0;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(1 << 11, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(1 << 11, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('ORD satırı AutoNest Excel sözleşmesiyle yazılır ve okunur', () => {
  const line = ord.formatOrdLine({
    orderName: '998-5',
    filePath: 'C:\\Metalix\\P\\Ex_AutoNest\\Exercise2\\AN_L_Tut2_1.dxf',
    minQty: 10,
    maxQty: 10,
    material: 0,
    thickness: 1.5,
  });
  assert.equal(
    line,
    '"998-5"   "C:\\Metalix\\P\\Ex_AutoNest\\Exercise2\\AN_L_Tut2_1.dxf"   10   10   @M=0   @T=1.5'
  );
  const parsed = ord.parseOrdLine(line);
  assert.equal(parsed.orderName, '998-5');
  assert.equal(parsed.filePath, 'C:\\Metalix\\P\\Ex_AutoNest\\Exercise2\\AN_L_Tut2_1.dxf');
  assert.equal(parsed.minQty, '10');
  assert.equal(parsed.maxQty, '10');
  assert.equal(parsed.material, '0');
  assert.equal(parsed.thickness, '1.5');
  assert.equal(ord.partIdFromDxf('D:\\Metalix\\Gelen\\MO-395\\DKP_1.2\\P12-PARCA.dxf'), '12');
});

test('boş max adedi tek sayı olarak kalır', () => {
  const parsed = ord.parseOrdLine(
    '"998-5"   "C:\\Metalix\\P\\Ex_AutoNest\\Exercise2\\AN_L_Tut2_4.dxf"   20      @M=1   @T=1'
  );
  assert.equal(parsed.minQty, '20');
  assert.equal(parsed.maxQty, '');
  assert.equal(parsed.material, '1');
  assert.equal(parsed.thickness, '1');
});

test('klasör ve grup kuralları', () => {
  assert.equal(ord.validateDir('').code, 'dir_required');
  assert.equal(ord.validateDir('D:\\Metalix\\Gelen').ok, true);
  assert.equal(ord.validateDir('D:/Metalix/Gelen').ok, true);
  assert.equal(ord.validateDir('a'.repeat(201)).code, 'dir_too_long');
  assert.equal(ord.validateDir('D:\\Metalix\\"Gelen').code, 'dir_invalid');
  assert.equal(ord.validateDir('D:\\Metalix\nGelen').code, 'dir_invalid');
  assert.equal(ord.validateGroup('').group, '');
  assert.equal(ord.validateGroup('DKP_1.2').group, 'DKP_1.2');
  assert.equal(ord.validateGroup('DKP/1.2').code, 'group_invalid');
  assert.equal(ord.validateMoId('395').moId, '395');
  assert.equal(ord.validateMoId('MO-395').code, 'mo_invalid');
  assert.equal(ord.validateMoId('0').code, 'mo_invalid');
});

test('DXF yolu seçilen klasörün altında olmalı', () => {
  assert.equal(
    ord.pathIsUnderDir('D:\\Metalix\\Gelen\\MO-395\\DKP_1.2\\P12-PARCA.dxf', 'D:/Metalix/Gelen'),
    true
  );
  assert.equal(
    ord.pathIsUnderDir('D:\\Metalix\\GelenExtra\\P1-A.dxf', 'D:\\Metalix\\Gelen'),
    false
  );
});

test('nest CSV kuralları', () => {
  const body = ord.nestJsonBody({
    filename: 'rapor',
    profile: '',
    csv: 'Order:,DEMO\n',
  });
  assert.equal(body.ok, true);
  assert.equal(body.body.filename, 'rapor.csv');
  assert.equal(body.body.profile, 'metalix_perfex');
  assert.equal(ord.prepareNestCsv('notlar.doc', 'a').code, 'csv_only');
  assert.equal(ord.prepareNestCsv('rapor.csv', '   ').code, 'csv_empty');
  assert.equal(ord.prepareNestCsv('rapor.csv', 'x'.repeat(ord.CSV_MAX_BYTES + 1)).code, 'csv_too_large');
  assert.equal(ord.nestEndpointPaths(395).paths[0], 'api/v1/mrp/manufacturing_orders/395/nest');
  assert.equal(ord.ordEndpointPaths(395).paths[1], 'api/mrp/manufacturing_orders/395/ord');
});

test('grup ve zip yanıtları ayrılır', () => {
  const groups = ord.interpretGroups(
    200,
    Buffer.from(
      JSON.stringify({
        status: true,
        mo_id: 395,
        manufacturing_order_code: 'MO-395',
        suggested_dir: 'C:\\Metalix\\Perfex',
        groups: [{ key: 'DKP_1.2', material: 'DKP', thickness: 1.2, qty: 49 }],
      })
    )
  );
  assert.equal(groups.ok, true);
  assert.equal(groups.groups[0].key, 'DKP_1.2');
  assert.equal(groups.suggestedDir, 'C:\\Metalix\\Perfex');

  const zip = buildZip([{ name: 'MO-395_DKP_1.2.ORD', data: 'x' }]);
  const downloaded = ord.interpretOrdDownload(
    200,
    {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="MO-395_metalix.zip"',
      'x-mrp-ord-files': '1',
      'x-mrp-ord-missing': '2',
      'x-mrp-ord-dir': 'D%3A%5CMetalix%5CGelen',
    },
    zip
  );
  assert.equal(downloaded.ok, true);
  assert.equal(downloaded.filename, 'MO-395_metalix.zip');
  assert.equal(downloaded.missing, 2);
  assert.equal(downloaded.ordDir, 'D:\\Metalix\\Gelen');

  const missing = ord.interpretOrdDownload(
    422,
    { 'content-type': 'application/json' },
    Buffer.from(
      JSON.stringify({
        status: false,
        code: 'dxf_missing',
        message: 'Parça var ama DXF zip’i okunamadı.',
        files: [{ path: 'uploads/P12-PARCA.dxf' }],
      })
    )
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'dxf_missing');
  assert.match(missing.error, /sunucu DXF zip/);
  assert.match(missing.error, /P12-PARCA\.dxf/);
  assert.equal(
    new URLSearchParams(ord.ordDownloadQuery('C:\\Metalix\\Perfex', '')).get('dir'),
    'C:/Metalix/Perfex'
  );
  assert.equal(ord.apiDir('\\\\sunucu\\paylasim\\Metalix'), '\\\\sunucu\\paylasim\\Metalix');
});

test('nest raporu kesim süresi ve sac kilogramını taşır', () => {
  const posted = ord.interpretNestPost(
    200,
    Buffer.from(
      JSON.stringify({
        status: true,
        mo_id: 395,
        report_id: 18,
        report: {
          id: 18,
          cut_minutes: 25.17,
          sheet_kg_calc: 95.181,
          pierces: 160,
          groups: [{ material: 'DKP', thickness: 2, sheets: 1, cut_minutes: 16.5 }],
        },
        supply: { ok: true, lines: 2 },
      })
    )
  );
  assert.equal(posted.report.cut_minutes, 25.17);
  assert.equal(posted.report.sheet_kg_calc, 95.181);
  assert.equal(posted.supply.ok, true);

  const listed = ord.interpretNestList(200, Buffer.from(JSON.stringify({ reports: [{ id: 18 }] })));
  assert.equal(listed.reports[0].id, 18);
});

test('zip seçilen klasöre açılır, dışarı yazmaz', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'metalix-ord-'));
  const ordLine = ord.formatOrdLine({
    orderName: 'MO-395',
    filePath: 'D:\\Metalix\\Gelen\\MO-395\\DKP_1.2\\P12-PARCA.dxf',
    minQty: 2,
    maxQty: 2,
    material: 0,
    thickness: 1.2,
  });
  const zip = buildZip([
    { name: 'MO-395/DKP_1.2/P12-PARCA.dxf', data: 'DXF', method: 8 },
    { name: 'MO-395_DKP_1.2.ORD', data: ordLine + '\r\n', method: 0 },
  ]);
  const files = ord.extractZip(zip, dest);
  assert.equal(files.length, 2);
  const dxf = path.join(dest, 'MO-395', 'DKP_1.2', 'P12-PARCA.dxf');
  assert.equal(fs.readFileSync(dxf, 'utf8'), 'DXF');
  const text = fs.readFileSync(path.join(dest, 'MO-395_DKP_1.2.ORD'), 'utf8');
  const inspected = ord.inspectOrdText(text, 'D:\\Metalix\\Gelen');
  assert.equal(inspected.lineCount, 1);
  assert.equal(inspected.warnings.length, 0);

  assert.throws(() => ord.extractZip(buildZip([{ name: '../kacak.txt', data: 'no' }]), dest), {
    code: 'zip_slip',
  });
  assert.equal(fs.existsSync(path.join(dest, '..', 'kacak.txt')), false);
  fs.rmSync(dest, { recursive: true, force: true });
});

test('ORD indirme GET ile okuma iznine düşer, nest POST kalır', () => {
  const url = ord.rewriteOrdPostToGet(
    'POST',
    'https://mrp.example/firma/ps/api/v1/mrp/manufacturing_orders/395/ord',
    JSON.stringify({ dir: 'C:\\Metalix\\Perfex', group: '' })
  );
  const parsed = new URL(url);
  assert.equal(parsed.pathname.endsWith('/manufacturing_orders/395/ord'), true);
  assert.equal(parsed.searchParams.get('dir'), 'C:/Metalix/Perfex');
  assert.equal(parsed.searchParams.get('group'), null);
  assert.equal(
    ord.rewriteOrdPostToGet(
      'POST',
      'https://mrp.example/api/v1/mrp/manufacturing_orders/395/nest',
      '{"dir":"C:\\\\Metalix\\\\Perfex"}'
    ),
    null
  );
  assert.equal(ord.ordDownloadNeedsPost({ ok: false, status: 403, code: 'permission_denied' }), false);
  assert.equal(ord.ordDownloadNeedsPost({ ok: false, status: 405 }), true);
  const denied = ord.interpretOrdDownload(
    403,
    { 'content-type': 'application/json' },
    Buffer.from(
      JSON.stringify({
        status: false,
        message: 'Your API token does not have the necessary permissions for the requested operation',
      })
    )
  );
  assert.equal(denied.code, 'permission_denied');
  assert.match(denied.error, /okuma/);
});

test('panel düğmesi ve API token yalnızca kendi hostuna yazılır', () => {
  assert.equal(ord.isMetalixSendLabel("Electron: Metalix'e gönder"), true);
  assert.equal(ord.isMetalixSendLabel('Electron: Metalix’e gönder'), true);
  assert.equal(ord.isMetalixSendLabel('ORD ve DXF indir'), false);
  assert.equal(
    ord.moIdFromPageUrl('https://mrp.example/admin/manufacturing/view_manufacturing_order/395?tab=cut_files_tab'),
    '395'
  );
  assert.equal(ord.normalizeMetalixGroup('DKP_1.2', 'Tüm gruplar'), '');
  assert.equal(ord.normalizeMetalixGroup('DKP_1.2', 'DKP 1.2'), 'DKP_1.2');
  const hosts = ['mrp.example'];
  assert.equal(identity.isOwnApiUrl('https://mrp.example/firma/ps/api/v1/mrp/manufacturing_orders/395/ord', hosts), true);
  assert.equal(identity.isOwnApiUrl('https://evil.example/api/v1/mrp/manufacturing_orders/395/ord', hosts), false);
  assert.equal(identity.isOwnApiUrl('https://mrp.example/admin/manufacturing/view_manufacturing_order/395', hosts), false);
  const headers = identity.withApiToken({ Authtoken: 'eski', Accept: 'application/json' }, {
    token: 'yeni-token',
    headerName: 'authtoken',
  });
  assert.equal(headers.authtoken, 'yeni-token');
  assert.equal(headers.Authtoken, undefined);
  assert.equal(headers.Accept, 'application/json');
});

test('LoadOrdFile ortamı sac ölçüsü olmadan kurulmaz ve komut yola gömülmez', () => {
  assert.equal(ord.sheetSizeEnv({ ordPath: 'C:\\a.ord', sheetX: '', sheetY: 1250 }).code, 'sheet_size_required');
  const env = ord.sheetSizeEnv({
    ordPath: 'D:\\Metalix\\Gelen\\MO-395_DKP_1.2.ORD',
    sheetX: 2000,
    sheetY: 1250,
    startNest: true,
  });
  assert.equal(env.env.METALIX_SX, '2000');
  assert.equal(env.env.METALIX_SY, '1250');
  assert.equal(env.env.METALIX_START, '1');
  assert.equal(ord.METALIX_PS.includes('OptiMech.Document'), true);
  assert.equal(ord.METALIX_PS.includes('LoadOrdFile'), true);
  assert.equal(ord.METALIX_PS.includes('DoStartAutoNest'), true);
  assert.equal(ord.METALIX_PS.includes('D:\\Metalix'), false);
});
