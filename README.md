# Audio Extract API

Extrae audio MP3, comprime videos y genera PDFs de transcripciones vía HTTP. Implementada en Node.js (Express) con ffmpeg.

Estado: Producción mínima viable (MVP)

---

## Arquitectura
- Runtime: Node.js (type=module)
- Servidor: Express
- Subida de archivos: multer (a /tmp)
- Transcodificación: ffmpeg (fluent-ffmpeg + ffmpeg-static)
- Generación de PDF: pdfkit
- Entrega de archivos generados: estáticos en `/files` (nombre aleatorio + TTL)
- Seguridad app: helmet + express-rate-limit
- Exposición pública: Tailscale Serve + Funnel (TLS automático)
- Servicio persistente: Docker Compose en el droplet (config no versionada; antes: systemd)

Ruta de proyecto: /root/.openclaw/workspace/audio-extract-api

---

## Endpoints

### GET /health
- Descripción: verificación de vida del servicio y estado de la cola de trabajos
- Auth: no requiere
- Respuesta 200
```json
{
  "ok": true,
  "service": "audio-extract-api",
  "jobs": {
    "active": 1, "waiting": 2,
    "max_concurrent": 1, "max_queued": 4,
    "completed": 37, "rejected": 2, "aborted": 1
  }
}
```
Sirve para monitorear saturación: `waiting` creciendo o `rejected` subiendo significa que
llegan más videos de los que el servidor puede procesar.

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


### POST /compress
- Descripción: recibe un video, lo comprime hasta quedar bajo un peso objetivo y devuelve la URL de descarga
- Auth: requerida (Bearer token)
- Content-Type: multipart/form-data
- Campo de archivo: `video`
- Tamaño máximo de entrada: 1 GB

Parámetros opcionales (form-data o query string):

| Parámetro | Default | Rango | Descripción |
|---|---|---|---|
| `max_mb` | `74` | 1–2048 | Peso máximo del resultado |
| `max_width` | `1280` | 160–3840 | Ancho máximo (nunca escala hacia arriba) |
| `max_height` | `720` | 120–2160 | Alto máximo (nunca escala hacia arriba) |
| `fps` | `15` | 1–60 | Tope de cuadros por segundo |
| `crf` | `28` | 0–51 | Calidad del primer intento (mayor = más compresión) |
| `audio_kbps` | `96` | 16–320 | Bitrate del audio AAC |
| `preset` | `fast` | `ultrafast`…`slow` | Preset de x264 (velocidad vs. tamaño) |
| `delete_after_download` | `DELETE_AFTER_DOWNLOAD` (`false`) | `true`/`false` | Borra el archivo en cuanto se descarga completo |

Respuesta 200:
```json
{
  "video_url": "https://<TU_HOST>.ts.net/files/6c27512cd6d0b5601f8f0b05182a8f13.mp4",
  "size_mb": 28.4,
  "filename": "6c27512cd6d0b5601f8f0b05182a8f13.mp4",
  "original_filename": "reunion.mp4",
  "original_size_mb": 130.59,
  "duration_sec": 90,
  "expires_at": "2026-10-09T23:40:51.063Z",
  "delete_after_download": false,
  "attempts": [
    { "mode": "crf 28", "size_mb": 33.54 },
    { "mode": "169 kbps", "size_mb": 28.4 }
  ]
}
```

Cómo garantiza el peso:
1. Primer intento con calidad constante (`-crf`, equivalente al comando de referencia):
   `scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=15`
   + `libx264 -preset fast -crf 28`, `aac 96k`, `-movflags +faststart`.
2. Si el resultado todavía supera `max_mb`, recalcula el bitrate de video a partir de la
   duración y el presupuesto (`max_mb * 0.95`) y reencoda, corrigiendo con el tamaño medido.
   Hasta 3 reintentos; `attempts` muestra el recorrido.
3. Si ni con < 48 kbps de video cabe (video demasiado largo), responde 500 con el detalle.

