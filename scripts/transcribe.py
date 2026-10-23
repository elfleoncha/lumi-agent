import glob
import json
import os
import sys

from faster_whisper import WhisperModel

path = sys.argv[1]
model_size = sys.argv[2] if len(sys.argv) > 2 else "tiny"

# Usar la copia local del modelo para no depender de huggingface_hub
# (tiene un conflicto de versiones con httpx en este sistema).
hub = os.path.expanduser("~/.cache/huggingface/hub")
snapshots = sorted(glob.glob(f"{hub}/models--Systran--faster-whisper-{model_size}/snapshots/*/"))
source = snapshots[-1] if snapshots else model_size

model = WhisperModel(source, device="cpu", compute_type="int8")
segments, info = model.transcribe(path, vad_filter=True, beam_size=1)
text = " ".join(s.text.strip() for s in segments).strip()
print(json.dumps({"text": text, "lang": getattr(info, "language", None)}))
