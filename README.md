# ⚡ Hoopla Asistencia

App de Slack para el registro de asistencia del equipo (~32 personas): entrada, almuerzo y salida con verificación desde computadora, horarios individuales, horas extra aprobadas por admin, reportes automáticos y dashboard web.

**Stack**: Node.js · @slack/bolt (HTTP mode con ExpressReceiver) · SQLite (better-sqlite3) · Express · node-cron · exceljs. Timezone forzado: `America/Argentina/Buenos_Aires`.

---

## Cómo funciona

### Horarios por persona
Cada persona tiene **su** horario de entrada, salida y carga horaria (default 9:30–18:30, 8hs). El admin los carga escribiéndole al bot `admin horario @user HH:MM HH:MM Nhs`. Todos los cálculos (llegada tarde, salida anticipada, balance, auto-cierre, recordatorios) usan el horario individual.

### Interacción: el bot es "un compañero más"
No hay slash commands. Cada persona abre el DM del bot (aparece en su sidebar desde el onboarding) y **le escribe como a un colega**: `marcar`, `horarios`, o cualquier cosa — el bot contesta con un menú de botones. Como no existen comandos, **no hay nada que se pueda tipear en canales ni en el DM propio**: toda la interacción vive en la conversación 1:1 con el bot, y los admins gestionan escribiéndole `admin ...` en ese mismo DM.

### Marcaciones
4 por día: **entrada → inicio almuerzo → fin almuerzo → salida**. Horas trabajadas = salida − entrada − almuerzo.

- Escribirle **`marcar`** al bot (o tocar el botón del menú) responde con un **link de un solo uso que expira en 5 minutos**.
- La página web valida el token y **bloquea user agents mobile** (iOS/Android/patrones comunes). Si es mobile: no registra, muestra "El registro solo puede hacerse desde una computadora" y **loguea el intento** para el reporte admin.
- La hora la pone **siempre el servidor**, nunca el usuario.
- Entrada después del horario personal → flag `tarde_min`. Salida antes → flag `anticipado_min`.

> ⚠️ **La barrera de user agent es disuasoria, no infalible.** Un user agent se puede falsificar desde el navegador. El objetivo es que fichar desde el celular no sea trivial, no hacerlo imposible.

### Excepción mobile
`admin remoto @user FECHA` (por DM al bot) habilita a esa persona a fichar desde el celular ese día. Queda diferenciado en reportes como origen `mobile_remoto`.

### Visibilidad (modelo transparente)
Cada persona ve **su propio estado** — nunca datos de otros:
- Página post-registro: marcaciones del día + desglose semanal con semáforo (🟢🟡🔴) contra su carga horaria + hasta qué hora quedarse si va atrás.
- Escribirle **`horarios`** al bot: el mismo resumen en Slack.
- El balance se resetea **cada lunes**.

### Cierre del día y horas extra
Al horario de salida de cada persona, si no marcó salida, el bot manda DM con dos botones:
- **Marcar salida** → registra con hora del servidor. La salida manual **no se puede cambiar**.
- **Necesito 30 min más** → pedido al canal admin con Aprobar/Rechazar. Aprobado una vez, el bot pregunta "¿Seguís trabajando?" cada 30 minutos **sin nueva aprobación**. Cada bloque queda registrado como horas extra.
- **Sin respuesta en 20 minutos** → salida automática registrada **al horario de salida de la persona** con flag `auto_closed_sin_respuesta` (visible en reportes y dashboard). Si falta el almuerzo, se imputa 13:00–14:00.
- El auto-cierre se puede **corregir una sola vez** escribiéndole `marcar` al bot (el valor original queda loggeado). Si el pedido de extra queda pendiente sin respuesta del admin, la jornada no se auto-cierra (aparece como anomalía en el resumen de las 19:00).

### Presencia y pings
- **Presencia Slack** (active/away): polling cada 15 minutos para cada persona trackeada, solo dentro de su horario laboral. Alimenta el % de presencia en reportes.
- **Pings de actividad** ("Acá estoy", timeout 10 min): **no son régimen general**. Solo se activan con `admin ping @user [días]` para una persona puntual, que **es notificada** de que el modo está activo. Se registra respuesta, tiempo de respuesta o ping perdido.

### Recordatorios automáticos (relativos al horario personal)
| Cuándo | Qué |
|---|---|
| Entrada personal +5 min | DM si no fichó (respeta feriados/vacaciones/ausencias/novedades) |
| Entrada personal +60 min | Alerta al canal admin con faltantes |
| 19:00 | Resumen diario **por excepción**: solo anomalías (tardes, ausencias sin novedad, auto-cierres, intentos mobile, extras). Si no hay: "Sin novedades, N presentes" |
| Viernes 18:00 | Reporte semanal: por persona, horas vs esperadas, tardes, auto-cierres, extras |
| 1ro de cada mes 09:00 | Reporte mensual + Excel al canal (3 hojas: detalle diario, resumen por persona, novedades) |