Ejemplo curl:
```bash
curl -s \
  -H "Authorization: Bearer <TOKEN>" \
  -F "video=@/ruta/al/video.mp4" \
  "https://<TU_HOST>.ts.net/compress?max_mb=74"
```

Uso en n8n:
1. Nodo **HTTP Request** → `POST https://<TU_HOST>.ts.net/compress`,
   Authentication: Header `Authorization: Bearer <TOKEN>`,
   Body: Form-Data, campo `video` de tipo *n8n Binary File* (propiedad `data`).
2. El JSON de salida trae `video_url` y `size_mb` listos para usar.
3. Para no acumular archivos, elegí una de estas tres (ninguna requiere cron):
   - `delete_after_download=true` en el request: el archivo se borra solo cuando n8n
     termina de descargarlo (lo más simple si solo lo consume un nodo).
   - `DELETE /files/{filename}` con el token, al final del flujo.
   - No hacer nada: expira igual a los `FILE_TTL_MINUTES`.


### POST /pdf
- Descripción: recibe el texto de una transcripción y devuelve un PDF paginado
- Auth: requerida (Bearer token)
- Content-Type: `application/json`, `multipart/form-data`, `application/x-www-form-urlencoded` o `text/plain`
- Campo de texto: `text` (o `transcript`). En `text/plain`, el body entero es el texto
- Tamaño máximo del body: 20 MB (`TEXT_BODY_LIMIT`)

Parámetros opcionales (body o query string):

| Parámetro | Default | Descripción |
|---|---|---|
| `title` | — | Título en la primera página (y metadata del PDF) |
| `subtitle` | — | Línea gris bajo el título: fecha, archivo origen, duración… |
| `filename` | — | Nombre con el que se descarga el archivo |
| `page_size` | `A4` | `A4`, `LETTER`, `LEGAL` o `A5` |
| `font_size` | `11` | Tamaño de la fuente base (6–36) |
| `line_gap` | `3` | Espacio extra entre líneas (0–20) |
| `margin` | `56` | Margen en puntos (18–140; 56 pt ≈ 2 cm) |
| `response` | `json` | `file` devuelve el PDF directo en vez de una URL |
| `delete_after_download` | `DELETE_AFTER_DOWNLOAD` | Igual que en `/compress` |

Respuesta 200 (default, `response=json`):
```json
{
  "pdf_url": "https://<TU_HOST>.ts.net/files/e65666a1….pdf?name=reunion.pdf",
  "size_mb": 0.006,
  "size_bytes": 6618,
  "pages": 5,
  "characters": 13016,
  "filename": "e65666a1….pdf",
  "expires_at": "2026-10-12T17:35:03.861Z",
  "delete_after_download": false
}
```

Con `response=file` responde `application/pdf` como adjunto y no deja nada en `/files`.

Formato del documento:
- Título en negrita, subtítulo gris y una línea divisoria, si se envían.
- Las líneas en blanco del texto se vuelven separación de párrafo; cada otra línea
  mantiene su salto propio y se ajusta sola al ancho (ideal para transcripciones con
  marcas de tiempo o nombres de hablante, una por línea).
- Pie de página con `página / total` en cada hoja.
- Fuente Helvetica incrustada por el visor: cubre acentos, `ñ` y `¿¡` sin fuentes extra.
  Alfabetos no latinos (cirílico, árabe, CJK) requerirían embeber una fuente TTF.

Ejemplo curl:
```bash
curl -s \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"text":"[00:01] Hablante 1: Hola...","title":"Transcripción de reunión","filename":"reunion.pdf"}' \
  https://<TU_HOST>.ts.net/pdf
```

Uso en n8n (encadenado tras la transcripción):
1. Nodo **HTTP Request** → `POST https://<TU_HOST>.ts.net/pdf`,
   Body Content Type: **JSON**, con `text` tomado del nodo de transcripción
   (p. ej. `{{ $json.text }}`) y, si querés, `title` y `filename`.
2. Si el PDF lo vas a adjuntar a un email o subir a Drive, es más directo mandar
   `response=file`: el nodo recibe el binario y lo pasás al siguiente nodo.
