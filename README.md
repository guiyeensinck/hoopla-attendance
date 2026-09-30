# ⚡ Hoopla Asistencia

App de Slack para el registro de asistencia del equipo (~32 personas): entrada, almuerzo y salida con verificación desde computadora, horarios individuales, cierre automático del día, reportes automáticos y dashboard web.

**Stack**: Node.js · @slack/bolt (HTTP mode con ExpressReceiver) · SQLite (better-sqlite3) · Express · node-cron · exceljs. Timezone forzado: `America/Argentina/Buenos_Aires`.

---

## Cómo funciona

### Horarios por persona
Cada persona tiene **su** horario de entrada, salida y carga horaria (default 9:30–18:30, 8hs). **Los viernes todos salen a las 17:30** (quien sale antes mantiene su horario) y se esperan las horas que correspondan (9:30–18:30 → 7hs el viernes); el balance semanal, el saldo del mes y los reportes ya lo contemplan. El admin los carga escribiéndole al bot `admin horario @user HH:MM HH:MM Nhs`. Todos los cálculos (llegada tarde, salida anticipada, balance, auto-cierre, recordatorios) usan el horario individual.

### Interacción: el bot es "un compañero más"
Cada persona abre el DM del bot (aparece en su sidebar desde el onboarding) y **le escribe como a un colega**: `marcar`, `horarios`, `cargar`, o cualquier cosa — el bot contesta con un menú de botones. También hay **comandos `/`** que funcionan desde cualquier canal y responden de forma efímera (solo los ve quien los escribe): `/ayuda`, `/marcar`, `/cargar`, `/horarios`, `/proyectos`, `/misemana` y `/admin` (admins).

### Marcaciones
4 por día: **entrada → inicio almuerzo → fin almuerzo → salida**. Horas trabajadas = salida − entrada − almuerzo.

- Escribirle **`marcar`** al bot (o tocar el botón del menú) responde con un **link de un solo uso que expira en 5 minutos**. Al registrar en la web, el bot confirma por DM — todo el historial del día queda en la conversación.
- **Tolerancia de 10 minutos** sobre el horario personal: con horario 9:30–18:30, la entrada cuenta como tarde recién después de las 9:40 y la salida es "en horario" desde las 18:20. El almuerzo esperado es de 1 hora (misma tolerancia). Aplica también retroactivamente a los registros históricos.
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

### Cierre del día
A su horario de salida (viernes 17:30) el bot le pregunta a cada persona **"¿Terminaste?"** con dos botones:
- **✅ Terminé** → registra la salida con hora del servidor.
- **💪 Sigo trabajando** → la jornada sigue y el bot **vuelve a preguntar cada 20 minutos**. Las horas extra suman al balance.
- **Sin respuesta en 3 minutos** → cierre automático en la **última actividad en Slack**: último check de presencia "activo" o último mensaje/reacción en un canal (la interacción con el bot y las marcaciones **no** cuentan). Nunca pasa de la hora de la pregunta que quedó sin responder. Si había dicho "sigo", su última respuesta es el piso. Sin ninguna señal ese día, se estampa su horario.
- Si la salida quedó después de las 14:00 y falta el almuerzo, se imputa 13:00–14:00.
- A las 23:50 se cierra cualquier jornada que siga abierta.

**Reclamos**: el auto-cierre ya **no se corrige solo**. El mensaje de cierre trae el botón **🙋 Estaba trabajando**: la persona elige hasta qué hora trabajó y por qué (ej. una reunión sin tocar la compu). El reclamo llega al canal admin con **Aprobar / Rechazar**; si se aprueba, la salida pasa a esa hora y el valor original queda loggeado.

> Premia al que trabaja: el que se queda suma horas extra con evidencia y el que se fue antes queda registrado a la hora en que dejó de usar Slack. La presencia de Slack no distingue compu de celular y se apaga tras ~10 min de inactividad; por eso existe el reclamo.

