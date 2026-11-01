# Arra demo film

`Arra_Demo.mp4`: 3 minutes 32 seconds, 1920×1080, 30 fps, H.264 + AAC, loudness −16 LUFS. Captions: `Arra_Demo.srt`.

Everything is generated from this folder: no stock footage, no stock music. The current film is built by `v2/`; the first cut's sources are kept in `narration/` and `production/`.

| Part | How it's made |
| --- | --- |
| Voice | [Kokoro-82M](https://github.com/thewh1teagle/kokoro-onnx) (Apache-2.0), voice `af_heart`, line by line from `v2/narration/script.json`; every line transcribed back with Whisper as a pronunciation check |
| App demos | The real Arra app recorded in a browser (Playwright, frames straight from Chromium at 1920×1080) with a drawn cursor that moves, clicks and types (`v2/recording/`). It runs against a local chain with the real v4 vault contract and a stand-in for the paid data gateway. Every demo is labelled "Real Arra app · local test chain, example amounts" |
| Example data | The risky shop in the supplier check (`@gadgetplug.ng`) and its complaints are **invented** and labelled on screen as an example. The green result uses the real `@shiproafrica` numbers read on mainnet on 1 Nov 2026. The order assistant's answer in the demo is a fixed stand-in |
| Cards | `v2/production/film.html` (problem figures, Textile FX, returns, safety, use cases, mainnet proof); `render.mjs` draws each scene frame by frame |
| Edit | `v2/production/timeline.py` places each narration line on the moment it describes; `assemble.py` trims and speeds the recordings, labels Buyer/Supplier, and joins all scenes with crossfades |
| Sound | `v2/production/audio.py` synthesises the score and ducks it under the voice; `master.sh` normalises to −16 LUFS |

Every number and claim in the film is sourced in the main [README](../README.md).

## Rebuild

```bash
cd v2/recording && bash up.sh && node flowRV.cjs && node demos.cjs     # local chain, seed order, record demos
cd ../narration && python3 generate.py                                  # needs kokoro-onnx, sherpa-onnx, model files
cd ../production && python3 timeline.py && node render.mjs && python3 assemble.py && python3 audio.py && python3 captions.py && ./master.sh
```