### Qué se le puede escribir al bot (todo por DM)

**Para todos:**
- `marcar` (también `entrada`, `salida`, `almuerzo`, `fichar`) — link para registrar la próxima marcación
- `horarios` (también `estado`, `semana`, `balance`) — estado de hoy + balance semanal propio
- Cualquier otra cosa → menú con botones **Marcar** y **Mi semana**

**Admin (`admin ...`, siempre con @mención, nunca nombre tipeado):**
- `admin agregarme` · `admin agregartodos` · `admin agregar @user` · `admin sacar @user`
- `admin admin @user` — solo super admins de `ADMIN_USER_IDS`
- `admin horario @user HH:MM HH:MM Nhs`
- `admin feriado FECHA Motivo` (aplica a todos)
- `admin vacaciones @user DESDE HASTA` (un registro por día hábil)
- `admin medico @user FECHA Motivo` · `admin ausente @user FECHA Motivo` · `admin libre @user FECHA` · `admin salida @user FECHA Motivo`
- `admin remoto @user FECHA`
- `admin ping @user [días]`
- `admin novedades [FECHA]` · `admin actividad` · `admin presencia`
- `admin reporte hoy` · `admin reporte semana` · `admin reporte mes` · `admin export` (Excel por DM)

`admin` solo (sin argumentos) muestra la lista completa.

Al agregar a alguien al tracking, recibe un **DM de onboarding**: qué registra el sistema, qué ve el admin, cómo marcar, su horario y cómo pedir extras o avisar ausencias.

### Dashboard web (`/dashboard`)
- **Hoy**: presentes, faltantes, jornada completa, horas del equipo.
- **Registros**: histórico filtrable por fecha y persona.
- **Actividad**: % de presencia Slack por persona; pings solo si hubo modo dirigido.
- **Usuarios**: roster con horario asignado y badges admin/trackeado.

Protegido opcionalmente con `DASHBOARD_TOKEN` (basic auth).

---

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | Token `xoxb-...` (OAuth & Permissions → Bot User OAuth Token) |
| `SLACK_SIGNING_SECRET` | ✅ | Basic Information → App Credentials → Signing Secret |
| `APP_URL` | ✅ | URL pública de la app — los links de marcación apuntan acá |
| `REPORT_CHANNEL` | ✅ | Canal admin (`#asistencia` o ID `C...`). **Invitar al bot al canal.** |
| `ADMIN_USER_IDS` | ✅ | IDs de Slack de los super admins, separados por coma |
| `DB_PATH` | ✅ en Railway | Carpeta de la DB SQLite. En Railway: `/data` (el volumen). Local: default `./data` |
| `PORT` | — | Railway lo inyecta; local default 3000 |
| `SOLO_MODE` / `SOLO_USER_ID` | — | `true` = solo responde a ese usuario y los mensajes de canal van a su DM (pruebas) |
| `DASHBOARD_TOKEN` | — | Si se setea, el dashboard pide esta clave |

---

## Configuración en api.slack.com (paso a paso)