3. Si preferís guardar el link, usá el default y leé `pdf_url`.

---

### GET /files/:name
- Descripción: descarga de un archivo generado — video comprimido (`video/mp4`) o PDF (`application/pdf`)
- Auth: no requiere — el nombre es aleatorio de 128 bits, la URL *es* la credencial
- Query opcional `?name=mi-archivo.pdf`: solo cambia el nombre con el que se guarda
- Vigencia: `FILE_TTL_MINUTES` (180 min por defecto); luego se borra automáticamente

### DELETE /files/:name
- Descripción: borra un archivo generado antes de que expire
- Auth: requerida (Bearer token)
- Respuesta 200: `{ "ok": true, "deleted": "<filename>" }`

---


## Concurrencia y carga de CPU

Un encode de ffmpeg usa todos los núcleos que encuentra. Sin límite, tres videos
simultáneos en un droplet de 2 vCPU no son tres veces más lento: son tres procesos
peleando por los mismos núcleos, los tres tardan el triple y los tres dan timeout.

Por eso los endpoints que usan ffmpeg (`/compress` y `/extract`) pasan por una cola:

| Variable | Default | Qué hace |
|---|---|---|
| `MAX_CONCURRENT_JOBS` | `1` | Encodes simultáneos. Regla práctica: 1 cada 2 vCPU |
| `MAX_QUEUED_JOBS` | `4` | Cuántos esperan antes de responder `429` |
| `FFMPEG_THREADS` | `0` | Núcleos por encode (`0` = todos) |

Comportamiento:
- Si hay un slot libre, el encode arranca al instante.
- Si no, el request **espera** en la cola. Tarda más, pero termina.
- Si la cola está llena, responde **`429`** con `Retry-After: 60` en vez de aceptar
  trabajo que no puede hacer. Es preferible un 429 rápido a un timeout a los 15 min.

### Cancelación al desconectarse el cliente

Si el cliente corta la conexión (típicamente: timeout del nodo HTTP de n8n), el
servidor **mata el ffmpeg** y libera el slot. Sin esto, un timeout dejaba el encode
corriendo y el reintento de n8n sumaba un segundo proceso al primero: cada timeout
empeoraba la carga que lo causó.

En `/health`, `aborted` cuenta cuántas veces pasó. Si ese número sube, el timeout del
nodo en n8n es más corto que lo que tarda un encode: conviene subirlo (ver más abajo)
en vez de dejar que reintente.

### Si aun así se satura

- **Subí el timeout del nodo HTTP en n8n** a 900000 ms (15 min) y **desactivá el
  reintento automático**: con la cola, esperar es el comportamiento correcto.
- **Bajá el costo por video**: `preset=veryfast`, `fps=10`, o `max_height=480` cuando
  la calidad no importe. El preset es lo que más mueve la aguja.
- **Limitá el contenedor** para que ffmpeg no ahogue a los demás servicios del droplet.
  En el compose: `cpus: 1.5` y `mem_limit: 2g`.
- **Serializá en n8n**: si el flujo procesa varios videos, mandalos de a uno (Split in
  Batches con tamaño 1) en vez de en paralelo.

---

## Ciclo de vida de los archivos generados

Ningún archivo se guarda de forma permanente. Hay tres mecanismos, y siempre
aplica al menos el TTL:

| Mecanismo | Cuándo borra | Cómo se activa |
|---|---|---|
| Borrado tras descarga | Al completarse la descarga | `delete_after_download=true` en el request, o `DELETE_AFTER_DOWNLOAD=true` global |
| Borrado explícito | Cuando el cliente lo pide | `DELETE /files/{filename}` |
| TTL (red de seguridad) | A los `FILE_TTL_MINUTES` | Siempre activo; barrido cada 10 min y también al arrancar |

Sobre el borrado tras descarga:
- El archivo lleva el sufijo `.once` en el nombre, así que el comportamiento sobrevive
  a un reinicio del servicio (no depende de estado en memoria).
