#!/usr/bin/env node
/**
 * Build the Arcanum web game into ./www for Capacitor, fully offline.
 *
 *  1. Copy the upstream sources (git submodule ./arcanum) to ./build/arcanum
 *     so the submodule itself is never modified.
 *  2. Apply small source patches (remove external links).
 *  3. npm ci (with our pinned lockfile) + vite build --base ./
 *  4. Post-process index.html: drop Google Fonts, tighten the CSP to local
 *     origins only, vendor Open Sans, inject the native shim which then
 *     starts the game module once saves are restored.
 *  5. Fail if any network URL is left that could be fetched at runtime.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.resolve(ROOT, process.env.ARCANUM_DIR || "arcanum");
const WORK = path.join(ROOT, "build", "arcanum");
const OUT = path.join(ROOT, "www");
const isWin = process.platform === "win32";

function log(msg) {
	console.log(`[build-web] ${msg}`);
}

function run(cmd, args, cwd) {
	log(`$ ${cmd} ${args.join(" ")}  (in ${path.relative(ROOT, cwd) || "."})`);
	// npm is a .cmd shim on Windows and needs a shell; node itself must not
	// (its path contains spaces).
	execFileSync(cmd, args, { cwd, stdio: "inherit", shell: isWin && cmd === "npm" });
}

/** Replace `search` (string or RegExp) in a file; assert the expected number of hits. */
function patchFile(rel, search, replace, expected) {
	const file = path.join(WORK, rel);
	let text = fs.readFileSync(file, "utf8");
	const hits = typeof search === "string" ? text.split(search).length - 1 : (text.match(search) || []).length;
	if (expected != null && hits !== expected) {
		throw new Error(`patch ${rel}: expected ${expected} match(es) for ${search}, found ${hits}`);
	}
	text = typeof search === "string" ? text.split(search).join(replace) : text.replace(search, replace);
	fs.writeFileSync(file, text);
	log(`patched ${rel} (${hits} change(s))`);
}

// ---------------------------------------------------------------- 1. copy
if (!fs.existsSync(path.join(SRC, "package.json"))) {
	throw new Error(`Upstream sources not found at ${SRC}. Run: git submodule update --init`);
}
const SKIP = new Set([".git", "node_modules", "dev", "dist", "docs"]);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
for (const entry of fs.readdirSync(SRC)) {
	if (SKIP.has(entry)) continue;
	fs.cpSync(path.join(SRC, entry), path.join(WORK, entry), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, "arcanum.package-lock.json"), path.join(WORK, "package-lock.json"));
log(`copied upstream sources from ${path.relative(ROOT, SRC)}`);

// ---------------------------------------------------------------- 2. patch
// External community links in the top bar (Test site, Discord, Wiki, Reddit).
patchFile("src/ui/top-bar.vue", /[ \t]*<a class="item" href="https?:\/\/[^\n]*\r?\n/g, "", 4);

// ---------------------------------------------------------------- 3. build
run("npm", ["ci", "--no-audit", "--no-fund"], WORK);
run(
	process.execPath,
	[path.join("node_modules", "vite", "bin", "vite.js"), "build", "--base", "./", "--outDir", OUT, "--emptyOutDir"],
	WORK,
);

// ---------------------------------------------------------------- 4. post-process
const indexPath = path.join(OUT, "index.html");
let html = fs.readFileSync(indexPath, "utf8");

function htmlReplace(re, replacement, label) {
	const n = (html.match(re) || []).length;
	if (n !== 1) throw new Error(`index.html: expected exactly 1 ${label}, found ${n}`);
	html = html.replace(re, replacement);
}

// Remote Google Fonts stylesheet -> vendored Open Sans.
htmlReplace(
	/<link[^>]+href="https:\/\/fonts\.googleapis\.com[^"]*"[^>]*>/g,
	'<link rel="stylesheet" href="./fonts/open-sans/400.css"><link rel="stylesheet" href="./fonts/open-sans/700.css">',
	"Google Fonts link",
);

// CSP: local origins only (capacitor://localhost is the app's own origin on iOS).
const csp = [
	"default-src 'self' capacitor://localhost",
	"connect-src 'self' capacitor://localhost",
	"img-src 'self' capacitor://localhost data: blob:",
	"script-src 'self' capacitor://localhost 'unsafe-eval'",
	"style-src 'self' capacitor://localhost 'unsafe-inline'",
	"font-src 'self' capacitor://localhost data:",
	"media-src 'self' capacitor://localhost data: blob:",
	"object-src 'none'",
].join("; ");
htmlReplace(
	/<meta http-equiv="Content-Security-Policy"[^>]*>/g,
	`<meta http-equiv="Content-Security-Policy" content="${csp}">`,
	"CSP meta",
);

// The game entry is started by tom-native.js after save restore.
htmlReplace(
	/<script type="module"[^>]*src="\.\/js\/wizrobe\.js"[^>]*><\/script>/g,
	'<link rel="modulepreload" href="./js/wizrobe.js">',
	"game entry script",
);

// Viewport (tom-native.js adjusts the width per orientation).
htmlReplace(
	/<meta name="viewport"[^>]*>/g,
	'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">',
	"viewport meta",
);

// Shim + native CSS at the end of <head> (after the game CSS so it can override).
htmlReplace(
	/<\/head>/g,
	'<meta name="format-detection" content="telephone=no"><link rel="stylesheet" href="./tom-native.css"><script src="./tom-native.js"></script></head>',
	"</head>",
);
fs.writeFileSync(indexPath, html);
log("patched www/index.html");

// Native shim files.
for (const f of ["tom-native.js", "tom-native.css"]) {
	fs.copyFileSync(path.join(ROOT, "native", f), path.join(OUT, f));
}

// Vendored Open Sans (400 + 700, all subsets referenced by the CSS).
const fontPkg = path.join(ROOT, "node_modules", "@fontsource", "open-sans");
const fontOut = path.join(OUT, "fonts", "open-sans");
fs.mkdirSync(path.join(fontOut, "files"), { recursive: true });
for (const css of ["400.css", "700.css"]) {
	const text = fs.readFileSync(path.join(fontPkg, css), "utf8");
	fs.writeFileSync(path.join(fontOut, css), text);
	for (const m of text.matchAll(/url\(\.\/files\/([^)]+)\)/g)) {
		fs.copyFileSync(path.join(fontPkg, "files", m[1]), path.join(fontOut, "files", m[1]));
	}
}
fs.copyFileSync(path.join(fontPkg, "LICENSE"), path.join(fontOut, "LICENSE"));
log("vendored Open Sans");

// ---------------------------------------------------------------- 5. verify
run(process.execPath, [path.join(ROOT, "scripts", "check-offline.mjs"), OUT], ROOT);
log("done -> www/");
