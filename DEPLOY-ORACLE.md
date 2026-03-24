# 🚀 Deploy en Oracle Cloud — Gratis para siempre

Guía completa para poner la app en producción en un VPS ARM de Oracle Cloud (Always Free Tier).

---

## Lo que vas a tener

- VM con 4 CPU ARM + 24GB RAM (gratis, permanente)
- App corriendo con PM2 (se reinicia sola si crashea)
- Nginx como reverse proxy con SSL (HTTPS gratuito via Let's Encrypt)
- SQLite con backups automáticos
- Dominio propio opcional (o subdominio gratuito)

---

## Paso 1: Crear cuenta en Oracle Cloud

1. Ir a **https://cloud.oracle.com** → **Sign Up**
2. Completar registro (necesitás tarjeta de crédito para verificación, pero NO te cobran)
3. Elegir region: **sa-saopaulo-1** (São Paulo, la más cercana a BsAs)
4. Esperar que se active la cuenta (puede tardar 1-2 horas)

> ⚠️ Oracle verifica identidad. Si te rebota la primera vez, intentá con otra tarjeta.

---

## Paso 2: Crear la VM (instancia)

1. Ir a **Menu** → **Compute** → **Instances** → **Create Instance**
2. Configurar:
   - **Name**: `hoopla-asistencia`
   - **Image**: Ubuntu 22.04 (o 24.04)
   - **Shape**: Click "Change Shape" → **Ampere** → **VM.Standard.A1.Flex**
     - OCPUs: **1** (podés usar hasta 4 gratis)
     - Memory: **6 GB** (podés usar hasta 24 gratis)
   - **Networking**: Dejar "Create new VCN" seleccionado
   - **Add SSH keys**: Click "Generate a key pair" → **descargar ambas keys** (pública y privada)
3. Click **Create**
4. Esperar hasta que diga **RUNNING**
5. Copiar la **Public IP Address** que aparece

> 💡 Si te dice "Out of capacity", probá con 1 OCPU / 6 GB, o esperá unas horas.

---

## Paso 3: Abrir puertos

Por default Oracle bloquea todo. Hay que abrir HTTP, HTTPS y opcionalmente el puerto 3000.

### 3a. Security List (en Oracle)

1. Ir a **Networking** → **Virtual Cloud Networks** → click en tu VCN
2. Click en la **subnet** → click en la **Security List**
3. **Add Ingress Rules**:

| Source CIDR    | Protocol | Dest Port | Descripción   |
|----------------|----------|-----------|---------------|
| 0.0.0.0/0      | TCP      | 80        | HTTP          |
| 0.0.0.0/0      | TCP      | 443       | HTTPS         |

### 3b. iptables (dentro del servidor)

Después de conectarte por SSH (paso 4), correr:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

---

## Paso 4: Conectarse por SSH

```bash
# Dar permisos a la key
chmod 400 ~/Downloads/ssh-key-*.key

# Conectar (reemplazar IP y ruta a la key)
ssh -i ~/Downloads/ssh-key-*.key ubuntu@TU_IP_PUBLICA
```

A partir de acá, todo se hace dentro del servidor.

---

## Paso 5: Instalar dependencias del sistema

```bash
# Actualizar
sudo apt update && sudo apt upgrade -y

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Build tools (para better-sqlite3)
sudo apt install -y build-essential python3

# Nginx
sudo apt install -y nginx

# PM2 (process manager)
sudo npm install -g pm2

# Certbot (SSL)
sudo apt install -y certbot python3-certbot-nginx

# Git
sudo apt install -y git
```

Verificar:
```bash
node --version   # v20.x
npm --version    # 10.x
nginx -v         # 1.x
pm2 --version    # 5.x
```

---

## Paso 6: Subir la app

### Opción A: Desde GitHub (recomendado)

```bash
cd /home/ubuntu
git clone https://github.com/TU_USUARIO/hoopla-attendance.git
cd hoopla-attendance
npm install
```

### Opción B: Subir con scp

Desde tu máquina local:
```bash
scp -i ~/Downloads/ssh-key-*.key hoopla-attendance.zip ubuntu@TU_IP:/home/ubuntu/
```

En el servidor:
```bash
cd /home/ubuntu
unzip hoopla-attendance.zip
cd hoopla-attendance
npm install
```

---

## Paso 7: Configurar variables de entorno

```bash
cp .env.example .env
nano .env
```

```env
SLACK_BOT_TOKEN=xoxb-tu-token
SLACK_SIGNING_SECRET=tu-signing-secret
PORT=3000
REPORT_CHANNEL=#asistencia

# Desactivar solo mode para producción
SOLO_MODE=false

# Tu Slack ID como admin
ADMIN_USER_IDS=U0ABC1DEF2

# Activity
PINGS_PER_DAY=3
PING_TIMEOUT_MIN=10
WORK_START_HOUR=9
WORK_END_HOUR=18
```

---

## Paso 8: Configurar Nginx (reverse proxy)

```bash
sudo nano /etc/nginx/sites-available/hoopla-asistencia
```

Pegar:

```nginx
server {
    listen 80;
    server_name TU_DOMINIO_O_IP;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Slack necesita respuesta en 3 segundos
        proxy_connect_timeout 5;
        proxy_send_timeout 10;
        proxy_read_timeout 10;
    }
}
```

Activar:
```bash
sudo ln -s /etc/nginx/sites-available/hoopla-asistencia /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

---

## Paso 9: SSL con Let's Encrypt (si tenés dominio)

Si tenés un dominio, apuntá un registro A a tu IP de Oracle y después:

```bash
sudo certbot --nginx -d tu-dominio.com
```

Certbot configura todo automáticamente y renueva el certificado solo.

**Si NO tenés dominio**: podés usar la IP directamente. Slack funciona con HTTP para slash commands (no requiere HTTPS para la request URL), pero el dashboard va a quedar sin SSL.

> 💡 Tip gratis: podés usar un subdominio de **DuckDNS** (duckdns.org) que es gratuito y funciona con Certbot.

---

## Paso 10: Arrancar con PM2

```bash
cd /home/ubuntu/hoopla-attendance

# Iniciar
pm2 start src/app.js --name hoopla-asistencia

# Verificar que ande
pm2 logs hoopla-asistencia

# Configurar para que arranque con el sistema
pm2 startup
# (copiar y ejecutar el comando que te muestra)
pm2 save
```

Comandos útiles:
```bash
pm2 status                     # Ver estado
pm2 logs hoopla-asistencia     # Ver logs en vivo
pm2 restart hoopla-asistencia  # Reiniciar
pm2 stop hoopla-asistencia     # Parar
pm2 monit                      # Monitor en tiempo real
```

---

## Paso 11: Actualizar URLs en Slack

Volver a **https://api.slack.com/apps** → tu app.

Reemplazar TODAS las URLs de ngrok con tu URL de producción:

- **Slash Commands** → editar `/asistencia`, `/reporte`, `/admin`:
  - Request URL: `https://TU_DOMINIO/slack/events`
- **Interactivity**:
  - Request URL: `https://TU_DOMINIO/slack/events`
- **Event Subscriptions**:
  - Request URL: `https://TU_DOMINIO/slack/events`

---

## Paso 12: Backups automáticos de la DB

```bash
mkdir -p /home/ubuntu/backups

# Crear script de backup
cat > /home/ubuntu/backup-db.sh << 'EOF'
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d_%H%M)
cp /home/ubuntu/hoopla-attendance/data/attendance.db /home/ubuntu/backups/attendance_${TIMESTAMP}.db
# Mantener solo los últimos 30 backups
ls -t /home/ubuntu/backups/attendance_*.db | tail -n +31 | xargs rm -f 2>/dev/null
echo "[backup] ${TIMESTAMP} — done"
EOF

chmod +x /home/ubuntu/backup-db.sh

# Programar backup diario a las 23:00
(crontab -l 2>/dev/null; echo "0 23 * * * /home/ubuntu/backup-db.sh >> /home/ubuntu/backups/backup.log 2>&1") | crontab -
```

---

## Actualizar la app

Cuando hagas cambios:

```bash
cd /home/ubuntu/hoopla-attendance
git pull                          # o subir archivos nuevos
npm install                       # si cambió package.json
pm2 restart hoopla-asistencia
```

---

## Troubleshooting

### La app no responde desde afuera
```bash
# Verificar que la app esté corriendo
pm2 status

# Verificar nginx
sudo systemctl status nginx

# Verificar puertos
sudo ss -tlnp | grep -E '80|443|3000'

# Si iptables bloquea:
sudo iptables -L INPUT -n --line-numbers
```

### Slack tira "dispatch_failed"
→ La URL está mal, el servidor no responde, o nginx no está pasando el request.
```bash
# Test rápido desde el server:
curl http://localhost:3000/
# Debería devolver HTML del dashboard
```

### Error de permisos con SQLite
```bash
sudo chown -R ubuntu:ubuntu /home/ubuntu/hoopla-attendance/data
```

### Quedarse sin espacio
```bash
df -h                                     # Ver espacio
sudo journalctl --vacuum-size=100M        # Limpiar logs del sistema
```

### Restaurar backup
```bash
pm2 stop hoopla-asistencia
cp /home/ubuntu/backups/attendance_FECHA.db /home/ubuntu/hoopla-attendance/data/attendance.db
pm2 start hoopla-asistencia
```
