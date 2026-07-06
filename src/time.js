const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
require('dayjs/locale/es');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('es');

// Timezone forzado para toda la app — todos los cálculos pasan por acá.
const TZ = 'America/Argentina/Buenos_Aires';

/** Ahora en Buenos Aires */
const now = () => dayjs().tz(TZ);

/** Fecha de hoy YYYY-MM-DD */
const today = () => now().format('YYYY-MM-DD');

/** Hora actual HH:mm */
const currentTime = () => now().format('HH:mm');

/** Minuto del día actual (0-1439) */
const nowMin = () => now().hour() * 60 + now().minute();

/** "HH:MM" → minutos desde las 00:00 */
const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/** minutos → "HH:MM" */
const toHHMM = (min) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Lunes de la semana actual (el balance se resetea cada lunes) */
const weekStart = () => {
  const n = now();
  return n.subtract((n.day() + 6) % 7, 'day').format('YYYY-MM-DD');
};

/** Primer día del mes actual */
const monthStart = () => now().startOf('month').format('YYYY-MM-DD');

const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && dayjs(s).isValid();
const isValidTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

/** ¿Es día hábil? (lun-vie) */
const isWeekday = (dateStr) => {
  const d = dayjs(dateStr).day();
  return d !== 0 && d !== 6;
};

const fmtDate = (d) => dayjs(d).format('DD/MM/YYYY');
const fmtRange = (s, e) => `${dayjs(s).format('DD/MM')} – ${dayjs(e).format('DD/MM/YYYY')}`;

module.exports = {
  dayjs, TZ, now, today, currentTime, nowMin,
  toMin, toHHMM, weekStart, monthStart,
  isValidDate, isValidTime, isWeekday, fmtDate, fmtRange,
};
