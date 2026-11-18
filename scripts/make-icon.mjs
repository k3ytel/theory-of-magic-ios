#!/usr/bin/env node
/**
 * Generates the app icon (1024x1024, opaque) and plain dark launch-screen
 * images with no image libraries: shapes are rasterised with 4x4
 * supersampling and written with a tiny PNG encoder.
 *
 *   node scripts/make-icon.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "ios", "App", "App", "Assets.xcassets");

function encodePng(width, height, rgb) {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 3 + 1)] = 0; // filter: none
		rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(zlib.crc32(td) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: RGB (no alpha – required for app icons)
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const mix = (a, b, t) => a + (b - a) * t;
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Point-in-polygon (even-odd). */
function inPoly(x, y, pts) {
	let inside = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, yi] = pts[i];
		const [xj, yj] = pts[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function starPoints(cx, cy, rOuter, rInner, n, rot) {
	const pts = [];
	for (let i = 0; i < n * 2; i++) {
		const r = i % 2 === 0 ? rOuter : rInner;
		const a = rot + (i * Math.PI) / n;
		pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
	}
	return pts;
}

function renderIcon(S) {
	const c = S / 2;
	const k = S / 1024;
	const bgIn = hex("#3b2370");
	const bgOut = hex("#0c0718");
	const gold = hex("#f0cd78");
	const goldDeep = hex("#b8862f");
	const glow = hex("#8f6bff");
	const star = starPoints(c, c + 18 * k, 300 * k, 120 * k, 5, -Math.PI / 2);
	const small = [
		[c - 395 * k, c - 395 * k, 30 * k],
		[c + 405 * k, c - 330 * k, 20 * k],
		[c + 390 * k, c + 400 * k, 24 * k],
		[c - 400 * k, c + 370 * k, 16 * k],
	].map(([x, y, r]) => starPoints(x, y, r, r * 0.35, 4, -Math.PI / 2));

	const out = Buffer.alloc(S * S * 3);
	const SS = 4;
	for (let y = 0; y < S; y++) {
		for (let x = 0; x < S; x++) {
			let r = 0,
				g = 0,
				b = 0;
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const px = x + (sx + 0.5) / SS;
					const py = y + (sy + 0.5) / SS;
					const d = Math.hypot(px - c, py - c);
					// background radial gradient + soft violet glow
					const t = Math.min(1, d / (c * 1.25));
					let col = [mix(bgIn[0], bgOut[0], t), mix(bgIn[1], bgOut[1], t), mix(bgIn[2], bgOut[2], t)];
					const gl = Math.max(0, 1 - d / (380 * k)) ** 2 * 0.45;
					col = col.map((v, i) => mix(v, glow[i], gl));
					// gold shading top->bottom
					const gt = Math.min(1, Math.max(0, (py - (c - 420 * k)) / (840 * k)));
					const gc = [mix(gold[0], goldDeep[0], gt), mix(gold[1], goldDeep[1], gt), mix(gold[2], goldDeep[2], gt)];
					const ringOuter = Math.abs(d - 420 * k) < 16 * k;
					const ringInner = Math.abs(d - 375 * k) < 5 * k;
					if (ringOuter || ringInner || inPoly(px, py, star) || small.some(p => inPoly(px, py, p))) col = gc;
					r += col[0];
					g += col[1];
					b += col[2];
				}
			}
			const n = SS * SS;
			const o = (y * S + x) * 3;
			out[o] = Math.round(r / n);
			out[o + 1] = Math.round(g / n);
			out[o + 2] = Math.round(b / n);
		}
	}
	return out;
}

function solid(S, color) {
	const [r, g, b] = hex(color);
	const out = Buffer.alloc(S * S * 3);
	for (let i = 0; i < S * S; i++) {
		out[i * 3] = r;
		out[i * 3 + 1] = g;
		out[i * 3 + 2] = b;
	}
	return out;
}

const iconPath = path.join(ASSETS, "AppIcon.appiconset", "AppIcon-512@2x.png");
fs.writeFileSync(iconPath, encodePng(1024, 1024, renderIcon(1024)));
console.log("wrote", path.relative(ROOT, iconPath));

const splash = encodePng(2732, 2732, solid(2732, "#1a1a1a"));
for (const f of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
	const p = path.join(ASSETS, "Splash.imageset", f);
	fs.writeFileSync(p, splash);
	console.log("wrote", path.relative(ROOT, p));
}

// Also keep a copy at the repo root for the README.
fs.copyFileSync(iconPath, path.join(ROOT, "icon.png"));
