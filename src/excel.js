const ExcelJS = require('exceljs');
const path = require('path');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');

const EXPORT_DIR = process.env.DB_PATH || path.join(__dirname, '..', 'data');

const header = (ws, color) => {
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
};

/**
 * Excel de asistencia con 3 hojas: detalle diario, resumen por persona, novedades.
 */
const generarExcel = async (from, to, label) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hoopla Asistencia';
  wb.created = new Date();

  // ─── Hoja 1: Detalle diario ──────────────────────────────────────
  const ws1 = wb.addWorksheet('Detalle diario');
  ws1.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Persona', key: 'nombre', width: 22 },
    { header: 'Entrada', key: 'entrada', width: 10 },
    { header: 'Tarde (min)', key: 'tarde', width: 12 },
    { header: 'Almuerzo ini', key: 'al_ini', width: 13 },
    { header: 'Almuerzo fin', key: 'al_fin', width: 13 },
    { header: 'Salida', key: 'salida', width: 10 },
    { header: 'Anticipado (min)', key: 'anticipado', width: 16 },
    { header: 'Horas', key: 'horas', width: 9 },
    { header: 'Origen', key: 'origen', width: 14 },
    { header: 'Auto-cierre', key: 'auto', width: 12 },
    { header: 'Corregida (original)', key: 'correccion', width: 18 },
  ];
  header(ws1, 'FF6C5CE7');
  for (const d of db.getDias(from, to).sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    ws1.addRow({
      fecha: d.fecha, nombre: d.nombre,
      entrada: d.entrada || '', tarde: d.tarde_min || '',
      al_ini: d.almuerzo_inicio || '', al_fin: d.almuerzo_fin || '',
      salida: d.salida || '', anticipado: d.anticipado_min || '',
      horas: d.horas ?? '',
      origen: d.origen === 'mobile_remoto' ? 'Mobile (remoto)' : d.origen === 'auto' ? 'Auto' : d.origen === 'slack' ? 'Slack' : 'Web',
      auto: d.auto_closed ? 'Sí' : '',
      correccion: d.corregido ? d.valor_original : '',
    });
  }

  // ─── Hoja 2: Resumen por persona ─────────────────────────────────
  const ws2 = wb.addWorksheet('Resumen por persona');
  ws2.columns = [
    { header: 'Persona', key: 'nombre', width: 22 },
    { header: 'Horario', key: 'horario', width: 14 },
    { header: 'Días trabajados', key: 'dias', width: 15 },
    { header: 'Horas', key: 'horas', width: 10 },
    { header: 'Horas esperadas', key: 'esperadas', width: 15 },
    { header: 'Diferencia', key: 'diff', width: 11 },
    { header: 'Llegadas tarde', key: 'tardes', width: 14 },
    { header: 'Auto-cierres', key: 'auto', width: 12 },
  ];
  header(ws2, 'FF00B894');
  for (const p of db.resumenPersonas(from, to)) {
    ws2.addRow({
      nombre: p.nombre, horario: `${p.hora_entrada}–${p.hora_salida}`,
      dias: p.diasTrabajados, horas: p.horas, esperadas: p.esperadas,
      diff: Math.round((p.horas - p.esperadas) * 100) / 100,
      tardes: p.tardes, auto: p.autoCierres,
    });
  }

  // ─── Hoja 3: Novedades ───────────────────────────────────────────
  const ws3 = wb.addWorksheet('Novedades');
  ws3.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Tipo', key: 'tipo', width: 20 },
    { header: 'Persona', key: 'nombre', width: 22 },
    { header: 'Motivo', key: 'motivo', width: 32 },
  ];
  header(ws3, 'FFFDCB6E');
  for (const n of db.getNovedadesRange(from, to)) {
    ws3.addRow({
      fecha: n.fecha,
      tipo: (txt.NOVEDADES[n.tipo] || n.tipo).replace(/^\S+\s/, ''), // sin emoji
      nombre: n.nombre || 'Todos',
      motivo: n.motivo || '',
    });
  }

  // ─── Hoja 4: Proyectos (si hay horas imputadas) ──────────────────
  const imputaciones = db.getImputacionesRange(from, to);
  if (imputaciones.length) {
    const ws4 = wb.addWorksheet('Proyectos');
    ws4.columns = [
      { header: 'Fecha', key: 'fecha', width: 12 },
      { header: 'Persona', key: 'persona', width: 22 },
      { header: 'Cliente', key: 'cliente', width: 20 },
      { header: 'Proyecto', key: 'proyecto', width: 24 },
      { header: 'Horas', key: 'horas', width: 9 },
    ];
    header(ws4, 'FFA29BFE');
    for (const i of imputaciones) ws4.addRow(i);
  }

  const filepath = path.join(EXPORT_DIR, `asistencia_${label}.xlsx`);
  await wb.xlsx.writeFile(filepath);
  return filepath;
};

module.exports = { generarExcel };
