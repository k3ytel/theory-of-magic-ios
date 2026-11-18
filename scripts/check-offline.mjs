#!/usr/bin/env node
/**
 * Scan a built www folder for http:// and https:// references.
 *
 * Every hit is printed. Hits that are known to be inert (XML namespace
 * identifiers and Vue's error-message documentation link, which are strings
 * and never fetched) are labelled as such; anything else fails the check.
 */
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] || "www");
const INERT = [
	/^http:\/\/www\.w3\.org\//, // SVG / XLink / MathML / XHTML namespace URIs
	/^https:\/\/vuejs\.org\/error-reference\//, // text inside Vue error messages
];
const TEXT_EXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".webmanifest", ".map"]);

function* walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

let bad = 0;
let inert = 0;
let files = 0;
for (const file of walk(dir)) {
	files++;
	if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
	const text = fs.readFileSync(file, "utf8");
	for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\\]*/g)) {
		const url = m[0];
		const rel = path.relative(dir, file).replace(/\\/g, "/");
		if (INERT.some(re => re.test(url))) {
			inert++;
			console.log(`  inert   ${rel}: ${url}`);
		} else {
			bad++;
			console.log(`  NETWORK ${rel}: ${url}`);
		}
	}
}
console.log(`[check-offline] scanned ${files} files in ${dir}: ${bad} network reference(s), ${inert} inert string(s)`);
if (bad) process.exit(1);