### Actividad en Slack y pings
- **Presencia Slack** (active/away): cada **2 minutos entre las 07:00 y las 23:00** de días hábiles, también fuera del horario, para ver cuándo arranca y termina de verdad la actividad (la entrada igual se marca siempre). Para el % de presencia de reportes y patrones solo cuentan los checks dentro del horario.
- **Mensajes y reacciones en canales** donde está el bot: se guarda **solo la hora** (nunca el contenido). `admin canales` suma el bot a todos los canales públicos; a los privados hay que invitarlo a mano. Los DMs entre personas no son visibles para el bot.
- `admin actividad @user [FECHA]`: primera y última señal del día, tramos activos y comparación con lo que marcó.
- **Pings de actividad** ("Acá estoy", timeout 10 min): **no son régimen general**. Solo se activan con `admin ping @user [días]` para una persona puntual, que **es notificada** de que el modo está activo. Se registra respuesta, tiempo de respuesta o ping perdido.

### Recordatorios automáticos (relativos al horario personal)
Los recordatorios a la persona se repiten **cada 10 minutos** hasta que marca (umbrales ajustables en `CFG` de `src/scheduler.js`). Respetan feriados/vacaciones/ausencias/novedades y solo aplican a personas trackeadas.

| Cuándo | Qué |
|---|---|
| Entrada personal +10' | DM cada 10' hasta que marque entrada (tope: 90 minutos) |
| Entrada personal +60 min | Alerta al canal admin con faltantes (una vez) |
| 13:30 a 15:00 | DM cada 10' si no marcó el inicio del almuerzo |
| Inicio almuerzo +60' | DM cada 10' si no marcó el fin del almuerzo (tope: 1 hora) |
| Horario de salida (viernes 17:30) | "¿Terminaste?" con **Terminé / Sigo trabajando**; sin respuesta en **3'** → auto-cierre por última actividad en Slack; "sigo" → repregunta cada **20'** |
| 19:00 | Resumen diario **por excepción**: solo anomalías (tardes, ausencias sin novedad, auto-cierres, intentos mobile). Si no hay: "Sin novedades, N presentes" |
| 19:00 | **Patrones detectados** (solo si hay nuevos): ver sección siguiente |
| Lunes 09:00 | **Resumen ejecutivo**: semana pasada en números + desvíos + novedades de esta semana |
| Viernes 18:00 | Reporte semanal: por persona (agrupado por equipo), horas vs esperadas, tardes, auto-cierres |
| 1ro de cada mes 09:00 | Reporte mensual + Excel al canal (3 hojas: detalle diario, resumen por persona, novedades) |

### Management por excepción (para dirección)
- **Detección de patrones** (con el resumen de las 19:00, cada patrón se avisa 1 vez por semana por persona, analizando los últimos 10 días hábiles): ⏰ 3+ llegadas tarde de ≥10 min · 🔒 3+ auto-cierres (no marca salida) · 📉 saldo mensual ≤ −4hs · 👻 fichó pero presencia en Slack <30% en 3+ días (con datos suficientes). Umbrales ajustables en `src/patrones.js`.
- **Ficha de persona** (`admin persona @user`): últimos 10 días hábiles — horas vs esperadas, entrada promedio, tardes, auto-cierres, % presencia, saldo del mes y novedades. Contexto instantáneo para una 1:1.
- **Banco de horas**: saldo mensual acumulado por persona (trabajadas − esperadas del 1° a hoy). Cada persona ve el suyo en `horarios`; el admin lo ve en la ficha y en los patrones.
- **Equipos** (`admin equipo @user Nombre`): los reportes semanal/mensual y el resumen ejecutivo agrupan y totalizan por equipo; el dashboard muestra el equipo en el roster.

### Modo "solo proyectos"
`admin soloproyectos @user` exime a una persona de toda la asistencia (sin marcaciones, recordatorios, presencia ni patrones — tampoco cuenta en faltantes ni reportes de horas) pero **sí carga horas de proyectos**: el bot le pregunta cada día a su horario de salida y puede imputar cuando quiera. Ideal para freelancers o socios. Se revierte con `admin completo @user`. El dashboard la muestra con badge "Solo proyectos".

### Qué se le puede escribir al bot (todo por DM)

