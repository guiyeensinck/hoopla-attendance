const fs = require('fs');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { agregarAlTracking } = require('./onboarding');
const { resumenDiario, reportePersonas, fichaPersona, resumenEjecutivo, reporteProyectos } = require('./reports');
const { buscarProyecto } = require('./proyectos');
const { generarExcel } = require('./excel');

// Siempre @mención de Slack, nunca nombre tipeado
const extractMention = (str = '') => {
  const m = str.match(/<@([A-Z0-9]+)(?:\|[^>]*)?>/);
  return m ? m[1] : null;
};

const USO = `⚙️ *Gestión de asistencia* — escribime \`admin ...\` acá en el DM (siempre con @mención)

*Personas*
\`admin agregarme\` · \`admin agregartodos\` · \`admin agregar @user\` · \`admin sacar @user\`
\`admin admin @user\` — nombrar admin (solo super admin)
\`admin horario @user HH:MM HH:MM Nhs\` — ej: \`admin horario @ana 09:00 18:00 8hs\`
\`admin persona @user\` — ficha completa (horas, tardes, presencia, saldo)
\`admin equipo @user Nombre\` — asignar equipo (\`-\` para sacarlo) · \`admin equipos\` — ver equipos

*Proyectos (time tracking)*
\`admin proyecto agregar Cliente / Proyecto\` — sin \`/\` queda sin cliente (ej. Interno)
\`admin proyecto sacar Nombre\` · \`admin proyectos\` (agrupado por cliente)
\`admin reporte proyectos [semana|mes]\` — horas por cliente → proyecto → persona

*Novedades*
\`admin feriado FECHA Motivo\` — aplica a todos (acepta varias líneas) · \`admin feriados\` — ver cargados
\`admin vacaciones @user DESDE HASTA\` · \`admin medico @user FECHA Motivo\`
\`admin ausente @user FECHA Motivo\` · \`admin libre @user FECHA\` · \`admin salida @user FECHA Motivo\`
\`admin remoto @user FECHA\` — habilita fichaje mobile ese día

*Monitoreo*
\`admin ping @user [días]\` — activa chequeos de actividad (la persona es notificada)
\`admin novedades [FECHA]\` · \`admin actividad\` · \`admin presencia\`

*Reportes*
\`admin reporte hoy\` · \`admin reporte semana\` · \`admin reporte mes\` · \`admin reporte ejecutivo\` · \`admin export\` (Excel por DM)

_Fechas en formato YYYY-MM-DD._`;

/**
 * Maneja un mensaje "admin ..." recibido por DM.
 * `texto` viene sin el prefijo "admin". `say` responde en el mismo DM.
 */
