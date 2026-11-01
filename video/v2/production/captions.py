"""Captions (SRT) from the timeline: one cue per narration line, split if long."""
import json, os
here = os.path.dirname(os.path.abspath(__file__)); T = json.load(open(f'{here}/timeline.json'))
ts = lambda x: f"{int(x//3600):02d}:{int(x%3600//60):02d}:{int(x%60):02d},{int(round((x%1)*1000)):03d}"
cues = []
for l in T['lines']:
    words = l['text'].split(); parts = [words] if len(words) <= 14 else [words[:len(words)//2], words[len(words)//2:]]
    n = sum(len(p) for p in parts); a = l['at']
    for p in parts:
        d = l['dur'] * len(p) / n; cues.append((a, a + d, ' '.join(p))); a += d
open(f'{here}/../Arra_Demo.srt', 'w').write('\n'.join(f"{i+1}\n{ts(a)} --> {ts(b)}\n{t}\n" for i, (a, b, t) in enumerate(cues)))
print(len(cues), 'cues')
