// Router de mensajes directos: el bot se usa escribiéndole como a un
// compañero (sin slash commands). Matchea palabras simples en español.

const normalize = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin acentos
  .trim();

/**
 * Decide qué quiso decir la persona.
 * → { tipo: 'admin', resto } | { tipo: 'marcar' } | { tipo: 'horarios' } | { tipo: 'menu' }
 */
const route = (raw) => {
  const texto = normalize(raw);
  if (/^admin\b/.test(texto)) {
    return { tipo: 'admin', resto: (raw || '').trim().replace(/^admin\s*/i, '') };
  }
  if (/^(marcar|marco|marca|entrada|salida|fichar|fichaje|link|almuerzo|entro|salgo)\b/.test(texto)) {
    return { tipo: 'marcar' };
  }
  if (/^(horarios?|estado|semana|balance|resumen|como voy|cuanto llevo)\b/.test(texto)) {
    return { tipo: 'horarios' };
  }
  return { tipo: 'menu' };
};

module.exports = { route, normalize };
