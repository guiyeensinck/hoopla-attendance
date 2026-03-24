# 🚀 Deploy en Railway — Paso a paso

Guía para poner la app en producción en Railway con SQLite persistente.

Tiempo estimado: 10-15 minutos.

---

## Paso 1: Subir el proyecto a GitHub

Si todavía no lo hiciste:

```bash
cd hoopla-attendance
git init
git add .
git commit -m "Initial commit"
```

Crear un repo en GitHub (puede ser privado) y pushearlo:

```bash
git remote add origin https://github.com/TU_USUARIO/hoopla-attendance.git
git branch -M main
git push -u origin main
```

---

## Paso 2: Crear cuenta en Railway

1. Ir a **https://railway.com**
2. Sign up con tu cuenta de GitHub
3. Elegir el plan **Hobby** (USD 5/mes, necesario para apps persistentes)

> Railway ya no tiene free tier permanente, pero el plan Hobby incluye USD 5 de crédito que cubren esta app holgadamente.

---

## Paso 3: Crear el proyecto

1. En el dashboard de Railway → **New Project**
2. Elegir **Deploy from GitHub repo**
3. Seleccionar tu repo `hoopla-attendance`
4. Railway detecta Node.js automáticamente y empieza a buildear

**Esperá a que termine el primer build** (1-2 minutos). Va a fallar porque faltan las variables de entorno, pero eso es normal.

---

## Paso 4: Agregar volumen persistente

Esto es **crítico** — sin volumen, la DB se borra en cada deploy.

1. En tu proyecto, click en el servicio `hoopla-attendance`
2. Ir a la tab **Volumes**
3. Click **Add Volume**
4. Mount path: `/data`
5. Click **Add**

---

## Paso 5: Configurar variables de entorno

1. En el servicio → tab **Variables**
2. Click **Raw Editor** y pegar todo junto:

```env
SLACK_BOT_TOKEN=xoxb-tu-token
SLACK_SIGNING_SECRET=tu-signing-secret
PORT=3000
REPORT_CHANNEL=#asistencia
SOLO_MODE=true
SOLO_USER_ID=TU_SLACK_USER_ID
ADMIN_USER_IDS=TU_SLACK_USER_ID
DB_PATH=/data
PINGS_PER_DAY=3
PING_TIMEOUT_MIN=10
WORK_START_HOUR=9
WORK_END_HOUR=18
RAILWAY_RUN_UID=0
```

> **RAILWAY_RUN_UID=0** es necesario para que la app tenga permisos de escritura en el volumen.

> **DB_PATH=/data** apunta la base de datos al volumen persistente.

3. Click **Update Variables** — Railway redeploya automáticamente.

---

## Paso 6: Generar dominio público

1. En el servicio → tab **Settings**
2. En la sección **Networking** → **Public Networking**
3. Click **Generate Domain**
4. Te da algo como: `hoopla-attendance-production.up.railway.app`

Si tenés dominio propio, podés agregar un **Custom Domain** con un registro CNAME.

---

## Paso 7: Configurar la Slack App

Ir a **https://api.slack.com/apps** → tu app.

### 7a. Slash Commands

Crear (o editar) estos tres commands:

| Command        | Request URL                                                    |
|----------------|----------------------------------------------------------------|
| `/asistencia`  | `https://TU-DOMINIO.up.railway.app/slack/events`              |
| `/reporte`     | `https://TU-DOMINIO.up.railway.app/slack/events`              |
| `/admin`       | `https://TU-DOMINIO.up.railway.app/slack/events`              |

### 7b. Interactivity

- Activar **Interactivity**
- Request URL: `https://TU-DOMINIO.up.railway.app/slack/events`

### 7c. Event Subscriptions

- Activar
- Request URL: `https://TU-DOMINIO.up.railway.app/slack/events`
- Bot events: `app_home_opened`, `team_join`

### 7d. OAuth Scopes

Verificar que tengas estos **Bot Token Scopes**:

```
chat:write
commands
users:read
users:read.email
```

> **users:read** es necesario para el chequeo de presencia (active/away).

Si agregaste scopes nuevos, reinstalar la app en el workspace y actualizar el token en Railway.

---

## Paso 8: Verificar

### En Railway

- El servicio debería mostrar estado **Active** (punto verde)
- Click en **Logs** para ver la salida:

```
[scheduler] Cron jobs configurados:
  → Alerta faltantes: L-V 10:30
  → Recordatorio salida: L-V 18:30
  → Reporte semanal: Viernes 18:00
  → Reporte mensual: 1ro 09:00
  → Pings actividad: cada minuto L-V
  → Presencia Slack: cada 30 min L-V
[dashboard] Available at /dashboard

  ⚡ Hoopla Asistencia running
  → Solo mode:   ON
```

### En el navegador

Abrir: `https://TU-DOMINIO.up.railway.app/dashboard`

### En Slack

```
/asistencia     → Debería mostrar el menú
/admin lista    → Debería mostrar el panel admin
```

---

## Operación diaria

### Ver logs en tiempo real

En Railway → tu servicio → **Logs**

O con la CLI:
```bash
npm install -g @railway/cli
railway login
railway logs
```

### Actualizar la app

Simplemente pusheá a GitHub:
```bash
git add .
git commit -m "Fix: lo que sea"
git push
```

Railway redeploya automáticamente en ~1 minuto.

### Pasar a producción (sacar modo solo)

En Railway → Variables, cambiar:
```
SOLO_MODE=false
```

Railway redeploya solo.

---

## Monitoreo y backups

### Métricas

Railway muestra CPU, RAM y network en la tab **Metrics** del servicio. Para esta app vas a ver uso mínimo (~50 MB RAM, CPU casi cero).

### Backups de la DB

Railway no hace backup del volumen automáticamente. Podés descargar la DB periódicamente:

```bash
# Con la CLI de Railway
railway login
railway link           # Vincular al proyecto
railway volume ls      # Ver volúmenes
```

O agregar un cron job en la app que copie la DB a un servicio externo (S3, Google Drive, etc.) si querés automatizarlo más adelante.

### Backup manual rápido

Desde el dashboard web, la API te devuelve todos los datos en JSON:
```
https://TU-DOMINIO.up.railway.app/dashboard/api/records?from=2026-01-01&to=2026-12-31
```

---

## Costos esperados

El plan Hobby de Railway cuesta USD 5/mes e incluye:

- 8 GB RAM
- 8 vCPU
- 100 GB de tráfico
- Volumen persistente de 5 GB incluido

Esta app usa ~50 MB de RAM y prácticamente cero CPU. El costo real va a ser el mínimo del plan (USD 5/mes), no vas a acercarte a los límites.

---

## Troubleshooting

### Build falla con "better-sqlite3"
→ Railway con Nixpacks incluye build tools por default, pero si falla, agregar esta variable:
```
NIXPACKS_APT_PKGS=build-essential python3
```

### "dispatch_failed" en Slack
→ Verificar que el dominio de Railway esté activo y que las URLs en Slack sean correctas.

### La DB se vacía después de un deploy
→ Verificar que `DB_PATH=/data` esté configurado y que el volumen exista con mount path `/data`. Verificar que `RAILWAY_RUN_UID=0` esté seteado.

### Los pings no se envían
→ Verificar que haya usuarios trackeados (`/admin lista`) y que tengan entrada registrada para hoy.