**Para todos** (también como comandos `/` desde cualquier canal: `/ayuda`, `/marcar`, `/cargar`, `/horarios`, `/proyectos`, `/misemana`):
- `/ayuda` — explica cómo funciona todo
- `marcar` (también `entrada`, `salida`, `almuerzo`, `fichar`) — link para registrar la próxima marcación
- `horarios` (también `estado`, `semana`, `balance`) — estado de hoy + balance semanal propio
- `proyectos` — proyectos activos + lo imputado hoy y esta semana
- `cargar` (o `/cargar`) — abre "¿En qué marcas trabajaste?" (marcas + %)
- `Nike 4 redes, Interno 2` — imputa el día a proyectos (pares nombre + horas; la categoría de trabajo es opcional: campaña, redes, website, branding, btl, ajustes, otro)
- Cualquier otra cosa → menú con botones **Marcar** y **Mi semana**

**Admin (`admin ...`, siempre con @mención, nunca nombre tipeado):**
- `admin agregarme` · `admin agregartodos` · `admin agregar @user` · `admin sacar @user`
- `admin admin @user` — solo super admins de `ADMIN_USER_IDS`
- `admin horario @user HH:MM HH:MM Nhs`
- `admin persona @user` — ficha completa de una persona
- `admin equipo @user Nombre` (o `-` para sacarlo) · `admin equipos`
- `admin soloproyectos @user` / `admin completo @user` — modo sin asistencia, solo horas de proyectos
- `admin proyecto agregar Cliente / Proyecto` (acepta varias líneas de una) · `admin proyecto sacar Nombre` · `admin proyectos`
- `admin reporte proyectos [semana|mes]`
- `admin feriado FECHA Motivo` (aplica a todos)
- `admin vacaciones @user DESDE HASTA` (un registro por día hábil)
- `admin medico @user FECHA Motivo` · `admin ausente @user FECHA Motivo` · `admin libre @user FECHA` · `admin salida @user FECHA Motivo`
- `admin remoto @user FECHA`
- `admin ping @user [días]`
- `admin novedades [FECHA]` · `admin actividad` (pings) · `admin presencia`
- `admin actividad @user [FECHA]` — actividad en Slack del día vs. lo que marcó · `admin canales` — sumar el bot a los canales públicos
- `admin probar ...` — pruebas sobre vos mismo (ver *Cómo probar*)
- `admin reporte hoy` · `admin reporte semana` · `admin reporte mes` · `admin reporte ejecutivo` · `admin export` (Excel por DM)

`admin` solo (sin argumentos) muestra la lista completa.

Al agregar a alguien al tracking, recibe un **DM de onboarding**: qué registra el sistema, qué ve el admin, cómo marcar, su horario, cómo se cierra el día y cómo avisar ausencias.

### Time tracking por proyectos (interno)
El admin mantiene el catálogo (`admin proyecto agregar Cliente / Proyecto` — sin `/` queda sin cliente, ej. Interno).

**"¿En qué marcas trabajaste?"** — al registrar la **salida** (web, botón o auto-cierre) el bot manda el botón **🗂️ Cargar mi día**, que abre un modal de Slack:
1. Selección múltiple de **marcas** (= clientes; un proyecto sin cliente como Interno o Pitch es su propia marca).
2. Al elegirlas aparece un **%** por marca, repartido en partes iguales. Se ajusta y tiene que sumar 100%.
3. Las horas salen del % × las horas trabajadas del día (si la jornada no cerró, la carga del día). Guardar reemplaza lo imputado ese día. Si una marca tiene varios proyectos, las horas van a un proyecto general con el nombre del cliente, así que los reportes por cliente no cambian.

Se abre también con `/cargar`, escribiendo `cargar` o desde el menú. El modo por texto sigue funcionando para quien lo prefiera — la persona responde en el mismo DM con lenguaje natural:

```
2 horas Jumbo, 30 minutos Coral, 1/2 hora en Pitch, el resto en Interno
```

