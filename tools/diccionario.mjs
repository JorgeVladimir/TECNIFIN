// Diccionario de datos generado del catalogo de PostgreSQL, no escrito a mano: lo que se
// revisa es lo que la base tiene de verdad (tablas, columnas, claves, RLS y politicas).
// Uso: node tools/diccionario.mjs [salida.md]   (por defecto docs/entregables/E1/DAT-01-diccionario.md)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, entornoAdmin } from './_env.mjs';
import { connectPostgres } from '../src/platform/postgres.js';

const salida = process.argv[2] || join(REPO_ROOT, 'docs', 'entregables', 'E1', 'DAT-01-diccionario.md');
const db = connectPostgres(entornoAdmin());
const filas = async (sql) => (await db.query(sql)).rows;

try {
  const tablas = await filas(`
    SELECT c.oid, c.relname AS tabla, obj_description(c.oid, 'pg_class') AS comentario,
           c.relrowsecurity AS rls, c.relforcerowsecurity AS forzada,
           (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'tecnifin' AND p.tablename = c.relname)::int AS politicas,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'cooperativa_id' AND NOT a.attisdropped) AS con_tenant
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'tecnifin' AND c.relkind = 'r'
     ORDER BY c.relname`);
  const columnas = await filas(`
    SELECT c.relname AS tabla, a.attnum, a.attname AS columna, format_type(a.atttypid, a.atttypmod) AS tipo,
           a.attnotnull AS obligatoria, pg_get_expr(d.adbin, d.adrelid) AS defecto,
           col_description(c.oid, a.attnum) AS comentario
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'tecnifin' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`);
  const restricciones = await filas(`
    SELECT c.relname AS tabla, k.conname AS nombre, k.contype AS tipo, pg_get_constraintdef(k.oid) AS definicion
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'tecnifin' AND k.contype IN ('p','f','u','c')
     ORDER BY c.relname, k.contype, k.conname`);
  const migraciones = await filas(`SELECT count(*)::int AS n FROM public.tecnifin_schema_migrations`)
    .catch(() => [{ n: '?' }]);

  const porTabla = (lista) => lista.reduce((m, f) => ((m[f.tabla] ||= []).push(f), m), {});
  const cols = porTabla(columnas);
  const res = porTabla(restricciones);
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const negocio = tablas.filter((t) => t.con_tenant);
  const sinRls = negocio.filter((t) => !t.rls || !t.forzada);

  const l = [];
  l.push('# DAT-01 · Diccionario de datos del modelo multi-tenant', '');
  l.push(`Generado del catálogo de PostgreSQL con \`node tools/diccionario.mjs\` el ${new Date().toISOString().slice(0, 10)}.`);
  l.push('No se edita a mano: si el esquema cambia, se vuelve a generar.', '');
  l.push('## Resumen', '');
  l.push('| Indicador | Valor |', '|---|---|');
  l.push(`| Migraciones versionadas aplicadas | ${migraciones[0].n} |`);
  l.push(`| Tablas en el esquema \`tecnifin\` | ${tablas.length} |`);
  l.push(`| Tablas con \`cooperativa_id\` (datos de una cooperativa) | ${negocio.length} |`);
  l.push(`| De ellas con seguridad por filas habilitada **y forzada** | ${negocio.length - sinRls.length} |`);
  l.push(`| Políticas de seguridad por filas | ${tablas.reduce((s, t) => s + t.politicas, 0)} |`);
  l.push(`| Tablas de plataforma (sin \`cooperativa_id\`) | ${tablas.length - negocio.length} |`, '');
  if (sinRls.length) l.push(`**ATENCIÓN:** sin RLS forzada: ${sinRls.map((t) => t.tabla).join(', ')}`, '');
  l.push('## Índice', '');
  l.push('| Tabla | Tenant | RLS forzada | Políticas | Descripción |', '|---|---|---|---|---|');
  for (const t of tablas) {
    l.push(`| [${t.tabla}](#${t.tabla.replace(/_/g, '_')}) | ${t.con_tenant ? 'sí' : 'plataforma'} | ${t.rls && t.forzada ? 'sí' : 'no'} | ${t.politicas} | ${esc(t.comentario)} |`);
  }
  l.push('');
  for (const t of tablas) {
    l.push(`## ${t.tabla}`, '');
    if (t.comentario) l.push(esc(t.comentario), '');
    l.push('| Columna | Tipo | Obligatoria | Por defecto | Nota |', '|---|---|---|---|---|');
    for (const c of cols[t.tabla] || []) {
      l.push(`| ${c.columna} | ${c.tipo} | ${c.obligatoria ? 'sí' : ''} | ${esc(c.defecto)} | ${esc(c.comentario)} |`);
    }
    const rs = res[t.tabla] || [];
    if (rs.length) {
      l.push('', '**Restricciones**', '');
      const tipo = { p: 'Clave primaria', f: 'Clave foránea', u: 'Única', c: 'Verificación' };
      for (const r of rs) l.push(`- ${tipo[r.tipo]} \`${r.nombre}\`: \`${esc(r.definicion)}\``);
    }
    l.push('');
  }
  mkdirSync(dirname(salida), { recursive: true });
  writeFileSync(salida, l.join('\n'));
  console.log(`Diccionario: ${tablas.length} tablas, ${negocio.length} con tenant, ${sinRls.length} sin RLS forzada -> ${salida}`);
} finally {
  await db.close();
}
