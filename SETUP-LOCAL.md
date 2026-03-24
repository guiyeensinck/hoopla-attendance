# 🧪 Guía de prueba local — Hoopla Asistencia

Guía paso a paso para levantar la app en tu máquina y probarla solo con tu usuario.

---

## Paso 1: Requisitos previos

```bash
# Verificar que tengas Node.js 18+
node --version

# Si no lo tenés, instalarlo desde https://nodejs.org
# o con nvm:
nvm install 20
nvm use 20
```

También vas a necesitar [ngrok](https://ngrok.com/) para exponer tu localhost a Slack:

```bash
# macOS
brew install ngrok

# O descargarlo de https://ngrok.com/download
# Crear cuenta gratuita y autenticar:
ngrok config add-authtoken TU_TOKEN_DE_NGROK
```

---

## Paso 2: Crear la Slack App

1. Ir a **https://api.slack.com/apps**
2. Click **Create New App** → **From scratch**
3. Nombre: `Asistencia Test` (o lo que quieras)
4. Workspace: seleccionar tu workspace de Hoopla

### 2a. Bot Token Scopes

Ir a **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, agregar:

```
chat:write          → Para enviar mensajes y reportes
commands            → Para los slash commands
users:read          → Para obtener datos del usuario
```

### 2b. Instalar en workspace

Ir a **Install App** → **Install to Workspace** → Autorizar

Copiar el **Bot User OAuth Token** (empieza con `xoxb-`)

### 2c. Copiar Signing Secret

Ir a **Basic Information** → **App Credentials** → copiar **Signing Secret**

---

## Paso 3: Configurar el proyecto

```bash
cd hoopla-attendance

# Instalar dependencias
npm install

# Crear archivo de entorno
cp .env.example .env
```

Editar `.env`:

```env
SLACK_BOT_TOKEN=xoxb-tu-token-acá
SLACK_SIGNING_SECRET=tu-signing-secret-acá
PORT=3000
REPORT_CHANNEL=#test-asistencia
SOLO_MODE=true
SOLO_USER_ID=TU_SLACK_USER_ID
```

### ¿Cómo encontrar tu Slack User ID?

En Slack desktop:
1. Click en tu foto de perfil (arriba a la derecha)
2. Click en **Profile**
3. Click en los **tres puntos** (⋯)
4. **Copy member ID**

Es algo como `U0ABC1DEF2`

---

## Paso 4: Levantar ngrok

En una terminal aparte:

```bash
ngrok http 3000
```

Te va a dar una URL tipo:
```
https://a1b2c3d4.ngrok-free.app
```

**Copiar esa URL.** La necesitás para el paso siguiente.

> ⚠️ Cada vez que reiniciés ngrok, la URL cambia y tenés que actualizarla en Slack.
> Con plan pago de ngrok podés tener un dominio fijo.

---

## Paso 5: Configurar URLs en Slack

Volver a **https://api.slack.com/apps** → tu app:

### 5a. Slash Commands

Ir a **Slash Commands** → **Create New Command** para cada uno:

| Command        | Request URL                                      | Description                  |
|----------------|--------------------------------------------------|------------------------------|
| `/asistencia`  | `https://TU-URL-NGROK.app/slack/events`          | Registrar asistencia del día |
| `/reporte`     | `https://TU-URL-NGROK.app/slack/events`          | Ver reporte semanal/mensual  |

### 5b. Interactivity

Ir a **Interactivity & Shortcuts**:
- Activar el toggle de **Interactivity**
- Request URL: `https://TU-URL-NGROK.app/slack/events`

### 5c. Event Subscriptions (opcional por ahora)

Ir a **Event Subscriptions**:
- Activar toggle
- Request URL: `https://TU-URL-NGROK.app/slack/events`
- En **Subscribe to bot events**, agregar:
  - `app_home_opened`

---

## Paso 6: Arrancar la app

```bash
npm run dev
```

Deberías ver:

```
[scheduler] Cron jobs configurados:
  → Alerta faltantes: L-V 10:30
  → Recordatorio salida: L-V 18:30
  → Reporte semanal: Viernes 18:00
  → Reporte mensual: 1ro de cada mes 09:00
[dashboard] Available at /dashboard

  ⚡ Hoopla Asistencia running
  → Slack app:   port 3000
  → Dashboard:   http://localhost:3000/dashboard
  → API:         http://localhost:3000/dashboard/api/records
```

---

## Paso 7: Probar

### En Slack

Ir a cualquier canal (o a un DM con vos mismo) y escribir:

```
/asistencia
```

Te debería aparecer el menú interactivo con los dropdowns.

Flujo normal de un día:
1. `/asistencia` → "Registrar ahora" (registra entrada)
2. `/asistencia` → "Registrar ahora" (registra inicio almuerzo)
3. `/asistencia` → "Registrar ahora" (registra fin almuerzo)
4. `/asistencia` → "Registrar ahora" (registra salida)

O seleccionar manualmente el tipo y hora desde los menús.

### Dashboard

Abrir en el navegador: **http://localhost:3000/dashboard**

### Reportes

```
/reporte            → Semanal
/reporte mensual    → Mensual
```

---

## Troubleshooting

### "dispatch_failed" en Slack
→ ngrok no está corriendo, o la URL cambió. Verificar que el túnel esté activo y la URL coincida en la config de Slack.

### "not_authed"
→ Revisar que `SLACK_BOT_TOKEN` en `.env` sea correcto y empiece con `xoxb-`.

### Los dropdowns no responden
→ Verificar que **Interactivity** esté activada con la URL correcta de ngrok.

### El comando no aparece en Slack
→ Puede tardar unos minutos después de crearlo. Probar cerrando y reabriendo Slack.

### Quiero resetear la base de datos
```bash
rm data/attendance.db
npm run dev
# Se recrea automáticamente
```

---

## Tips para la fase de prueba

1. **Usá un canal de test** (`#test-asistencia`) para que los reportes automáticos no molesten
2. **Los cron jobs corren en horario BsAs** — si querés probar el reporte fuera de horario, podés usar la API:
   ```
   http://localhost:3000/dashboard/api/summary?from=2026-03-17&to=2026-03-21
   ```
3. **La DB es un archivo** (`data/attendance.db`) — podés abrirlo con cualquier visor SQLite (recomiendo [DB Browser for SQLite](https://sqlitebrowser.org/)) para ver y editar datos de prueba
4. **nodemon** reinicia automáticamente cuando cambiás código
