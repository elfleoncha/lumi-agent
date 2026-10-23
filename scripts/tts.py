import sys

from gtts import gTTS

text = sys.argv[1]
out = sys.argv[2]
lang = sys.argv[3] if len(sys.argv) > 3 else "es"

gTTS(text=text, lang=lang).save(out)