- Solo se borra si el cuerpo se envió **completo**. Una descarga cortada a mitad deja el
  archivo intacto y se puede reintentar.
- Al ser de un solo uso, se sirve sin soporte de `Range` y no se puede descargar dos
  veces: si tu flujo necesita reintentos o varios consumidores, usá `DELETE` o el TTL.
- El video de entrada subido siempre se borra de `/tmp` al terminar el request, haya
  éxito o error. Con `/pdf?response=file` nada llega a publicarse: el PDF se arma en
  `/tmp` y se borra al terminar de enviarse.

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


## Despliegue en producción con Docker (droplet)

Ruta en el droplet: `/srv/api-audio-extractor/audio-extractor`

El `Dockerfile`, el `docker-compose.yml` y el `.dockerignore` **no están versionados**
(ver `.gitignore`): viven solo en el servidor, porque están ajustados a ese entorno.
El repo trae únicamente el código y el `package.json`. Si hay que recrearlos, hay una
versión de referencia en el commit `438af7a`:

```bash
git show 438af7a:Dockerfile
git show 438af7a:docker-compose.yml
```

El contenedor escucha en `127.0.0.1:3080`, así que la configuración de
Tailscale Serve/Funnel sirve sin cambios.

### Actualizar a una versión nueva

```bash
cd /srv/api-audio-extractor/audio-extractor
git pull
docker compose up -d --build   # --build es necesario si cambiaron las dependencias
curl -s http://127.0.0.1:3080/health
```

### Operación

```bash
docker compose ps                   # estado y healthcheck
docker compose logs -f              # logs en vivo
docker compose restart              # reiniciar
docker compose down                 # detener
docker system df                    # espacio que usa Docker
docker image prune -f               # limpiar imágenes viejas tras varios builds
```

### Lo que el contenedor necesita

Requisitos del código, independientes de cómo esté armada la imagen:

- **`ffmpeg` disponible.** Se resuelve en cascada: `FFMPEG_PATH` si está definida, si no
  el binario de `ffmpeg-static`, y si tampoco existe, el `ffmpeg` del `PATH`. Con el
  `ffmpeg` del sistema instalado (`apk add ffmpeg` / `apt-get install ffmpeg`) no hace
  falta configurar nada. Si la imagen hace `npm ci --ignore-scripts`, el binario de
  `ffmpeg-static` no se descarga y se usa el del sistema: ~80 MB menos de imagen.
- **`ffprobe` (opcional).** Si está, se usa para leer la duración; si no, se deduce de la
  salida de ffmpeg. `FFPROBE_PATH` para apuntarlo explícitamente.
- **`.env` con `API_TOKEN` y `PUBLIC_BASE_URL`.** `.env` no está en el repo:

  ```ini
  API_TOKEN=<token real>
  PUBLIC_BASE_URL=https://audio-extract-vps.tail52e58c.ts.net
  FILE_TTL_MINUTES=180
  DELETE_AFTER_DOWNLOAD=false
  ```

  Sin `PUBLIC_BASE_URL`, `video_url` y `pdf_url` se deducen de los headers.
- **`FILES_DIR` con espacio en disco**, idealmente en un volumen. Si no se define, los
  archivos van a `./files` dentro del contenedor: funciona, pero se pierden al recrearlo
  y engordan la capa de escritura. Las subidas llegan a `os.tmpdir()` (`TMPDIR`), y con
  un límite de 1 GB por archivo conviene dejar holgura.
- **Un init que recoja procesos hijos** (`tini`, o `init: true` en compose): cada request
  lanza uno o varios ffmpeg, y sin eso quedan zombies.

Si estas variables se definen tanto en `.env` como en el `environment` del compose, ojo
con la precedencia: `env_file` pisa el `ENV` de la imagen, y `environment` pisa a ambos.

---

## Servicio (systemd, método anterior)
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
- 429: Cola de encodes llena (`Retry-After: 60`); reintentar más tarde
- 500: Error interno de ffmpeg o del servidor

