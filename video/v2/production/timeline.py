"""Timeline for the v2 film: card scenes (animated, film.html) and demo scenes (real app recordings
with a visible cursor). Demo lines are placed on the moment they describe; card lines run in order.
Writes timeline.json. Times in seconds."""
import json, os
here = os.path.dirname(os.path.abspath(__file__))
L = json.load(open(f'{here}/../narration/lines.json'))
CLIPS = '/root/arra-e2e/clips'
X = 0.6            # crossfade between scenes
GAP, LEAD, TAIL = 0.4, 0.5, 0.55
lines = {}
for l in L: lines.setdefault(l['scene'], []).append(l)
M = lambda c: json.load(open(f'{CLIPS}/{c}.json'))

# Demo scenes: segments of recorded clips (clip, from, to), a playback speed, and where each
# narration line starts, as a time in the source clip of a segment (it's mapped through the edit).
DEMOS = {
 'check':    {'speed': 1.1, 'segs': [('check', 0.2, 16.9), ('check', 16.9, M('check')['green'] + 0.3, 2.0), ('check', M('check')['green'] + 0.3, M('check')['_end'], 1.0),
                                     ('check', M('check')['_end'] - 0.04, M('check')['_end'], 0.012), ('proof', 4.6, M('proof')['confirmed'] + 1.4)],
              'at': [('check', 0.25), ('check', M('check')['posts'] - 0.3), (2, -0.25), (4, 0.0)]},
 'describe': {'speed': 1.2, 'segs': [('describe', 0.2, M('describe')['end'])],
              'at': [('describe', 0.25), ('describe', M('describe')['vague'] - 1.6)]},
 'link':     {'speed': 1.15, 'segs': [('link-a', 0.2, M('link-a')['end']), ('link-b', 0.2, M('link-b')['end']), ('link-c', 0.2, M('link-c')['_end'])],
              'at': [('link-a', 0.25), ('link-c', 0.4)]},
 'lock':     {'speed': 1.15, 'segs': [('lock-a', 0.2, M('lock-a')['end']), ('lock-b', 0.2, M('lock-b')['_end'])],
              'at': [('lock-a', 0.25)]},
 'ship':     {'speed': 1.3, 'segs': [('ship-a', 0.2, M('ship-a')['_end']), ('ship-b', 0.2, M('ship-b')['problem'] - 0.2), ('ship-b', M('ship-b')['problem_end'] + 1.8, M('ship-b')['_end']), ('ship-b', M('ship-b')['problem'] - 0.2, M('ship-b')['problem'] + 7.0)],
              'at': [('ship-a', 0.25), (2, 0.0), (3, 0.0)]},
 'after':    {'speed': 1.45, 'segs': [('after', 0.2, M('after')['revealed'] + 0.3), ('after', M('after')['end'] - 3.0, M('after')['_end'])],
              'at': [('after', 0.25)]},
}
ORDER = ['hook', 'problem', 'intro', 'check', 'describe', 'link', 'wallets', 'lock', 'textile', 'returns', 'ship', 'safety', 'after', 'uses', 'proof', 'close']
T = {'crossfade': X, 'scenes': [], 'lines': []}
t = 0.0
for sid in ORDER:
    ls = lines[sid]
    if sid in DEMOS:
        d = DEMOS[sid]; sp = d['speed']
        segs = []; acc = 0.0
        for seg in d['segs']:
            c, a, b = seg[:3]; ssp = seg[3] if len(seg) > 3 else sp
            segs.append({'clip': c, 'from': round(a, 3), 'to': round(b, 3), 'at': round(acc, 3), 'speed': ssp}); acc += (b - a) / ssp
        vis = acc
        locs = []; prev_end = 0.0
        for i, ref in enumerate(d['at']):
            if isinstance(ref[0], int): seg = segs[ref[0]]; want = seg['at'] + ref[1]
            else:
                seg = next(s for s in segs if s['clip'] == ref[0] and s['from'] <= ref[1] + 1e-6 <= s['to'] + 1e-6) if any(s['clip'] == ref[0] and s['from'] <= ref[1] <= s['to'] for s in segs) else next(s for s in segs if s['clip'] == ref[0])
                want = seg['at'] + max(0.0, ref[1] - seg['from']) / seg['speed']
            loc = max(want, prev_end + GAP if i else LEAD)
            locs.append(loc); prev_end = loc + ls[i]['dur']
        dur = max(vis, prev_end + TAIL)
        sc = {'id': sid, 'type': 'demo', 'start': round(t, 3), 'dur': round(dur, 3), 'speed': sp, 'segs': segs, 'visual': round(vis, 3)}
    else:
        locs = []; u = LEAD + (0.4 if sid in ('hook', 'close') else 0)
        for l in ls: locs.append(u); u += l['dur'] + GAP
        dur = u - GAP + TAIL + (2.0 if sid == 'close' else 0)
        sc = {'id': sid, 'type': 'card', 'start': round(t, 3), 'dur': round(dur, 3)}
    sc['lines'] = [{'local': round(a, 3), 'at': round(t + a, 3), 'dur': l['dur'], 'text': l['text'], 'file': l['file']} for a, l in zip(locs, ls)]
    T['scenes'].append(sc)
    for x in sc['lines']: T['lines'].append({'scene': sid, **x})
    t += sc['dur'] - X
T['total'] = round(t + X, 3)
json.dump(T, open(f'{here}/timeline.json', 'w'), indent=1)
for s in T['scenes']: print(f"{s['id']:9s} {s['type']:4s} start {s['start']:7.2f} dur {s['dur']:6.2f}" + (f" visual {s['visual']:5.2f}" if s['type'] == 'demo' else '') + f" lines {[x['local'] for x in s['lines']]}")
print('total', T['total'])
