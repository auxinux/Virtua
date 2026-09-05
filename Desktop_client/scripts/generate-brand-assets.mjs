import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const logoPath = join(root, "public", "logo-AuxiNux.png");
const brandDir = join(root, "public", "brand");
const iconDir = join(root, "src-tauri", "icons");

const logoBase64 = (await readFile(logoPath)).toString("base64");
const logoDataUrl = `data:image/png;base64,${logoBase64}`;

await mkdir(brandDir, { recursive: true });
await mkdir(iconDir, { recursive: true });

const wordmarkSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360" viewBox="0 0 1200 360">
  <defs>
    <filter id="shadow" x="-20%" y="-40%" width="140%" height="180%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000000" flood-opacity="0.6"/>
      <feDropShadow dx="0" dy="0" stdDeviation="18" flood-color="#f59e0b" flood-opacity="0.22"/>
    </filter>
    <linearGradient id="virtua" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#38bdf8"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="360" rx="0" fill="transparent"/>
  <image href="${logoDataUrl}" x="42" y="34" width="600" height="400" preserveAspectRatio="xMidYMid meet" filter="url(#shadow)"/>
  <g filter="url(#shadow)">
    <text x="628" y="166" fill="url(#virtua)" font-family="Inter, Arial, Helvetica, sans-serif" font-size="86" font-weight="800" letter-spacing="0">Virtua</text>
    <text x="634" y="218" fill="#e5e7eb" font-family="Inter, Arial, Helvetica, sans-serif" font-size="34" font-weight="700" letter-spacing="1">Desktop Client</text>
    <rect x="634" y="241" width="300" height="5" rx="2.5" fill="#f59e0b"/>
  </g>
</svg>
`;

const markSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#151b23"/>
      <stop offset="1" stop-color="#05080c"/>
    </linearGradient>
    <linearGradient id="orange" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd44d"/>
      <stop offset="0.52" stop-color="#ffb000"/>
      <stop offset="1" stop-color="#f97316"/>
    </linearGradient>
    <linearGradient id="silver" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.52" stop-color="#d7dde5"/>
      <stop offset="1" stop-color="#8f98a3"/>
    </linearGradient>
    <filter id="soft-shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="28" stdDeviation="28" flood-color="#000000" flood-opacity="0.7"/>
      <feDropShadow dx="0" dy="0" stdDeviation="20" flood-color="#f59e0b" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="188" fill="url(#bg)"/>
  <rect x="92" y="92" width="840" height="840" rx="164" fill="none" stroke="#2d3744" stroke-width="10"/>
  <g filter="url(#soft-shadow)" stroke="#050505" stroke-width="18" stroke-linejoin="round">
    <text x="197" y="592" fill="url(#orange)" font-family="Arial Black, Impact, Arial, sans-serif" font-size="360" font-weight="900" font-style="italic">A</text>
    <text x="450" y="592" fill="url(#silver)" font-family="Arial Black, Impact, Arial, sans-serif" font-size="350" font-weight="900" font-style="italic">N</text>
  </g>
  <g transform="translate(620 650)">
    <rect x="0" y="0" width="210" height="142" rx="28" fill="#0b1220" stroke="#2563eb" stroke-width="16"/>
    <path d="M48 47 L86 71 L48 95" fill="none" stroke="#38bdf8" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M106 98 H158" fill="none" stroke="#f59e0b" stroke-width="16" stroke-linecap="round"/>
  </g>
</svg>
`;

await writeFile(join(brandDir, "auxinux-virtua-logo.svg"), wordmarkSvg);
await writeFile(join(brandDir, "auxinux-virtua-mark.svg"), markSvg);
await writeFile(join(iconDir, "app-icon-source.svg"), markSvg);

const tempDir = await mkdtemp(join(tmpdir(), "auxinux-virtua-icons-"));
const png1024 = join(tempDir, "app-icon.png");

await exec("sips", ["-s", "format", "png", join(iconDir, "app-icon-source.svg"), "--out", png1024]);
await exec("sips", ["-z", "1024", "1024", png1024, "--out", join(iconDir, "icon.png")]);

for (const size of [32, 128, 256, 512]) {
  await exec("sips", ["-z", String(size), String(size), png1024, "--out", join(iconDir, `${size}x${size}.png`)]);
}
await exec("sips", ["-z", "256", "256", png1024, "--out", join(iconDir, "128x128@2x.png")]);

const iconset = join(tempDir, "AuxiNuxVirtua.iconset");
await mkdir(iconset, { recursive: true });
const iconsetSizes = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];
for (const [name, size] of iconsetSizes) {
  await exec("sips", ["-z", String(size), String(size), png1024, "--out", join(iconset, name)]);
}
await exec("iconutil", ["-c", "icns", iconset, "-o", join(iconDir, "icon.icns")]);

await rm(tempDir, { recursive: true, force: true });
console.log("Generated AuxiNux Virtua brand assets.");
