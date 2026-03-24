# ⚡ Hoopla Asistencia

App de Slack para registrar horarios de entrada, almuerzo y salida del equipo. Incluye dashboard web, reportes automáticos y alertas.

---

## Funcionalidades

- **Registro interactivo**: Menú desplegable en Slack con botón "Registrar ahora" (hora actual) o selección manual
- **4 momentos del día**: Entrada → Inicio almuerzo → Fin almuerzo → Salida
- **Cálculo automático de horas**: Descuenta tiempo de almuerzo
- **Dashboard web**: Vista de presentes, faltantes y registros históricos con filtros
- **Alertas automáticas**:
  - L-V 10:30 → Notifica quiénes no ficharon entrada
  - L-V 18:30 → Recuerda registrar salida a quienes no lo hicieron
- **Reportes**:
  - Semanal (viernes 18:00): días trabajados, horas totales, promedio
  - Mensual (1ro de cada mes): resumen del mes anterior

---

## Setup

### 1. Crear la Slack App

1. Ir a [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Nombre: `Hoopla Asistencia` (o el que quieras)
3. Seleccionar workspace

### 2. Configurar permisos (OAuth & Permissions)

**Bot Token Scopes** necesarios:
```
chat:write
commands
users:read
```

### 3. Crear Slash Commands

En **Slash Commands**, crear:

| Command       | Request URL                          | Description                    |
|---------------|--------------------------------------|--------------------------------|
| `/asistencia` | `https://tu-dominio.com/slack/events` | Registrar asistencia del día   |
| `/reporte`    | `https://tu-dominio.com/slack/events` | Ver reporte semanal o mensual  |

### 4. Habilitar Interactivity

En **Interactivity & Shortcuts**:
- Activar **Interactivity**
- Request URL: `https://tu-dominio.com/slack/events`

### 5. Habilitar Events (opcional, para App Home)

En **Event Subscriptions**:
- Request URL: `https://tu-dominio.com/slack/events`
- Subscribe to: `app_home_opened`, `team_join`

### 6. Instalar la app en el workspace

Ir a **Install App** → **Install to Workspace** → Copiar el **Bot User OAuth Token**

### 7. Variables de entorno

```bash
cp .env.example .env
```

Completar con:
- `SLACK_BOT_TOKEN`: el token `xoxb-...` del paso anterior
- `SLACK_SIGNING_SECRET`: en **Basic Information** → **App Credentials**
- `REPORT_CHANNEL`: canal donde se envían reportes (ej: `#asistencia`)

### 8. Instalar y correr

```bash
npm install
npm start
```

Para desarrollo:
```bash
npm run dev
```

### 9. Exponer a internet (desarrollo local)

Para desarrollo, se puede usar [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

Y usar la URL `https://xxxx.ngrok.io/slack/events` en los pasos 3, 4 y 5.

---

## Uso

### En Slack

```
/asistencia          → Abre el menú de registro del día
/reporte             → Reporte semanal
/reporte mensual     → Reporte del mes
```

### Dashboard web

Acceder a `http://localhost:3000/dashboard`

- **Dashboard**: vista de hoy (presentes, faltantes, horas del equipo)
- **Registros**: histórico filtrable por fecha y persona

### API

```
GET /dashboard/api/records?from=2026-03-01&to=2026-03-21&user=U12345
GET /dashboard/api/summary?from=2026-03-17&to=2026-03-21
```

---

## Stack

- **Runtime**: Node.js
- **Slack**: @slack/bolt
- **Base de datos**: SQLite (better-sqlite3)
- **Web**: Express (integrado en Bolt)
- **Scheduler**: node-cron
- **Timezone**: America/Argentina/Buenos_Aires

---

## Estructura

```
hoopla-attendance/
├── src/
│   ├── app.js          # App principal, handlers de Slack
│   ├── blocks.js       # Block Kit builders (menús, reportes)
│   ├── database.js     # SQLite schema y queries
│   ├── dashboard.js    # Dashboard web (Express routes + HTML)
│   └── scheduler.js    # Cron jobs (alertas, reportes)
├── data/
│   └── attendance.db   # SQLite (se crea automáticamente)
├── .env.example
├── package.json
└── README.md
```

---

## Deploy

Cualquier servidor con Node.js 18+ funciona. Opciones sugeridas:

- **Railway** / **Render**: deploy desde GitHub, gratis para empezar
- **VPS** (DigitalOcean, etc.): con PM2 para proceso persistente
- **Docker**: agregar Dockerfile si se necesita

Para PM2:
```bash
npm install -g pm2
pm2 start src/app.js --name hoopla-asistencia
pm2 save
```