El servidor intenta limpiar archivos temporales luego de enviar la respuesta.

---

## Configuración y límites
- Límite de archivo: `multer.limits.fileSize` en `server.js` (por defecto 1 GB)
- Variables de entorno (ver `.env.example`; en Docker, las de rutas las fija `docker-compose.yml`):
  - `FILES_DIR`: carpeta de salida servida en `/files` (default `./files`)
  - `FILE_TTL_MINUTES`: vigencia de cada archivo (default 180). Hay un barrido cada 10 min
  - `DELETE_AFTER_DOWNLOAD`: default de `delete_after_download` (default `false`)
  - `TEXT_BODY_LIMIT`: tamaño máximo del body de texto en `/pdf` (default `20mb`)
  - `MAX_CONCURRENT_JOBS` / `MAX_QUEUED_JOBS` / `FFMPEG_THREADS`: ver *Concurrencia*
  - `FFMPEG_PATH` / `FFPROBE_PATH`: binarios a usar. Si no se definen, se usa el de
    `ffmpeg-static` y, si tampoco está, el `ffmpeg` del `PATH` (el caso de Docker)
  - `PUBLIC_BASE_URL`: base de `video_url`. Si falta, se deduce de `Host` / `X-Forwarded-*`
- El servidor no impone timeout de request: comprimir un video largo puede tardar minutos
  (ajustar también el timeout del nodo HTTP Request en n8n)
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

## Modo asíncrono con callback (evaluado, no implementado)

Decidido el 2026-10-13: **no se implementa por ahora**. La cola sincrónica alcanza
para las ráfagas actuales; se monitorea `rejected` y `aborted` en `/health` unos días
antes de decidir. Queda documentado para retomarlo sin rediseñarlo.

**Problema que resuelve.** Monday dispara un webhook por video, así que varios videos
subidos juntos llegan como ejecuciones *separadas* de n8n, que no se pueden serializar
con Split In Batches. Hoy convergen en la cola del API y esperan con la conexión HTTP
abierta, lo que obliga a calibrar `MAX_QUEUED_JOBS` contra el timeout del nodo.

**Diseño.** `/compress` (y `/extract`) aceptan un `callback_url` opcional:

1. El request responde `202 { "job_id": "..." }` de inmediato, sin esperar el encode.
2. El trabajo entra en la misma cola que hoy.
3. Al terminar, el API hace `POST` al `callback_url` con el mismo JSON que devuelve el
   modo sincrónico. **También en caso de error**, con `{ "error": ... }`: si no, la
   ejecución de n8n queda dormida hasta agotar su `Limit Wait Time`.

En n8n: el nodo HTTP manda `callback_url = {{ $execution.resumeUrl }}`, y a continuación
un nodo **Wait → On Webhook Call** con **Limit Wait Time** encendido (~30 min) para que
una ejecución no quede colgada si el servidor se reinicia a mitad del job.

Con esto desaparecen el timeout del nodo, `MAX_QUEUED_JOBS` y el manejo del `429`: las
ejecuciones quedan suspendidas sin consumir conexiones y se despiertan en orden.

**Dos puntos que no son obvios al implementarlo:**

- `watchForAbort` mata el ffmpeg cuando el cliente se desconecta. En modo callback el
  cliente se desconecta a propósito apenas recibe el `202`, así que esa lógica debe
  quedar desactivada para los jobs asíncronos o cancelaría todos los encodes al instante.
- `callback_url` es una URL arbitraria a la que el servidor hace POST: conviene una
  allowlist por env (el dominio de n8n) y no seguir redirecciones, o cualquiera con el
  token puede usar el API para disparar requests a donde quiera.

---

## Roadmap / mejoras posibles
- Endpoint que encadene extraer audio → transcribir → PDF en un solo request
- Parámetros de audio en `/extract` (hoy fijo en MP3 192 kbps estéreo; 64 kbps mono
  alcanza para transcribir y reduce mucho el tamaño y el CPU)
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
