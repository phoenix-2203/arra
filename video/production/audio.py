"""Score + narration mix. The score is synthesised here (soft pad, sub, plucked pulse, scene swells),
ducked about 11 dB under speech. Writes assets/audio/voiceover.wav and assets/audio/mix.wav (48 kHz stereo)."""
import json, os
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, resample_poly
here = os.path.dirname(os.path.abspath(__file__)); V = f'{here}/../narration'; OUT = f'{here}/../assets/audio'
SR = 48000
T = json.load(open(f'{here}/timeline.json')); N = int((T['total'] + 0.5) * SR); t = np.arange(N) / SR
rng = np.random.default_rng(7)
# ---- voice
voice = np.zeros(N)
for l in T['lines']:
    a, sr = sf.read(f"{V}/{l['file']}")
    if a.ndim > 1: a = a.mean(1)
    a = resample_poly(a, SR, sr)
    i = int(l['at'] * SR); voice[i:i + len(a)] += a[:N - i]
voice *= 0.92 / max(1e-9, np.abs(voice).max())
# ---- score: D major-ish progression, 4 bars per chord, 84 BPM
hz = lambda m: 440 * 2 ** ((m - 69) / 12)
chords = [[50, 57, 62, 66], [47, 54, 62, 66], [43, 55, 59, 62], [45, 52, 57, 61]]  # D, Bm, G, A
beat = 60 / 84; bar = 4 * beat
pad = np.zeros(N); sub = np.zeros(N); pl = np.zeros(N)
for k in range(int(T['total'] / bar) + 2):
    c = chords[(k // 2) % 4]; s0 = k * bar
    i0, i1 = int(s0 * SR), min(N, int((s0 + bar + 0.6) * SR))
    if i0 >= N: break
    tt = t[i0:i1] - s0
    env = np.clip(tt / 0.9, 0, 1) * np.clip((bar + 0.6 - tt) / 0.9, 0, 1)
    for m in c:
        f = hz(m)
        pad[i0:i1] += env * (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * f * 1.003 * tt + 1) + 0.15 * np.sin(2 * np.pi * 2 * f * tt)) / 4
    sub[i0:i1] += env * np.sin(2 * np.pi * hz(c[0] - 12) * tt) * 0.6
    for b in range(4):  # soft plucked pulse on each beat, chord tones
        j0 = int((s0 + b * beat) * SR); j1 = min(N, j0 + int(0.7 * SR))
        if j0 >= N: continue
        u = t[j0:j1] - (s0 + b * beat); f = hz(c[(b + k) % 4] + 12)
        pl[j0:j1] += np.sin(2 * np.pi * f * u) * np.exp(-u * 7) * 0.35
sos = butter(2, 1800, 'low', fs=SR, output='sos'); pad = sosfilt(sos, pad)
music = 0.55 * pad + 0.35 * sub + 0.22 * pl
# scene swells: a short filtered-noise whoosh at each scene change
for sc in T['scenes'][1:]:
    i0 = int((sc['start'] - 0.5) * SR); L = int(1.0 * SR)
    if i0 < 0 or i0 + L > N: continue
    nz = sosfilt(butter(2, [300, 3000], 'band', fs=SR, output='sos'), rng.standard_normal(L))
    w = np.sin(np.linspace(0, np.pi, L)) ** 2
    music[i0:i0 + L] += nz * w * 0.05
# fade in / out
music *= np.clip(t / 2.5, 0, 1) * np.clip((T['total'] - t) / 4.0, 0, 1)
# ducking under speech (smoothed envelope)
envv = np.abs(voice); k = int(0.25 * SR); envv = np.convolve(envv, np.ones(k) / k, 'same')
duck = 1 - 0.72 * np.clip(envv / 0.04, 0, 1)
music = music / max(1e-9, np.abs(music).max()) * 0.32 * duck
L_ = voice + music * 1.0; R_ = voice + music * 0.96
mix = np.stack([L_, R_], 1); mix *= 0.95 / np.abs(mix).max()
sf.write(f'{OUT}/voiceover.wav', voice, SR); sf.write(f'{OUT}/mix.wav', mix, SR)
print('mix', round(N / SR, 2), 's')
