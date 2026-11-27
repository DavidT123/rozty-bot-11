#!/usr/bin/env bash
set -e

echo "=========================================="
echo "  INSTALADOR ROZTYPOLLO BOT (LINUX / WSL)"
echo "=========================================="

mkdir -p data sessions/main sessions/subbots temp logs backups

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[OK] Archivo .env creado desde .env.example"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js no está instalado. Instala Node 18+ primero."
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[AVISO] FFmpeg no detectado. Intentando instalar..."
  sudo apt-get update && sudo apt-get install -y ffmpeg || echo "Instala ffmpeg manualmente para stickers animados."
fi

npm install
npm install -g pm2 || true

cat << 'EOF' > iniciar-bot.sh
#!/usr/bin/env bash
pm2 start ecosystem.config.js || node index.js
EOF

cat << 'EOF' > reiniciar-emergencia.sh
#!/usr/bin/env bash
rm -rf temp/*
pm2 restart roztypollo-bot || node index.js
EOF

cat << 'EOF' > respaldar-todo.sh
#!/usr/bin/env bash
FECHA=$(date +"%Y%m%d_%H%M%S")
tar -czf "backups/respaldo_${FECHA}.tar.gz" data sessions .env
echo "Respaldo guardado en backups/respaldo_${FECHA}.tar.gz"
EOF

cat << 'EOF' > ver-logs.sh
#!/usr/bin/env bash
pm2 logs roztypollo-bot
EOF

chmod +x iniciar-bot.sh reiniciar-emergencia.sh respaldar-todo.sh ver-logs.sh

echo ""
echo "[LISTO] Instalación completada."
echo "1. Edita .env si quieres cambiar número o modo de código de 8 dígitos."
echo "2. Ejecuta ./iniciar-bot.sh para arrancar el bot."
