# Roztypollo Bot v6.0 (Baileys)

Bot de WhatsApp modular con llave persistente por grupo, moderación avanzada, juegos rápidos contra el bot, stickers animados con limpieza automática y creador interactivo de sub-bots.

## Instalación rápida

### En Linux / WSL (Ubuntu)
```bash
chmod +x instalar.sh
./instalar.sh
./iniciar-bot.sh
```

### En Windows
1. Ejecuta `instalar.bat`.
2. Arranca con `iniciar-bot.bat`.

## Vinculación
- **QR en consola (por defecto):** deja `USE_PAIRING_CODE=false` en `.env` y escanea el QR desde *WhatsApp > Dispositivos vinculados*.
- **Código de 8 dígitos:** pon `USE_PAIRING_CODE=true` y `PAIRING_NUMBER=50683678160` en `.env`.
