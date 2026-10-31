# Arra demo film

`Arra_Demo.mp4`: 2 minutes 59 seconds, 1920×1080, 30 fps, H.264 + AAC, loudness −16 LUFS. Captions: `Arra_Demo.srt`.

Everything is generated from this folder: no stock footage or stock music.

| Part | How it's made |
| --- | --- |
| Voice | [Kokoro-82M](https://github.com/thewh1teagle/kokoro-onnx) (Apache-2.0), voice `af_heart`, line by line from `narration/script.json`; every line transcribed back with Whisper as a pronunciation check (`narration/generate.py`) |
| Screens | Real Arra interface captured with Playwright from the app running against a local chain with the real v4 vault contract (`assets/screens/`). Balances there are test amounts, and the film labels those scenes so |
| Picture | `production/film.html`: one page, eleven scenes; `seek(t)` draws any moment exactly, and `render.mjs` screenshots every frame |
| Sound | `production/audio.py` synthesises the score (pad, sub, soft plucks, scene swells) and ducks it under the voice |

Every number and claim in the film is sourced in the main [README](../README.md) (problem data, the 2023 rate example, mainnet transactions).

## Rebuild

```bash
python3 narration/generate.py          # needs kokoro-onnx, sherpa-onnx and their model files (MODELS=…)
python3 production/timeline.py && python3 production/audio.py && python3 production/captions.py
cd production
PORT=8651 node render.mjs video 0 80 part1.mp4 &
PORT=8652 node render.mjs video 80 "$(python3 -c 'import json;print(json.load(open("timeline.json"))["total"])')" part2.mp4 &
wait && ./master.sh
```
