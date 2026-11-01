"""Builds the demo scene clips (trim, speed up, 'Buyer'/'Supplier' label, hold to length), then joins
every scene with 0.5 s crossfades into picture.mp4 (silent, 1080p30)."""
import json, os, subprocess
here = os.path.dirname(os.path.abspath(__file__))
T = json.load(open(f'{here}/timeline.json'))
CLIPS = '/root/arra-e2e/clips'
FONT = '/root/arra/agent/assets/fonts/InstrumentSans_600SemiBold.ttf'
WHO = {'check': 'Buyer', 'proof': 'Supplier', 'describe': 'Buyer', 'link-a': 'Buyer', 'link-b': 'Supplier · in Chinese', 'link-c': 'Buyer',
       'lock-a': 'Buyer', 'lock-b': 'Supplier · in Chinese', 'ship-a': 'Supplier', 'ship-b': 'Buyer', 'after': 'Buyer'}
run = lambda a: subprocess.run(a, check=True)
os.makedirs(f'{here}/clips', exist_ok=True)
for sc in T['scenes']:
    if sc['type'] != 'demo': continue
    ins, parts = [], []
    for i, s in enumerate(sc['segs']):
        ins += ['-ss', str(s['from']), '-t', str(round(s['to'] - s['from'], 3)), '-i', f"{CLIPS}/{s['clip']}.mp4"]
        label = WHO[s['clip']]
        parts.append(f"[{i}:v]setpts=(PTS-STARTPTS)/{sc['speed']},fps=30,format=yuv420p,"
                     f"drawtext=fontfile={FONT}:text='{label}':fontsize=30:fontcolor=0x0b0d05:box=1:boxcolor=0xccff3d:boxborderw=16:x=w-tw-52:y=h-th-48[v{i}]")
    n = len(sc['segs'])
    fc = ';'.join(parts) + ';' + ''.join(f'[v{i}]' for i in range(n)) + f"concat=n={n}:v=1:a=0,tpad=stop_mode=clone:stop_duration=6,trim=duration={sc['dur']},setpts=PTS-STARTPTS[out]"
    run(['ffmpeg', '-v', 'error', '-y', *ins, '-filter_complex', fc, '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-r', '30', f"{here}/clips/{sc['id']}.mp4"])
    print('demo', sc['id'], sc['dur'])
# join everything with crossfades
X = T['crossfade']; ins = []
for sc in T['scenes']: ins += ['-i', f"{here}/clips/{sc['id']}.mp4"]
chain, prev = [], '[0:v]'
for i, sc in enumerate(T['scenes'][1:], 1):
    out = f'[x{i}]' if i < len(T['scenes']) - 1 else '[out]'
    chain.append(f"{prev}[{i}:v]xfade=transition=fade:duration={X}:offset={sc['start']}{out}")
    prev = out
pre = ';'.join(f'[{i}:v]settb=AVTB,fps=30,format=yuv420p[n{i}]' for i in range(len(T['scenes'])))
chain = [c.replace(f'[{i}:v]', f'[n{i}]', 1) if False else c for i, c in enumerate(chain)]
fc = pre + ';' + ';'.join(chain).replace('[0:v]', '[n0]')
for i in range(1, len(T['scenes'])): fc = fc.replace(f'[{i}:v]xfade', f'[n{i}]xfade')
fc += f";[out]fade=t=in:d=0.6,fade=t=out:st={T['total'] - 1.0}:d=1.0[final]"
run(['ffmpeg', '-v', 'error', '-y', *ins, '-filter_complex', fc, '-map', '[final]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', '30', f'{here}/picture.mp4'])
print(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f'{here}/picture.mp4'], capture_output=True, text=True).stdout.strip(), 's picture')