- El parser entiende horas ("2", "2.5", "2,5", "hora y media", "media hora"), minutos ("30 minutos"), fracciones ("1/2 hora"), preposiciones ("en", "de"), el formato corto (`Jumbo 3 redes, Interno 2`) y **"el resto en X"** (completa hasta las horas del día). También matchea nombres aproximados: cliente ("autopistas"), typos ("junbo"), espacios ("red bull" → Redbull) y apodos ("hoopla" → Interno, "nuevos negocios" → Pitch).
- Si no puede matchear algo, **no guarda nada y pregunta** mostrando los candidatos posibles y el catálogo completo.
- Alternativa con clicks: el botón **"🖱️ Cargar con clicks"** (en el prompt de salida y en `proyectos`) manda un link de un solo uso (30 min) a `/imputar/:token`, un formulario con selects de proyecto + categoría + horas, filas agregables y total en vivo. Anda desde el celular.
- **"Mi semana en proyectos"**: cada persona puede ver su detalle (día por día, totales de semana y mes con barras) en una web personal `/misemana/:token` — se pide por DM escribiendo `mi semana` (o `mis horas`, `en qué trabajé`) o con el botón "📊 Mi semana en proyectos" que acompaña a `proyectos`. El link dura 30 min y se puede refrescar.
- **Gestión web del catálogo** (admins): en `/dashboard/proyectos` se pueden crear, editar (cliente y nombre inline, las horas siguen al proyecto), archivar y reactivar proyectos. `admin proyectos` por DM incluye el link directo.

### Modo conversacional (opcional)
Con `ANTHROPIC_API_KEY` (Claude, default Haiku 4.5) u `OPENAI_API_KEY` (ChatGPT, default gpt-4o-mini) — si están las dos gana Claude; modelo configurable con `IA_MODEL` — **se le puede hablar al bot en lenguaje natural y actúa**:
- Tiene herramientas que ejecutan lo mismo que los comandos. Para todos: mandar el link de marcar, mostrar el estado, cargar marcas, imputar horas por texto, proyectos, reclamar un cierre y ayuda. Ej: *"llegué, anotame la entrada"*, *"¿cuánto me falta esta semana?"*, *"hoy estuve toda la tarde en Jumbo y 2hs en Coral"*.
- **Admins**: además ejecuta cualquier `admin ...` y busca personas por nombre en el workspace para resolver el @. Ej: *"agregá a Ana y a Juan"*, *"Martina está de vacaciones del 5 al 16 de octubre"*, *"¿quién no marcó hoy?"*. Si falta un dato, pregunta; antes de acciones masivas o difíciles de deshacer (sacar, agregar a todos, feriados, reset) pide confirmación. Funciona también para admins que no están en el seguimiento.
- Recibe el contexto real de la persona (marcaciones, horas, saldo, imputaciones) y el historial reciente del DM para mantener el hilo. Una persona que no es admin nunca puede ejecutar gestión (se valida en el servidor, no solo en el prompt).
- Con IA activa, las palabras clave (`marcar`, `horarios`...) solo atajan mensajes cortos (hasta 3 palabras) y una imputación por texto solo se guarda directo si se entiende completa; el resto va a la charla. `admin ...` explícito siempre va directo.
- Sin la variable o ante un error de la API, cae al menú de siempre.

