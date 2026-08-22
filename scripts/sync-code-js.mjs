/**
 * Neon modules.code_js alanını Electron DynamicFunc gövdeleriyle doldurur.
 * Kullanım: DATABASE_URL=... node scripts/sync-code-js.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { neon } from '@neondatabase/serverless';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildCodeJs, PORTS } = require('./desktop-module-ports.js');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL gerekli');
    process.exit(1);
  }

  const sql = neon(url);
  const rows = await sql`
    SELECT id, method_name, code
    FROM modules
    ORDER BY id
  `;

  console.log(`Toplam modul: ${rows.length}`);
  let updated = 0;
  let ported = 0;

  for (const row of rows) {
    const excelHeavy = /Worksheet|ThisWorkbook|Range\(|Workbooks\.|Cells\(|ActiveWorkbook/i.test(
      row.code || ''
    );
    const codeJs = buildCodeJs(row.method_name, excelHeavy);
    const isPort = Object.prototype.hasOwnProperty.call(PORTS, row.method_name);
    await sql`
      UPDATE modules
      SET code_js = ${codeJs},
          runtime_default = ${isPort ? 'js' : excelHeavy ? 'vba' : 'js'},
          updated_at = NOW()
      WHERE id = ${row.id}
    `;
    updated += 1;
    if (isPort) ported += 1;
    if (updated % 50 === 0) console.log(`  ... ${updated}/${rows.length}`);
  }

  const existing = await sql`
    SELECT id FROM modules WHERE LOWER(method_name) = LOWER('AutoStartOnDesktopOpen') LIMIT 1
  `;
  if (existing.length === 0) {
    await sql`
      INSERT INTO modules (method_name, description, category, active, code, code_js, runtime_default, created_at, updated_at)
      VALUES (
        'AutoStartOnDesktopOpen',
        'Desktop Teklif boot auto-start (Electron DynamicFunc)',
        'zamanlanmis',
        true,
        ${"Public Function DynamicFunc(targetWb As Workbook, param As Variant) As Object\n    Set DynamicFunc = Nothing\nEnd Function"},
        ${PORTS.AutoStartOnDesktopOpen},
        'js',
        NOW(),
        NOW()
      )
    `;
    console.log('AutoStartOnDesktopOpen eklendi');
  } else {
    await sql`
      UPDATE modules
      SET code_js = ${PORTS.AutoStartOnDesktopOpen},
          runtime_default = 'js',
          updated_at = NOW()
      WHERE id = ${existing[0].id}
    `;
    console.log('AutoStartOnDesktopOpen guncellendi');
  }

  const stats = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(code_js)::int AS with_js,
      COUNT(*) FILTER (WHERE runtime_default = 'js')::int AS runtime_js,
      COUNT(*) FILTER (WHERE code_js ILIKE '%excel-only-module%')::int AS excel_stubs,
      COUNT(*) FILTER (WHERE code_js ILIKE '%os-module-port-pending%')::int AS os_stubs
    FROM modules
  `;
  console.log('Bitti.', { updated, ported, stats: stats[0] });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