const handleAdmin = async ({ texto, adminId, say, client }) => {
    if (!db.isAdmin(adminId)) { await say(txt.errores.sinPermiso); return; }

    const parts = (texto || '').trim().split(/\s+/).filter(Boolean);
    const accion = (parts[0] || '').toLowerCase();

    // Helper: valida mención + fecha para los comandos de novedades por persona
    const novedadPersonal = async (tipo, { fechaIdx = 2, motivoIdx = 3, defaultMotivo }) => {
      const uid = extractMention(parts[1] || '');
      if (!uid) { await say(txt.errores.faltaMencion); return null; }
      const fecha = parts[fechaIdx] || t.today();
      if (!t.isValidDate(fecha)) { await say(txt.errores.fechaInvalida); return null; }
      const motivo = parts.slice(motivoIdx).join(' ') || defaultMotivo;
      await ensureUser(client, uid);
      db.addNovedad(uid, tipo, fecha, motivo, adminId);
      return { uid, fecha, motivo, nombre: db.getUser(uid)?.nombre || uid };
    };

    try {
      switch (accion) {
        case '': case 'ayuda': case 'help': {
          await say(USO);
          break;
        }

        // ─── Personas ─────────────────────────────────────────────
        case 'agregarme': {
          // El DM de onboarding llega en esta misma conversación — es la confirmación.
          await agregarAlTracking(client, adminId);
          break;
        }
        case 'agregartodos': {
          if (process.env.SOLO_MODE === 'true') {
            // En beta solo se agrega a los usuarios habilitados en SOLO_USER_ID
            const ids = (process.env.SOLO_USER_ID || '').split(',').map(s => s.trim()).filter(Boolean);
            const nombres = [];
            for (const id of (ids.length ? ids : [adminId])) {
              const u = await agregarAlTracking(client, id);
              nombres.push(u.nombre);
            }
            await say(`🧪 SOLO_MODE activo — agregué solo a la beta: *${nombres.join('*, *')}*.`);
            break;
          }
          const res = await client.users.list({ limit: 200 });
          const members = res.members.filter(m => !m.deleted && !m.is_bot && m.id !== 'USLACKBOT' && !m.is_restricted);
          let count = 0;
          for (const m of members) { await agregarAlTracking(client, m.id); count++; }
          await say(`✅ Agregué a *${count}* personas al seguimiento. Cada una recibió su DM de onboarding.`);
          break;
        }
        case 'agregar': {
          const uid = extractMention(parts[1] || '');
          if (!uid) { await say(txt.errores.faltaMencion); return; }
          const u = await agregarAlTracking(client, uid);
          await say(`✅ *${u.nombre}* agregado al seguimiento — le expliqué cómo funciona por DM.`);
          break;
        }
        case 'sacar': {
          const uid = extractMention(parts[1] || '');
          if (!uid) { await say(txt.errores.faltaMencion); return; }
          await ensureUser(client, uid);
          db.setTracked(uid, 0);
          await say(`✅ *${db.getUser(uid)?.nombre || uid}* fuera del seguimiento.`);
          break;
        }
        case 'admin': {
          if (!db.isSuperAdmin(adminId)) { await say(txt.errores.soloSuperAdmin); return; }
          const uid = extractMention(parts[1] || '');
          if (!uid) { await say(txt.errores.faltaMencion); return; }
          await ensureUser(client, uid);
          db.setAdmin(uid, 1);
          await say(`✅ *${db.getUser(uid)?.nombre || uid}* ahora es admin.`);
          break;
        }
        case 'horario': {
          const uid = extractMention(parts[1] || '');
          if (!uid) { await say(txt.errores.faltaMencion); return; }
          const [entrada, salida] = [parts[2], parts[3]];
          const carga = parseFloat((parts[4] || '').replace(/hs?$/i, ''));
          if (!t.isValidTime(entrada) || !t.isValidTime(salida) || !(carga > 0 && carga <= 12)) {
            await say('⚠️ Uso: `horario @user HH:MM HH:MM Nhs` — ej: `horario @ana 09:00 18:00 8hs`');
            return;
          }
          await ensureUser(client, uid);
          db.setHorario(uid, entrada, salida, carga);
          await say(`✅ Horario de *${db.getUser(uid)?.nombre || uid}*: ${entrada}–${salida}, ${carga}hs/día.`);
          break;
        }

        case 'persona': case 'ficha': {
          const uid = extractMention(parts[1] || '');
          if (!uid) { await say(txt.errores.faltaMencion); return; }
          const target = db.getUser(uid);
          if (!target) { await say('⚠️ Esa persona todavía no está en el sistema.'); return; }
          await say(fichaPersona(target));
          break;
        }
        case 'equipo': {
          const uid = extractMention(parts[1] || '');
          if (!uid) { await say(txt.errores.faltaMencion); return; }
          const equipo = parts.slice(2).join(' ').trim();
          if (!equipo) { await say('⚠️ Uso: `admin equipo @user NombreEquipo` (o `-` para sacarlo del equipo)'); return; }
          await ensureUser(client, uid);
          db.setEquipo(uid, equipo === '-' ? null : equipo);
          await say(equipo === '-'
            ? `✅ *${db.getUser(uid)?.nombre || uid}* quedó sin equipo.`
            : `✅ *${db.getUser(uid)?.nombre || uid}* → equipo *${equipo}*.`);
          break;
        }
        case 'equipos': {
          const users = db.getTracked();
          const grupos = {};
          for (const u of users) (grupos[u.equipo || 'Sin equipo'] ||= []).push(u.nombre);
          const lineas = Object.keys(grupos).sort().map(eq => `*${eq}* (${grupos[eq].length}): ${grupos[eq].join(', ')}`);
          await say(`👥 *Equipos:*\n${lineas.join('\n')}`);
          break;
        }

        // ─── Proyectos (time tracking interno) ────────────────────
        case 'proyecto': {
          const sub = (parts[1] || '').toLowerCase();
          const resto = parts.slice(2).join(' ').trim();
          if (!['agregar', 'sacar'].includes(sub) || !resto) {
            await say('⚠️ Uso: `admin proyecto agregar Cliente / Proyecto` (sin `/` queda sin cliente, ej. Interno) · `admin proyecto sacar Nombre`');
            return;
          }
          if (sub === 'agregar') {
            // Acepta varias líneas de una: "Cliente / Proyecto" por línea.
            // La barra separa cliente de proyecto; sin barra, sin cliente.
            const bloque = (texto || '').replace(/^\s*proyecto\s+agregar\s*/i, '');
            const lineas = bloque.split('\n').map(s => s.trim()).filter(Boolean);
            if (!lineas.length) { await say('⚠️ Uso: `admin proyecto agregar Cliente / Proyecto` (una o varias líneas).'); return; }
            const resultados = [];
            for (const linea of lineas) {
              const [cliente, nombre] = linea.includes('/')
                ? linea.split('/').map(s => s.trim())
                : [null, linea];
              if (!nombre) { resultados.push(`⚠️ Línea inválida: \`${linea}\``); continue; }
              const r = db.crearProyecto(nombre, cliente);
              const etiqueta = r.proyecto.cliente ? `*${r.proyecto.cliente} / ${r.proyecto.nombre}*` : `*${r.proyecto.nombre}*`;
              const icono = { creado: '✅', reactivado: '♻️', ya_existe: 'ℹ️' }[r.estado];
              resultados.push(`${icono} ${etiqueta}${r.estado === 'ya_existe' ? ' (ya existía)' : ''}`);
            }
            await say(lineas.length === 1 ? resultados[0] : `🗂️ *Catálogo cargado:*\n${resultados.join('\n')}`);
          } else {
            const proyecto = buscarProyecto(resto);
            if (!proyecto) { await say(`⚠️ No encontré el proyecto *${resto}*.`); return; }
            db.archivarProyecto(proyecto.id);
            await say(`📦 Proyecto *${proyecto.nombre}* archivado (las horas ya imputadas se conservan en los reportes).`);
          }
          break;
        }
        case 'proyectos': case 'clientes': {
          const activos = db.getProyectos(true);
          if (!activos.length) { await say('🗂️ No hay proyectos. Creá el primero: `admin proyecto agregar Cliente / Proyecto`'); return; }
          const horas = db.horasPorProyecto(t.monthStart(), t.today());
          const grupos = {};
          for (const p of activos) (grupos[p.cliente || 'Sin cliente'] ||= []).push(p);
          const bloques = Object.keys(grupos).sort().map(cli => {
            const lineas = grupos[cli].map(p => {
              const h = horas.find(x => x.nombre === p.nombre);
              return `  • ${p.nombre}${h ? ` — ${h.horas}hs este mes (${h.personas} persona${h.personas > 1 ? 's' : ''})` : ''}`;
            });
            const subtotal = Math.round(grupos[cli].reduce((s, p) => s + (horas.find(x => x.nombre === p.nombre)?.horas || 0), 0) * 10) / 10;
            return `*${cli}*${subtotal ? ` — ${subtotal}hs este mes` : ''}\n${lineas.join('\n')}`;
          });
          await say(`🗂️ *Proyectos activos:*\n${bloques.join('\n')}`);
          break;
        }

        // ─── Novedades ────────────────────────────────────────────
        case 'feriado': {
          // Acepta varias líneas de una: "FECHA Motivo" por línea
          const bloque = (texto || '').replace(/^\s*feriado\s*/i, '');
          const lineas = bloque.split('\n').map(s => s.trim()).filter(Boolean);
          if (!lineas.length) { await say('⚠️ Uso: `admin feriado YYYY-MM-DD Motivo` (una o varias líneas).'); return; }
          const resultados = [];
          for (const linea of lineas) {
            const [fecha, ...motivoArr] = linea.split(/\s+/);
            if (!t.isValidDate(fecha)) { resultados.push(`⚠️ Fecha inválida: \`${linea}\``); continue; }
            if (db.isFeriado(fecha)) { resultados.push(`ℹ️ ${fecha} ya estaba cargado`); continue; }
            db.addNovedad(null, 'feriado', fecha, motivoArr.join(' ') || 'Feriado', adminId);
            resultados.push(`🏖️ ${fecha} — ${motivoArr.join(' ') || 'Feriado'}`);
          }
          await say(lineas.length === 1 ? `${resultados[0]} (aplica a todos).` : `📅 *Feriados cargados:*\n${resultados.join('\n')}`);
          break;
        }
        case 'feriados': {
          const feriados = db.getFeriados(t.today());
          if (!feriados.length) { await say('📅 No hay feriados cargados de hoy en adelante.'); return; }
          const lineas = feriados.map(f => `• \`${f.fecha}\` (${t.dayjs(f.fecha).format('ddd')}) — ${f.motivo || 'Feriado'}`);
          await say(`🗓️ *Feriados cargados (${feriados.length}):*\n${lineas.join('\n')}`);
          break;
        }
        case 'vacaciones': {
          const uid = extractMention(parts[1] || '');
          const desde = parts[2], hasta = parts[3] || parts[2];
          if (!uid) { await say(txt.errores.faltaMencion); return; }
          if (!t.isValidDate(desde) || !t.isValidDate(hasta)) { await say(txt.errores.fechaInvalida); return; }
          await ensureUser(client, uid);
          // Un registro por día hábil
          let d = t.dayjs(desde); const end = t.dayjs(hasta); let count = 0;
          while (d.isBefore(end) || d.isSame(end, 'day')) {
            const ds = d.format('YYYY-MM-DD');
            if (t.isWeekday(ds)) { db.addNovedad(uid, 'vacaciones', ds, 'Vacaciones', adminId); count++; }
            d = d.add(1, 'day');
          }
          await say(`✈️ Vacaciones de *${db.getUser(uid)?.nombre || uid}*: ${count} días hábiles (${desde} a ${hasta}).`);
          break;
        }
        case 'medico': {
          const r = await novedadPersonal('medico', { defaultMotivo: 'Turno médico' });
          if (r) await say(`🏥 Médico: *${r.nombre}* — ${r.fecha} — ${r.motivo}`);
          break;
        }
        case 'ausente': {
          const r = await novedadPersonal('ausente', { defaultMotivo: 'Ausencia' });
          if (r) await say(`❌ Ausente: *${r.nombre}* — ${r.fecha} — ${r.motivo}`);
          break;
        }
        case 'libre': {
          const r = await novedadPersonal('libre', { defaultMotivo: 'Día libre' });
          if (r) await say(`📅 Libre: *${r.nombre}* — ${r.fecha}`);
          break;
        }
        case 'salida': {
          const r = await novedadPersonal('salida', { defaultMotivo: 'Salida autorizada' });
          if (r) await say(`🕐 Salida autorizada: *${r.nombre}* — ${r.fecha} — ${r.motivo}`);
          break;
        }
        case 'remoto': {
          const r = await novedadPersonal('remoto', { defaultMotivo: 'Fichaje remoto autorizado' });
          if (r) await say(`📱 *${r.nombre}* puede fichar desde el celular el ${r.fecha}. Queda diferenciado en los reportes.`);
          break;
        }

        // ─── Monitoreo ────────────────────────────────────────────
        case 'ping': {
          const uid = extractMention(parts[1] || '');
          if (!uid) { await say(txt.errores.faltaMencion); return; }
          const dias = Math.min(30, Math.max(1, parseInt(parts[2] || '1', 10) || 1));
          const desde = t.today();
          const hasta = t.dayjs(desde).add(dias - 1, 'day').format('YYYY-MM-DD');
          await ensureUser(client, uid);
          db.addPingModo(uid, desde, hasta, adminId);
          // La persona SIEMPRE es notificada de que el modo está activo
          await client.chat.postMessage({ channel: uid, text: txt.pings.aviso(t.fmtDate(desde), t.fmtDate(hasta)) });
          await say(`🏓 Chequeos de actividad activados para *${db.getUser(uid)?.nombre || uid}* por ${dias} día${dias > 1 ? 's' : ''}. Ya fue notificado/a.`);
          break;
        }
        case 'novedades': {
          const fecha = t.isValidDate(parts[1]) ? parts[1] : t.today();
          const nov = db.getNovedadesFecha(fecha);
          if (!nov.length) { await say(`Sin novedades para ${fecha}.`); return; }
          const lineas = nov.map(n => `• ${txt.NOVEDADES[n.tipo] || n.tipo}: ${n.nombre || 'Todos'}${n.motivo ? ` — ${n.motivo}` : ''}`);
          await say(`📋 *Novedades ${fecha}:*\n${lineas.join('\n')}`);
          break;
        }
        case 'actividad': {
          const pings = db.pingSummary(t.weekStart(), t.today());
          if (!pings.length) { await say('🏓 Sin pings dirigidos esta semana.'); return; }
          const lineas = pings.map(p => `• *${p.nombre}* — ${p.ok}/${p.enviados} respondidos${p.perdidos ? `, ${p.perdidos} perdidos` : ''}${p.prom_seg != null ? ` (prom. ${p.prom_seg}s)` : ''}`);
          await say(`🏓 *Pings de actividad (semana):*\n${lineas.join('\n')}`);
          break;
        }
        case 'presencia': {
          const pres = db.presenciaSummary(t.weekStart(), t.today());
          if (!pres.length) { await say('👁️ Sin datos de presencia esta semana.'); return; }
          const lineas = pres.map(p => `• *${p.nombre}* — ${p.pct}% activo (${p.activos}/${p.checks} checks)`);
          await say(`👁️ *Presencia Slack (semana):*\n${lineas.join('\n')}`);
          break;
        }

        // ─── Reportes ─────────────────────────────────────────────
        case 'reporte': {
          const rango = (parts[1] || 'hoy').toLowerCase();
          if (rango === 'hoy') { await say(resumenDiario(t.today())); return; }
          if (rango === 'semana') { await say(reportePersonas('📊 *Reporte semanal*', t.weekStart(), t.today())); return; }
          if (rango === 'mes') { await say(reportePersonas('📊 *Reporte mensual*', t.monthStart(), t.today())); return; }
          if (rango === 'ejecutivo') { await say(resumenEjecutivo() || '_Sin datos de la semana pasada._'); return; }
          if (rango === 'proyectos') {
            const sub = (parts[2] || 'semana').toLowerCase();
            const from = sub === 'mes' ? t.monthStart() : t.weekStart();
            await say(reporteProyectos(`🗂️ *Horas por proyecto (${sub === 'mes' ? 'mes' : 'semana'})*`, from, t.today()));
            return;
          }
          await say('⚠️ Uso: `reporte hoy` · `reporte semana` · `reporte mes` · `reporte ejecutivo` · `reporte proyectos [semana|mes]`');
          break;
        }
        case 'export': {
          await say('📦 Generando Excel… te lo mando por DM.');
          const from = t.monthStart(), to = t.today();
          const filepath = await generarExcel(from, to, t.now().format('YYYY-MM'));
          await client.files.uploadV2({
            channel_id: (await client.conversations.open({ users: adminId })).channel.id,
            file: fs.readFileSync(filepath),
            filename: filepath.split('/').pop(),
            title: `Asistencia ${t.fmtRange(from, to)}`,
          });
          break;
        }

        default:
          await say(txt.errores.comandoDesconocido);
      }
    } catch (err) {
      console.error('[admin] Error:', err);
      try { await say(`❌ Error: ${err.message}`); } catch (_) {}
    }
};

/** Garantiza que el usuario exista en la DB con su nombre real */
const ensureUser = async (client, slackId) => {
  if (db.getUser(slackId)) return;
  let nombre = slackId;
  try {
    const info = await client.users.info({ user: slackId });
    nombre = info.user.profile?.real_name || info.user.real_name || info.user.name || slackId;
  } catch (_) { /* sin scope users:read — se actualiza en el primer /marcar */ }
  db.upsertUser(slackId, nombre);
};

module.exports = { handleAdmin };
