"""Lays the narration out in time; writes timeline.json (used by film.html, audio.py and captions.py)."""
import json, os
here = os.path.dirname(os.path.abspath(__file__))
L = json.load(open(f'{here}/../narration/lines.json'))
order = ['hook', 'problem', 'intro', 'describe', 'link', 'pay', 'textile', 'returns', 'deliver', 'safety', 'uses', 'proof', 'close']
# lead before the first line, gaps between lines, tail after the last line (seconds)
P = {
    'hook':     (1.0, [0.6], 1.1),
    'problem':  (0.5, [0.5, 0.6], 1.0),
    'intro':    (0.6, [0.6], 1.1),
    'describe': (0.5, [0.6], 1.0),
    'link':     (0.5, [0.6], 1.0),
    'pay':      (0.5, [0.7], 1.0),
    'textile':  (0.5, [0.6], 1.2),
    'returns':  (0.5, [0.7], 1.4),
    'deliver':  (0.5, [0.6], 1.0),
    'safety':   (0.5, [0.6], 1.0),
    'uses':     (0.5, [], 1.1),
    'proof':    (0.5, [0.5], 1.2),
    'close':    (0.7, [], 4.0),
}
X = 0.6
T, t = {'scenes': [], 'lines': []}, 0.0
for s in order:
    lead, gaps, tail = P[s]
    lines = [l for l in L if l['scene'] == s]
    u = lead; starts = []
    for i, l in enumerate(lines):
        starts.append(round(u, 3)); u += l['dur'] + (gaps[i] if i < len(gaps) else 0)
    dur = round(u + tail, 3)
    T['scenes'].append({'id': s, 'start': round(t, 3), 'dur': dur, 'lines': [{'at': round(t + a, 3), 'local': round(a, 3), 'dur': l['dur'], 'text': l['text'], 'file': l['file']} for a, l in zip(starts, lines)]})
    for a, l in zip(starts, lines): T['lines'].append({'scene': s, 'at': round(t + a, 3), 'dur': l['dur'], 'text': l['text'], 'file': l['file']})
    t += dur - X
T['total'] = round(t + X, 3)
T['crossfade'] = X
json.dump(T, open(f'{here}/timeline.json', 'w'), indent=1)
for s in T['scenes']: print(f"{s['id']:9s} start {s['start']:7.2f} dur {s['dur']:6.2f} lines {[x['local'] for x in s['lines']]}")
print('total', T['total'])
