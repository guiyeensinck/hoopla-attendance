const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'America/Argentina/Buenos_Aires';

/** Current time in Buenos Aires */
const now = () => dayjs().tz(TZ);

/** Today's date as YYYY-MM-DD in Buenos Aires */
const today = () => now().format('YYYY-MM-DD');

/** Current time as HH:mm in Buenos Aires */
const currentTime = () => now().format('HH:mm');

/** Current time as HH:mm:ss in Buenos Aires */
const currentTimeFull = () => now().format('HH:mm:ss');

/** Format a date string for display */
const formatDate = (dateStr) => dayjs(dateStr).format('DD/MM/YYYY');

/** Format date range for display */
const formatRange = (start, end) => `${dayjs(start).format('DD/MM')} – ${dayjs(end).format('DD/MM/YYYY')}`;

/** Start of current week (Monday) */
const weekStart = () => now().startOf('week').format('YYYY-MM-DD');

/** End of current week */
const weekEnd = () => now().endOf('week').format('YYYY-MM-DD');

/** Start of current month */
const monthStart = () => now().startOf('month').format('YYYY-MM-DD');

/** Current hour (number) */
const currentHour = () => now().hour();

/** Current minute of day */
const currentMinuteOfDay = () => now().hour() * 60 + now().minute();

/** Day of week (0=Sunday) */
const dayOfWeek = () => now().day();

module.exports = {
  dayjs, TZ, now, today, currentTime, currentTimeFull,
  formatDate, formatRange, weekStart, weekEnd, monthStart,
  currentHour, currentMinuteOfDay, dayOfWeek,
};