1. **Crear la app**: [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From scratch* → nombre `Hoopla Asistencia` → elegir workspace.

2. **Scopes** (*OAuth & Permissions → Bot Token Scopes*):
   ```
   chat:write        (mensajes y DMs)
   im:history        (leer lo que la gente le escribe al bot por DM)
   users:read        (nombres y presencia active/away)
   files:write       (subir el Excel mensual)
   im:write          (abrir DMs para el export)
   ```
   > **No crear slash commands** (y borrar los que existan de versiones anteriores): toda la interacción es por mensajes de DM.

3. **Event Subscriptions**: activar, Request URL `https://TU-DOMINIO/slack/events`, y en *Subscribe to bot events* agregar:
   ```
   message.im        (mensajes directos al bot)
   ```

4. **Interactivity** (*Interactivity & Shortcuts*): activar y poner Request URL `https://TU-DOMINIO/slack/events` (para los botones de menú, cierre, extras y pings).

5. **App Home** (*App Home*): en *Show Tabs*, activar **Messages Tab** y tildar *"Allow users to send Slash commands and messages from the messages tab"* — sin esto la gente no puede escribirle al bot. La pestaña Home puede quedar desactivada (no se usa).

6. **Presentación** (*Basic Information → Display Information*): nombre visible, ícono y descripción — es lo que el equipo ve en el DM, conviene que parezca "un compañero" (ej: nombre `Asistencia`, foto con onda).

7. **Instalar**: *Install App → Install to Workspace* → copiar el **Bot User OAuth Token** (`xoxb-...`).
   > Si después agregás scopes, hay que **reinstalar** la app y actualizar el token.

8. **Invitar al bot al canal admin**: en `#asistencia` (o el que uses): `/invite @Hoopla Asistencia`.

> Socket Mode **no sirve** para esta app porque también tiene que servir las páginas web de marcación — por eso corre en HTTP mode (`ExpressReceiver`) y todo entra por `POST /slack/events`.
>
> **Nota sobre "AI agents" de Slack**: la app es un bot clásico de DMs, no un "AI agent/assistant" (esa designación es para chatbots con IA conversacional y cambia la UX a un panel de asistente). No hace falta activar nada de eso.

---

## Deploy en Railway

1. **Repo**: pushear a GitHub y en Railway: *New Project → Deploy from GitHub repo*.
2. **Volumen** (crítico — sin esto la DB se borra en cada deploy): en el servicio → *Volumes → Add Volume* → mount path `/data`.
3. **Variables** (*Variables → Raw Editor*):
   ```env
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_SIGNING_SECRET=...
   APP_URL=https://TU-DOMINIO.up.railway.app
   REPORT_CHANNEL=#asistencia
   ADMIN_USER_IDS=U0XXXXXXX
   DB_PATH=/data
   SOLO_MODE=true
   SOLO_USER_ID=U0XXXXXXX
   RAILWAY_RUN_UID=0
   ```
   > `RAILWAY_RUN_UID=0` da permisos de escritura sobre el volumen.
4. **Dominio**: *Settings → Networking → Generate Domain* → usar esa URL en `APP_URL` y en toda la config de Slack (paso a paso de arriba).
5. **Verificar en Logs**: tiene que aparecer `⚡ Hoopla Asistencia — puerto ...` y el detalle de crons. Probar `https://TU-DOMINIO/health` y `/dashboard` en el navegador, y mandarle `hola` al bot por DM en Slack.
6. **Salir a producción**: probar todo con `SOLO_MODE=true`, después cambiar a `SOLO_MODE=false` (Railway redeploya solo) y escribirle `admin agregartodos` al bot.

### Troubleshooting
- **El bot no contesta los DMs** → falta el evento `message.im` en Event Subscriptions, el scope `im:history`, o la Request URL no apunta a `https://TU-DOMINIO/slack/events`. Tras agregar scopes: reinstalar la app y actualizar el token. Con `SOLO_MODE=true` solo contesta a `SOLO_USER_ID`.
- **La DB se vacía tras un deploy** → falta `DB_PATH=/data`, el volumen o `RAILWAY_RUN_UID=0`.
- **No llega el Excel** → falta el scope `files:write` (reinstalar la app tras agregarlo) o el bot no está en el canal.
- **No llegan mensajes al canal** → el bot no fue invitado a `REPORT_CHANNEL`.

---

## Desarrollo local

```bash
npm install
cp .env.example .env   # completar credenciales; DB_PATH puede quedar vacío (usa ./data)
npm run dev
```

Exponer con `ngrok http 3000` y usar `https://xxxx.ngrok.io/slack/events` en la config de Slack.

## Estructura

```
src/
├── app.js           # Bolt + router de DMs + botones (menú, cierre, extras, pings)
├── dmrouter.js      # Interpreta lo que la gente le escribe al bot (marcar/horarios/admin)
├── admin.js         # Mensajes "admin ..." (personas, novedades, monitoreo, reportes, export)
├── database.js      # Schema SQLite + queries (users, registros, tokens, novedades,
│                    #   extras, presencia, pings, cierres, intentos_mobile)
├── scheduler.js     # Motor por minuto (horarios personales) + crons fijos
├── activity.js      # Presencia cada 15 min + pings dirigidos
├── balance.js       # Balance semanal individual (semáforo, compensación)
├── web.js           # Páginas /verify/:token (marcación + resumen post-registro)
├── dashboard.js     # Dashboard web (Hoy, Registros, Actividad, Usuarios)
├── excel.js         # Export Excel (3 hojas)
├── reports.js       # Resumen diario por excepción + reporte por persona
├── onboarding.js    # Alta al tracking + DM explicativo
├── verification.js  # Detección de user agent mobile
├── styles.js        # Estilos/layouts compartidos de las páginas web
├── texts.js         # TODOS los textos visibles
└── time.js          # Timezone Buenos Aires + helpers de hora
```
