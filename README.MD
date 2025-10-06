# Lottiberry — Lottie → MP4 сервис

Микросервис на Fastify, который рендерит Lottie-анимации в MP4.
Два режима рендера: `single` (однопоточный) и `parallel` (через воркеры). Кодеки: `libx264`.

---

## Быстрый старт (Docker)

Сборка:

    docker build -t lottiberry .

Запуск:

    docker run --rm -p 3000:3000 \
      -e PORT=3000 \
      -e CONCURRENCY=1 \
      lottiberry

Проверка:

    curl -s http://localhost:3000/health

---

## Переменные окружения

- `PORT` — порт HTTP, по умолчанию `3000`.
- `CONCURRENCY` — число одновременно исполняемых задач очереди.
- `FFMPEG_PATH` — путь к бинарю ffmpeg. В образе уже `/usr/bin/ffmpeg`.

---

## Ограничения

- JSON-тело: до ~50 MB.

---

## Эндпойнты

### POST /render
Ставит задачу в очередь. Возвращает `202` с `id`.

JSON-вариант:

    POST /render
    Content-Type: application/json
    {
      "mode": "parallel",              // "single" | "parallel" (опционально, default: parallel)
      "input": "/abs/path/anim.json",  // или сам Lottie-объект
      "width": 1080,                   // опционально
      "height": 1920,                  // опционально
      "fps": 30,                       // опционально
      "bgColor": "#000000",            // опционально
      "crf": 20,                       // libx264, опционально
      "preset": "veryfast",            // libx264, опционально
      "gop": 360,                      // опционально (по умолчанию FPS*12)
      "threads": 0,                    // потоки x264; 0 = авто
      "workers": 4,                    // только для parallel
      "extraFfmpegArgs": ["-profile:v","high"]  // опционально
    }

Ответ:

    202 Accepted
    { "id": "<jobId>", "status": "queued" }

### GET /jobs/:id
Статус задачи.

    200 OK
    {
      "id": "<jobId>",
      "status": "queued|running|done|error",
      "mode": "single|parallel",
      "error": null,
      "timings": {
        "queuedAt": "2025-10-06T16:20:30.123Z",
        "startedAt": "2025-10-06T16:20:31.456Z",
        "endedAt": "2025-10-06T16:20:40.789Z",
        "renderMs": 9333,
        "totalMs": 10666
      }
    }

Коды: `404 not found`.

### GET /jobs/:id/result
Скачивание MP4. Доступно при `status=done`.

Заголовки:

- `Content-Type: video/mp4`
- `Content-Disposition: attachment; filename="<id>.mp4"`
- `X-Mode: single|parallel`
- `X-Render-Duration-Ms: <число>`
- `X-Total-Duration-Ms: <число>`
- `X-Started-At: <ISO>`
- `X-Ended-At: <ISO>`

Коды: `404 not found`, `409 not ready`.

### GET /health
Здоровье сервиса: `{ "ok": true }`.

---

## Примеры curl

JSON:

    curl -sS -X POST http://localhost:3000/render \
      -H "content-type: application/json" \
      -d '{"mode":"parallel","input":"/data/anim.json","width":1080,"height":1920,"fps":30,"workers":4}'

Multipart:

    curl -sS -X POST http://localhost:3000/render \
      -F "mode=single" \
      -F "width=1080" -F "height=1920" -F "fps=30" \
      -F "file=@./anim.json;type=application/json"

Статус:

    curl -sS http://localhost:3000/jobs/<jobId>

Результат:

    curl -sS -D - http://localhost:3000/jobs/<jobId>/result -o out.mp4

---

## Локальный запуск без Docker

    node src/server.js

---

## Структура

    src/
      server.js
      lottie-to-video.js
      lottie-to-video-parallel.js
      lottie_worker.js
    Dockerfile
    docker-compose.yml
    package.json

---

## Оптимизация размера образа

- В рантайме только `libcairo`, `pango`, `jpeg`, `png`, `gif`, `ffmpeg`.

---
