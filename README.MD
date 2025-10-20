# Lottiberry — Lottie → MP4 сервис

Микросервис на Fastify, который рендерит Lottie-анимации в MP4.
Кодеки: `libx264`.

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

## Ограничения

- JSON-тело: до ~50 MB.

---

## Эндпойнты

### POST /render
Ставит задачу в очередь. Возвращает `200` c результатом генерации.

JSON-вариант:

    POST /render
    Content-Type: application/json
    {
      "input": "/abs/path/anim.json",  // или сам Lottie-объект
      "bgColor": "#000000",            // опционально
      "crf": 20,                       // libx264, опционально
      "preset": "veryfast",            // libx264, опционально
      "threads": 1,                    // потоки libx264;
      "workers": 4,                    // воркеры для генерации
      "extraFfmpegArgs": ["-profile:v","high"]  // опционально
    }

### GET /health
Здоровье сервиса: `{ "ok": true }`.

---

## Примеры curl

JSON:

    curl -sS -X POST http://localhost:3000/render \
      -H "content-type: application/json" \
      -d '{"mode":"parallel","input":"/data/anim.json","width":1080,"height":1920,"fps":30,"workers":4}'

## Локальный запуск без Docker

    node src/server.js
