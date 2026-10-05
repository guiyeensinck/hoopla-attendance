const crypto = require('crypto');

/**
 * Escribe filas en la planilla de solicitudes de Google Sheets. Dos formas
 * (si están las dos, gana el Apps Script):
 *
 * A) Apps Script de la planilla (lo más simple — ver apps-script.gs):
 * SOLICITUDES_WEBHOOK_URL      URL de la "aplicación web" del script
 * SOLICITUDES_WEBHOOK_SECRET   clave compartida (la misma que en el script)
 *
 * B) Cuenta de servicio (sin dependencias: JWT firmado a mano → token
 *    OAuth → API de Sheets):
 * GOOGLE_SERVICE_ACCOUNT_JSON  la clave JSON de la cuenta de servicio (el
 *                              archivo completo, o en base64). La planilla
 *                              tiene que estar compartida con su email como Editor.
 * SOLICITUDES_SHEET_ID         id de la planilla (default: la de solicitudes de Hoopla)
 * SOLICITUDES_SHEET_GID        gid de la pestaña (default: la de respuestas del form)
 *
 * Sin la variable, no escribe nada (la solicitud igual se guarda en la app).
 */

const SHEET_ID = () => process.env.SOLICITUDES_SHEET_ID || '1V1SxED1V95CYWkpW9TtaXhCE6WAcPBrTHBNWixfjCzE';
const SHEET_GID = () => Number(process.env.SOLICITUDES_SHEET_GID || 1073595938);

const credenciales = () => {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e) {
    console.error('[planilla] GOOGLE_SERVICE_ACCOUNT_JSON no es un JSON válido');
    return null;
  }
};

const webhook = () => (process.env.SOLICITUDES_WEBHOOK_URL ? { url: process.env.SOLICITUDES_WEBHOOK_URL, secret: process.env.SOLICITUDES_WEBHOOK_SECRET || '' } : null);

const planillaActiva = () => Boolean(webhook() || credenciales());

/** Apps Script: POST con la clave y la fila; responde {ok:true} */
const agregarFilaWebhook = async ({ url, secret }, valores) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' }, // Apps Script lee e.postData.contents
    body: JSON.stringify({ secret, gid: SHEET_GID(), values: valores }),
    redirect: 'follow',
  });
  const texto = await r.text();
  let j = null;
  try { j = JSON.parse(texto); } catch (_) { /* HTML de error de Google */ }
  if (!r.ok || !j?.ok) throw new Error(`Apps Script ${r.status}: ${(j?.error || texto).slice(0, 200)}`);
  return true;
};

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

let tokenCache = { token: null, exp: 0 };
const accessToken = async (cred) => {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const ahora = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: cred.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3600,
  }));
  const firma = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(cred.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${firma}` }),
  });
  if (!r.ok) throw new Error(`token Google ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
};

// Nombre de la pestaña a partir del gid (cache: no cambia)
let tituloCache = null;
const tituloPestaña = async (token) => {
  if (tituloCache) return tituloCache;
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}?fields=sheets.properties(sheetId,title)`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`leer planilla ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const hoja = (await r.json()).sheets.find(s => s.properties.sheetId === SHEET_GID());
  if (!hoja) throw new Error(`no encontré la pestaña con gid ${SHEET_GID()}`);
  tituloCache = hoja.properties.title;
  return tituloCache;
};

/** Agrega una fila al final de la pestaña. Devuelve true si se escribió. */
const agregarFila = async (valores) => {
  const wh = webhook();
  if (wh) return agregarFilaWebhook(wh, valores);
  const cred = credenciales();
  if (!cred) return false;
  const token = await accessToken(cred);
  const titulo = await tituloPestaña(token);
  const rango = encodeURIComponent(`'${titulo.replace(/'/g, "''")}'!A:K`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}/values/${rango}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ values: [valores] }),
  });
  if (!r.ok) throw new Error(`escribir planilla ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return true;
};

module.exports = { agregarFila, planillaActiva };
