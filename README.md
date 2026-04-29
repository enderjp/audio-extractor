# Audio Extract API

Extrae audio MP3 desde un archivo de video vía HTTP. Implementada en Node.js (Express) con ffmpeg.

Estado: Producción mínima viable (MVP)

---

## Arquitectura
- Runtime: Node.js (type=module)
- Servidor: Express
- Subida de archivos: multer (a /tmp)
- Transcodificación: ffmpeg (fluent-ffmpeg + ffmpeg-static)
- Seguridad app: helmet + express-rate-limit
- Exposición pública: Tailscale Serve + Funnel (TLS automático)
- Servicio persistente: systemd

Ruta de proyecto: /root/.openclaw/workspace/audio-extract-api

---

## Endpoints

### GET /health
- Descripción: verificación de vida del servicio
- Auth: no requiere
- Respuesta 200
```json
{ "ok": true, "service": "audio-extract-api" }
```

### POST /extract
- Descripción: recibe un archivo de video y devuelve el audio en MP3
- Auth: requerida (Bearer token)
- Content-Type: multipart/form-data
- Campo de archivo: `video`
- Tamaño máximo: 1 GB (ajustable en server.js → multer.limits.fileSize)
- Respuesta 200: `audio/mpeg` (archivo adjunto .mp3)
- Parámetros de salida:
  - Codec: libmp3lame
  - Bitrate: 192 kbps
  - Frecuencia: 44.1 kHz

Ejemplo curl:
```bash
curl -s \
  -H "Authorization: Bearer <TOKEN>" \
  -F "video=@/ruta/al/video.mp4" \
  https://<TU_HOST>.ts.net/extract -o salida.mp3
```

---

## Autenticación
- Tipo: Bearer token (header HTTP `Authorization: Bearer <token>`)
- Token actual en el servidor: `/root/.openclaw/workspace/audio-extract-api/.api_token`
- En systemd se inyecta mediante `/etc/default/audio-extract-api` (variable `API_TOKEN`)

Rotación de token (manual):
1) Editar `/etc/default/audio-extract-api` y cambiar `API_TOKEN=...`
2) Reiniciar servicio: `systemctl restart audio-extract-api`
3) Actualizar clientes que consumen la API

Opcional: se puede añadir Basic Auth o firmar requests, según necesidad.

---

## Despliegue (Tailscale Serve + Funnel)
- El servicio Node escucha solo en `127.0.0.1:3080` (no expuesto directamente)
- Publicado externamente vía Tailscale Funnel con TLS automático
- URL pública actual (ejemplo): `https://audio-extract-vps.tail52e58c.ts.net/`
- Ruteo: `/` → proxy a `http://127.0.0.1:3080`

Comandos útiles Tailscale:
```bash
# Ver estado serve/funnel
tailscale serve status
tailscale funnel status

# Activar (ya configurado)
tailscale serve --bg http://127.0.0.1:3080
tailscale funnel --bg http://127.0.0.1:3080

# Apagar funnel (internet)
tailscale funnel --https=443 off
```

Nota: Funnel requiere estar habilitado en el panel de Tailscale (ya hecho).

---

## Servicio (systemd)
Unit: `/etc/systemd/system/audio-extract-api.service`

Variables de entorno: `/etc/default/audio-extract-api`
```ini
API_TOKEN=<token>
PORT=3080
```

Comandos de administración:
```bash
systemctl status audio-extract-api
journalctl -u audio-extract-api -f
systemctl restart audio-extract-api
systemctl disable --now audio-extract-api
systemctl enable --now audio-extract-api
```

Logs: `journalctl -u audio-extract-api -f`

---

## Errores y códigos
- 400: No se envió archivo (`video`) o request inválido
- 401: Falta o es inválido el Bearer token
- 413: Archivo supera el límite (1 GB por defecto)
- 500: Error interno de ffmpeg o del servidor

El servidor intenta limpiar archivos temporales luego de enviar la respuesta.

---

## Configuración y límites
- Límite de archivo: `multer.limits.fileSize` en `server.js` (por defecto 1 GB)
- Parámetros de audio: `.audioBitrate('192k')`, `.audioFrequency(44100)`, formato `mp3`
- Rate limit: 200 requests / 15 min por IP (ajustable)
- `helmet` aplicado para headers de seguridad

---

## Desarrollo local (solo VPS)

```bash
cd /root/.openclaw/workspace/audio-extract-api
npm run start  # o usar systemd ya configurado
curl -s http://127.0.0.1:3080/health
```

---

## Roadmap / mejoras posibles
- Permitir elegir formato de salida (AAC, WAV, etc.)
- Ajuste dinámico de bitrate/calidad vía query params
- Soporte para archivos >1 GB con límites controlados y chunked uploads
- Métricas/observabilidad (p. ej., prom-client)
- Tests y validaciones de mimetype/extensiones
- Sustituir fluent-ffmpeg (deprecated) por alternativa mantenida o invocación directa a ffmpeg

---

## Contacto y mantenimiento
- Mantener actualizado el token y los paquetes
- Revisar que `tailscaled` esté activo tras reinicios
- Asegurar que Funnel siga habilitado en el panel de Tailscale cuando se cambian políticas de tailnet
