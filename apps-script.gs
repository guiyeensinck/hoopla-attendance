/**
 * Apps Script de la planilla de solicitudes: recibe los pedidos de días
 * que arma el bot "Presente" en Slack y agrega la fila en la pestaña de
 * respuestas del form.
 *
 * Instalación (una vez): en la planilla → Extensiones → Apps Script →
 * pegar este código (reemplazando lo que haya) → Guardar → Implementar →
 * Nueva implementación → tipo "Aplicación web" → Ejecutar como: Yo →
 * Quién tiene acceso: Cualquier usuario → Implementar → autorizar →
 * copiar la URL. En Railway: SOLICITUDES_WEBHOOK_URL = esa URL y
 * SOLICITUDES_WEBHOOK_SECRET = la misma clave que SECRET acá abajo.
 */
const SECRET = 'CAMBIAR-POR-LA-CLAVE';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) return responder({ ok: false, error: 'clave inválida' });
    const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheets()
      .find(function (s) { return s.getSheetId() === Number(data.gid); });
    if (!hoja) return responder({ ok: false, error: 'no encontré la pestaña ' + data.gid });
    if (!Array.isArray(data.values) || data.values.length > 20) return responder({ ok: false, error: 'fila inválida' });
    hoja.appendRow(data.values);
    return responder({ ok: true });
  } catch (err) {
    return responder({ ok: false, error: String(err) });
  }
}

function responder(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
