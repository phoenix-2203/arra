// Arra logo files: wordmark (A·rr·a, lime "rr") and a square icon, rendered with the brand font.
import { Resvg } from "/root/arra/agent/node_modules/@resvg/resvg-js/index.js";
import { writeFileSync } from "node:fs";
const F = "/root/arra/agent/assets/fonts/BricolageGrotesque_700Bold.ttf";
const word = (bg, fg) => `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600" viewBox="0 0 1600 600">${bg ? `<rect width="1600" height="600" fill="${bg}"/>` : ""}<text x="800" y="400" text-anchor="middle" font-family="Bricolage Grotesque" font-weight="700" font-size="360" letter-spacing="-12" fill="${fg}">A<tspan fill="#ccff3d">rr</tspan>a</text></svg>`;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="224" fill="#090a07"/><text x="512" y="660" text-anchor="middle" font-family="Bricolage Grotesque" font-weight="700" font-size="560" letter-spacing="-30" fill="#ccff3d">rr</text></svg>`;
const png = (svg, out) => writeFileSync(out, new Resvg(svg, { font: { fontFiles: [F], loadSystemFonts: false } }).render().asPng());
png(word("#090a07", "#eef2ea"), "arra-wordmark-dark.png");
png(word(null, "#090a07"), "arra-wordmark-light.png");
png(word(null, "#eef2ea"), "arra-wordmark-on-dark-transparent.png");
png(icon, "arra-icon-1024.png");
writeFileSync("arra-icon.svg", icon);
console.log("ok");
