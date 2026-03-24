const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const t = require('./time');
const db = require('./database');

const EXPORT_DIR = process.env.DB_PATH || path.join(__dirname, '..', 'data');

/**
 * Generate monthly Excel report and return file path
 */
const generateMonthlyExcel = async (startDate, endDate, label) => {
  const { users, records, overrides } = db.getMonthlyExportData(startDate, endDate);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hoopla Asistencia';
  wb.created = new Date();

  // ─── Sheet 1: Detalle diario ─────────────────────────────────────
  const ws = wb.addWorksheet('Detalle');

  ws.columns = [
    { header: 'Fecha', key: 'date', width: 14 },
    { header: 'Persona', key: 'name', width: 22 },
    { header: 'Entrada', key: 'entry', width: 10 },
    { header: 'Almuerzo ini', key: 'lunch_start', width: 14 },
    { header: 'Almuerzo fin', key: 'lunch_end', width: 14 },
    { header: 'Salida', key: 'exit', width: 10 },
    { header: 'Horas', key: 'hours', width: 10 },
    { header: 'Modo', key: 'mode', width: 14 },
    { header: 'Notas', key: 'notes', width: 25 },
  ];

  // Header style
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C5CE7' } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const r of records) {
    ws.addRow({
      date: r.date,
      name: r.real_name || r.name,
      entry: r.entry_time || '',
      lunch_start: r.lunch_start || '',
      lunch_end: r.lunch_end || '',
      exit: r.exit_time || '',
      hours: r.total_hours || '',
      mode: r.work_mode === 'field' ? 'Campo' : 'Oficina',
      notes: r.notes || '',
    });
  }

  // ─── Sheet 2: Resumen por persona ────────────────────────────────
  const ws2 = wb.addWorksheet('Resumen');

  ws2.columns = [
    { header: 'Persona', key: 'name', width: 22 },
    { header: 'Días trabajados', key: 'days', width: 16 },
    { header: 'Días campo', key: 'field_days', width: 14 },
    { header: 'Horas totales', key: 'total_hours', width: 14 },
    { header: 'Horas promedio', key: 'avg_hours', width: 14 },
    { header: 'Vacaciones', key: 'vacations', width: 14 },
    { header: 'Ausencias', key: 'absences', width: 14 },
    { header: 'Médico', key: 'medical', width: 14 },
  ];

  ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B894' } };

  for (const user of users) {
    const userRecords = records.filter(r => r.slack_id === user.slack_id);
    const userOverrides = overrides.filter(o => o.slack_id === user.slack_id);
    const fieldDays = userRecords.filter(r => r.work_mode === 'field').length;
    const totalHours = userRecords.reduce((s, r) => s + (r.total_hours || 0), 0);
    const daysWorked = userRecords.filter(r => r.entry_time).length;

    ws2.addRow({
      name: user.real_name || user.name,
      days: daysWorked,
      field_days: fieldDays,
      total_hours: Math.round(totalHours * 100) / 100,
      avg_hours: daysWorked > 0 ? Math.round((totalHours / daysWorked) * 100) / 100 : 0,
      vacations: userOverrides.filter(o => o.type === 'vacation').length,
      absences: userOverrides.filter(o => ['absent', 'day_off'].includes(o.type)).length,
      medical: userOverrides.filter(o => o.type === 'medical').length,
    });
  }

  // ─── Sheet 3: Novedades ──────────────────────────────────────────
  const ws3 = wb.addWorksheet('Novedades');

  ws3.columns = [
    { header: 'Fecha', key: 'date', width: 14 },
    { header: 'Tipo', key: 'type', width: 18 },
    { header: 'Persona', key: 'name', width: 22 },
    { header: 'Motivo', key: 'reason', width: 30 },
  ];

  ws3.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDCB6E' } };

  const { OVERRIDE_LABELS } = require('./blocks');
  for (const o of overrides) {
    ws3.addRow({
      date: o.date,
      type: OVERRIDE_LABELS[o.type] || o.type,
      name: o.real_name || o.name || 'Todos',
      reason: o.reason || '',
    });
  }

  // Save
  const filename = `asistencia_${label}.xlsx`;
  const filepath = path.join(EXPORT_DIR, filename);
  await wb.xlsx.writeFile(filepath);

  return filepath;
};

module.exports = { generateMonthlyExcel };