### Evaluación, ausencias y vacaciones (dashboard)
- **Registros → filtrar por persona** muestra su evaluación de asistencia: semana, mes y acumulado, con semáforo (🟢 ≥85% · 🟡 ≥65% · 🔴) según % de días OK (puntual + salida en horario + almuerzo ≤1h, tolerancia 10'). Detalla tardes, salidas anticipadas, almuerzos largos, auto-cierres, días sin aviso y ausencias injustificadas. Solo cuenta días hábiles ya cerrados; justificadas y vacaciones no penalizan.
- **Pestaña Ausencias**: carga de vacaciones/ausencias (justificada o no)/médico/libre/salida/remoto por persona con fecha de inicio y cantidad de días; lista lo cargado del mes en adelante agrupado en rangos, con borrado.
- **Vacaciones**: se cargan en días **corridos** (cuentan findes) y arrancan lunes (avisa si no). Cada persona tiene sus días anuales configurables (default 21 = 14 verano + 7 invierno); el panel muestra corresponden / cargados / tomados / quedan y las próximas fechas de cada uno. `admin vacaciones @user DESDE HASTA` por DM también cuenta corridos.
- **Carga incremental durante el día**: escribiendo `cargar` (o `terminé`, `imputar`) el bot manda el link del formulario en cualquier momento — lo ya cargado aparece precargado y se suman filas; el formulario tiene selector de día (hoy / último día hábil). Por texto también suma: `Coral 1` se agrega a lo que llevabas, repetir un proyecto corrige su valor y `el resto en X` completa contra lo acumulado. Para rehacer el día entero: la web. Al cierre, si la carga quedó incompleta el bot avisa cuántas horas faltan.
- La imputación se ancla a las horas reales del día (avisa si no coinciden). Cada par acepta una **categoría de trabajo** opcional (campaña, redes, website, branding, btl, ajustes, otro): `Jumbo 3 redes, Jumbo 2 campaña`.
- El destino de la carga es **hoy** siempre que la jornada de hoy haya arrancado; solo va al último día hábil (con aviso bien visible) si todavía no marcaste entrada y ese día quedó sin imputar. Los prefijos `hoy:` y `ayer:` fuerzan el día (`ayer: Jumbo 2, Coral 1`); el formulario web tiene selector de día.
- `proyectos` (por DM) muestra los activos y lo imputado hoy/esta semana.
- Para el admin: `admin proyectos` (horas del mes agrupadas por cliente), `admin reporte proyectos [semana|mes]` (cliente → proyecto → persona, con % por cliente), línea "Por cliente" en el resumen ejecutivo y hoja *Proyectos* en el Excel mensual.
- `admin proyecto sacar Nombre` archiva (deja de ofrecerse; las horas históricas se conservan).

### Dashboard web (`/dashboard`)
- **Hoy**: presentes, faltantes, jornada completa, horas del equipo.
- **Registros**: histórico filtrable por fecha y persona.
- **Proyectos**: horas por cliente (con % del total), por proyecto (con quiénes) y por categoría de trabajo, filtrable por fecha.
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
| `SOLO_MODE` / `SOLO_USER_ID` | — | `true` = beta cerrada: solo responde a esos IDs (varios separados por coma); los mensajes de canal van al DM del primero |
| `DASHBOARD_TOKEN` | — | Si se setea, el dashboard pide esta clave |

---

## Configuración en api.slack.com (paso a paso)

1. **Crear la app**: [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From scratch* → nombre `Hoopla Asistencia` → elegir workspace.

2. **Manifest (recomendado)**: en *App Manifest* pegá [`slack-manifest.yml`](slack-manifest.yml) reemplazando `TU-DOMINIO` por tu dominio → *Save* → **reinstalar la app** (hay scopes nuevos) y actualizar `SLACK_BOT_TOKEN` si cambió. Eso configura de una los scopes, eventos, interactividad y comandos `/`. Si preferís hacerlo a mano, los pasos 2b–4 hacen lo mismo.

2b. **Scopes** (*OAuth & Permissions → Bot Token Scopes*):
   ```
   chat:write        (mensajes y DMs)
   im:history        (leer lo que la gente le escribe al bot por DM)
   users:read        (nombres y presencia active/away)
   files:write       (subir el Excel mensual)
   im:write          (abrir DMs para el export)
   commands          (comandos /ayuda, /marcar, /cargar, ...)
   channels:history  (hora de mensajes en canales públicos → actividad)
   groups:history    (ídem en canales privados donde esté el bot)
   reactions:read    (hora de reacciones → actividad)
   channels:read + channels:join   (admin canales)
   ```
   > `channels:history` le da al bot acceso técnico al contenido de los mensajes; la app **solo guarda la hora**. Conviene comunicarlo al equipo (el onboarding ya lo explica).

3. **Event Subscriptions**: activar, Request URL `https://TU-DOMINIO/slack/events`, y en *Subscribe to bot events* agregar:
   ```
   message.im        (mensajes directos al bot)
   message.channels  (actividad en canales públicos)
   message.groups    (actividad en canales privados)
   reaction_added    (actividad por reacciones)
   ```

3b. **Slash Commands**: crear `/ayuda`, `/marcar`, `/cargar`, `/horarios`, `/proyectos`, `/misemana` y `/admin`, todos con Request URL `https://TU-DOMINIO/slack/events` (en `/admin` tildar *Escape channels, users, and links*).

4. **Interactivity** (*Interactivity & Shortcuts*): activar y poner Request URL `https://TU-DOMINIO/slack/events` (botones, modales de marcas y reclamos).

5. **App Home** (*App Home*): en *Show Tabs*, activar **Messages Tab** y tildar *"Allow users to send Slash commands and messages from the messages tab"* — sin esto la gente no puede escribirle al bot. La pestaña Home puede quedar desactivada (no se usa).

6. **Presentación** (*Basic Information → Display Information*): nombre visible, ícono y descripción — es lo que el equipo ve en el DM, conviene que parezca "un compañero" (ej: nombre `Asistencia`, foto con onda).

7. **Instalar**: *Install App → Install to Workspace* → copiar el **Bot User OAuth Token** (`xoxb-...`).
   > Si después agregás scopes, hay que **reinstalar** la app y actualizar el token.

8. **Invitar al bot al canal admin**: en `#asistencia` (o el que uses): `/invite @Hoopla Asistencia`.

9. **Actividad en canales**: escribile `admin canales` al bot para que se sume a todos los canales públicos (los privados: `/invite @Asistencia`).

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

## Cómo probar

Todo se puede probar sobre vos mismo, en producción, sin afectar al equipo. Tenés que estar trackeado (`admin agregarme`):

| Comando | Qué hace |
|---|---|
| `admin probar cierre` | Tu salida de hoy pasa a ser **ahora**: llega el "¿terminaste?" al instante (también finde/feriado). Si no marcaste entrada, crea una de prueba 1h atrás |
| `admin probar cierre rapido` | Igual, con **1'** para contestar y "sigo" cada **2'** |
| `admin probar actividad [FECHA]` | Tu actividad en Slack registrada y a qué hora cerraría el día ahora |
| `admin probar imputar` | Te manda el "¿en qué marcas trabajaste?" (modal) |
| `admin probar horario` | Tu horario efectivo de hoy y del viernes |
| `admin probar reset` | Borra **todo tu día de hoy** (marcaciones, cierre, imputaciones, reclamos) para repetir |
| `admin probar fin` | Sale del modo prueba sin borrar nada |

Recorrido sugerido: `admin probar cierre rapido` → tocá **Sigo trabajando** → mandá un mensaje en algún canal → esperá la repregunta y no contestes → mirá `admin probar actividad` → tocá **🙋 Estaba trabajando** y aprobalo desde el canal admin → `admin probar reset`. Los comandos `/` se prueban escribiéndolos en cualquier canal.

> El modo prueba vive en memoria: un redeploy lo apaga (los registros quedan hasta el `reset`).

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
├── app.js           # Bolt + DMs + comandos / + botones (menú, cierre, reclamos, pings) + modales
├── dmrouter.js      # Interpreta lo que la gente le escribe al bot (marcar/horarios/admin)
├── admin.js         # Mensajes "admin ..." (personas, novedades, monitoreo, reportes, export)
├── database.js      # Schema SQLite + queries (users, registros, tokens, novedades,
│                    #   presencia, pings, cierres, intentos_mobile)
├── scheduler.js     # Motor por minuto (horarios personales, cierre "¿terminaste?") + crons fijos
├── activity.js      # Presencia cada 2 min + actividad en canales + pings dirigidos
├── marcas.js        # Modal "¿en qué marcas trabajaste?" (marcas + %)
├── pruebas.js       # Modo prueba por persona (admin probar ...)
├── balance.js       # Balance semanal individual (semáforo, compensación)
├── web.js           # Páginas /verify/:token (marcación) e /imputar/:token (form de horas)
├── dashboard.js     # Dashboard web (Hoy, Registros, Actividad, Usuarios)
├── excel.js         # Export Excel (3 hojas)
├── reports.js       # Resumen diario por excepción + reporte por persona
├── onboarding.js    # Alta al tracking + DM explicativo
├── verification.js  # Detección de user agent mobile
├── styles.js        # Estilos/layouts compartidos de las páginas web
├── texts.js         # TODOS los textos visibles
└── time.js          # Timezone Buenos Aires + helpers de hora
```
