const db = require('./database');
const txt = require('./texts');

/**
 * Suma una persona al tracking y le manda el DM de onboarding:
 * qué registra el sistema, qué ve el admin, cómo marcar, su horario
 * y cómo pedir horas extra o avisar ausencias.
 */
const agregarAlTracking = async (client, slackId) => {
  let nombre = slackId;
  try {
    const info = await client.users.info({ user: slackId });
    nombre = info.user.profile?.real_name || info.user.real_name || info.user.name || slackId;
  } catch (e) {
    console.log(`[onboarding] No pude resolver el nombre de ${slackId}: ${e.message}`);
  }
  db.upsertUser(slackId, nombre);
  db.setTracked(slackId, 1);
  const user = db.getUser(slackId);
  try {
    await client.chat.postMessage({ channel: slackId, text: txt.onboarding(user) });
  } catch (e) {
    console.error(`[onboarding] No pude mandar DM a ${slackId}: ${e.message}`);
  }
  return user;
};

module.exports = { agregarAlTracking };
