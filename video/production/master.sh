#!/usr/bin/env bash
# Joins the picture (part1 + part2 from render.mjs) with the mix, normalises loudness to -16 LUFS,
# and writes video/Arra_Demo.mp4 (1080p30 H.264 + AAC 48 kHz stereo).
set -euo pipefail
cd "$(dirname "$0")"
printf "file 'part1.mp4'\nfile 'part2.mp4'\n" > parts.txt
ffmpeg -v error -y -f concat -safe 0 -i parts.txt -c copy frames.mp4
J=$(ffmpeg -hide_banner -nostats -i ../assets/audio/mix.wav -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/{/,/}/p')
M=$(echo "$J" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f\"measured_I={d['input_i']}:measured_TP={d['input_tp']}:measured_LRA={d['input_lra']}:measured_thresh={d['input_thresh']}:offset={d['target_offset']}\")")
ffmpeg -v error -y -i frames.mp4 -i ../assets/audio/mix.wav -map 0:v -map 1:a -c:v copy \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11:$M:linear=true,aresample=48000" -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart -shortest ../Arra_Demo.mp4
ffmpeg -v error -y -ss 46 -i ../Arra_Demo.mp4 -frames:v 1 -q:v 3 ../Arra_Thumbnail.jpg
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration,size -of compact ../Arra_Demo.mp4
