/**
 * Modo prueba por persona (en memoria — se pierde al reiniciar, a propósito).
 *
 * `admin probar cierre [rapido]` pone al admin en modo prueba: su horario
 * de salida pasa a ser "ahora" (el flujo de cierre arranca ya, aunque sea
 * finde o feriado) y, en modo rápido, los tiempos se aceleran para no
 * esperar 25 minutos entre preguntas. No afecta a nadie más.
 */

// Tiempos reales del cierre (minutos)
const TIEMPOS = { respuesta: 10, sigo: 25 };
// Tiempos acelerados para probar
const TIEMPOS_RAPIDO = { respuesta: 1, sigo: 2 };

const activas = new Map(); // uid → { salida: 'HH:MM', rapido: bool }
let tickHook = null;

module.exports = {
  TIEMPOS,
  TIEMPOS_RAPIDO,
  set: (uid, cfg) => activas.set(uid, cfg),
  get: (uid) => activas.get(uid) || null,
  clear: (uid) => activas.delete(uid),
  uids: () => [...activas.keys()],
  tiempos: (uid) => (activas.get(uid)?.rapido ? TIEMPOS_RAPIDO : TIEMPOS),
  // El scheduler registra su tick para poder dispararlo al instante desde admin
  setTick: (fn) => { tickHook = fn; },
  tickAhora: () => (tickHook ? tickHook() : Promise.resolve()),
};
