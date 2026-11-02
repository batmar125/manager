# Transcrição local (faster-whisper na GPU) para o manager.
# POST /transcribe com o áudio cru no corpo → {"text", "language", "duration"}.
# Ouve só em 127.0.0.1; a UI chega aqui via /api/transcribe do server.mjs.
import json, os, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from faster_whisper import WhisperModel

MODEL = os.environ.get("STT_MODEL", "large-v3-turbo")
PORT = int(os.environ.get("STT_PORT", "7778"))
MAX_BYTES = 50 * 1024 * 1024

model = WhisperModel(MODEL, device="cuda", compute_type="float16")
lock = threading.Lock()  # uma transcrição por vez na GPU


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "model": MODEL})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/transcribe"):
            return self._json(404, {"error": "not found"})
        size = int(self.headers.get("content-length") or 0)
        if not 0 < size <= MAX_BYTES:
            return self._json(400, {"error": "corpo vazio ou grande demais"})
        data = self.rfile.read(size)
        with tempfile.NamedTemporaryFile(suffix=".audio") as f:
            f.write(data)
            f.flush()
            t0 = time.time()
            try:
                with lock:
                    segments, info = model.transcribe(f.name, language="pt", vad_filter=True, beam_size=5)
                    text = " ".join(s.text.strip() for s in segments).strip()
            except Exception as e:  # áudio corrompido, formato desconhecido etc.
                return self._json(422, {"error": str(e)})
        self._json(200, {"text": text, "language": info.language,
                         "duration": round(info.duration, 1), "seconds": round(time.time() - t0, 2)})

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


print(f"stt: modelo {MODEL} carregado; ouvindo em 127.0.0.1:{PORT}", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
