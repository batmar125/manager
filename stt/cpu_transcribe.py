"""Transcrição de reserva na CPU (quando o manager-stt está parado, por exemplo no modo jogo). Uso: cpu_transcribe.py <arquivo>"""
import json, sys
from faster_whisper import WhisperModel

m = WhisperModel("mobiuslabsgmbh/faster-whisper-large-v3-turbo", device="cpu", compute_type="int8", cpu_threads=4)
segs, _ = m.transcribe(sys.argv[1], language="pt", beam_size=1, vad_filter=True)
print(json.dumps({"text": " ".join(s.text.strip() for s in segs).strip(), "cpu": True}, ensure_ascii=False))
