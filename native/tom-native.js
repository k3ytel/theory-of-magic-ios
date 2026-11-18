/*
 * Theory of Magic – iOS native shim (injected into the built index.html).
 *
 *  1. Layout: picks a viewport width the desktop-oriented UI fits into.
 *  2. Saves: mirrors every localStorage write into @capacitor/preferences
 *     (UserDefaults) and restores from it on startup when localStorage is
 *     missing or older. Runs BEFORE the game module is imported.
 *  3. Export / Import save via the clipboard (small floating button).
 *  4. Makes the game's own "Get Save" / "Hall Save" (blob downloads, which
 *     WKWebView can't do) copy the JSON to the clipboard instead.
 *
 * Classic script, no imports: talks to Capacitor through window.Capacitor,
 * which the native bridge injects at document start.
 */
(function () {
	"use strict";

	var GAME_ENTRY = "./js/wizrobe.js";
	var GROUP = "TheoryOfMagicSave";
	var TS_KEY = "__tom_ts"; // last-write timestamp, stored in both places
	var WIPE_IDB_KEY = "__tom_wipe_idb"; // set before reload after an import
	var INTERNAL = /^__tom_/;
	var EXPORT_PREFIX = "TOMSAVE1:";
	var IDB_NAME = "arcanum"; // game's IndexedDB (src/modules/persist/persist-db.js)

	var Cap = window.Capacitor;
	var isNative = !!(Cap && typeof Cap.isNativePlatform === "function" && Cap.isNativePlatform());

	function plugin(name) {
		if (!isNative) return null;
		try {
			return (Cap.Plugins && Cap.Plugins[name]) || (Cap.registerPlugin ? Cap.registerPlugin(name) : null);
		} catch (e) {
			console.warn("[tom] plugin " + name + " unavailable", e);
			return null;
		}
	}
	var Prefs = plugin("Preferences");
	var Clip = plugin("Clipboard");

	/* ------------------------------------------------------------------ */
	/* 1. Viewport                                                         */
	/* ------------------------------------------------------------------ */
	var PORTRAIT_WIDTH = 640;
	var LANDSCAPE_WIDTH = 1024;

	function applyViewport() {
		var meta = document.querySelector('meta[name="viewport"]');
		if (!meta) {
			meta = document.createElement("meta");
			meta.name = "viewport";
			document.head.appendChild(meta);
		}
		var shortSide = Math.min(screen.width, screen.height);
		var landscape = window.matchMedia("(orientation: landscape)").matches;
		var width = "device-width";
		// Phones only; iPads are wide enough for the native layout.
		if (shortSide < 600) width = String(landscape ? LANDSCAPE_WIDTH : PORTRAIT_WIDTH);
		var content = "width=" + width + ", viewport-fit=cover, user-scalable=no";
		if (width === "device-width") content += ", initial-scale=1, maximum-scale=1";
		if (meta.getAttribute("content") !== content) meta.setAttribute("content", content);
	}
	applyViewport();
	window.addEventListener("orientationchange", function () {
		setTimeout(applyViewport, 50);
	});
	window.matchMedia("(orientation: landscape)").addEventListener("change", applyViewport);

	/* ------------------------------------------------------------------ */
	/* 2. Save mirroring                                                   */
	/* ------------------------------------------------------------------ */
	var ls = window.localStorage;
	var proto = Storage.prototype;
	var rawSet = proto.setItem;
	var rawRemove = proto.removeItem;
	var rawClear = proto.clear;
	var rawGet = proto.getItem;

	function lsGet(k) {
		return rawGet.call(ls, k);
	}
	function lsSet(k, v) {
		rawSet.call(ls, k, v);
	}
	function lsRemove(k) {
		rawRemove.call(ls, k);
	}
	function lsKeys() {
		var out = [];
		for (var i = 0; i < ls.length; i++) out.push(ls.key(i));
		return out;
	}
	function gameKeys() {
		return lsKeys().filter(function (k) {
			return !INTERNAL.test(k);
		});
	}

	var frozen = false; // true while an import is being applied
	var dirty = Object.create(null);
	var pendingClear = false;
	var flushTimer = null;
	var flushChain = Promise.resolve();

	function bumpTs() {
		var prev = +lsGet(TS_KEY) || 0;
		var ts = Math.max(Date.now(), prev + 1);
		lsSet(TS_KEY, String(ts));
	}

	function scheduleFlush(delay) {
		if (!Prefs) return;
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = setTimeout(flush, delay == null ? 400 : delay);
	}

	/** Push dirty keys to Preferences. Data first, timestamp last. */
	function flush() {
		flushTimer = null;
		if (!Prefs) return Promise.resolve();
		flushChain = flushChain.then(function () {
			var keys = Object.keys(dirty);
			var doClear = pendingClear;
			dirty = Object.create(null);
			pendingClear = false;
			if (!keys.length && !doClear) return;

			var p = doClear ? Prefs.clear() : Promise.resolve();
			keys.forEach(function (k) {
				p = p.then(function () {
					var v = lsGet(k);
					return v === null ? Prefs.remove({ key: k }) : Prefs.set({ key: k, value: v });
				});
			});
			return p
				.then(function () {
					var ts = lsGet(TS_KEY);
					return ts ? Prefs.set({ key: TS_KEY, value: ts }) : null;
				})
				.catch(function (e) {
					console.warn("[tom] mirror flush failed", e);
					keys.forEach(function (k) {
						dirty[k] = true;
					});
					scheduleFlush(2000);
				});
		});
		return flushChain;
	}

	proto.setItem = function (k, v) {
		if (this !== ls) return rawSet.apply(this, arguments);
		if (frozen && !INTERNAL.test(String(k))) return;
		rawSet.call(this, k, v);
		if (!INTERNAL.test(String(k))) {
			bumpTs();
			dirty[String(k)] = true;
			scheduleFlush();
		}
	};
	proto.removeItem = function (k) {
		if (this !== ls) return rawRemove.apply(this, arguments);
		if (frozen && !INTERNAL.test(String(k))) return;
		rawRemove.call(this, k);
		if (!INTERNAL.test(String(k))) {
			bumpTs();
			dirty[String(k)] = true;
			scheduleFlush();
		}
	};
	proto.clear = function () {
		if (this !== ls) return rawClear.apply(this, arguments);
		if (frozen) return;
		rawClear.call(this);
		bumpTs();
		dirty = Object.create(null);
		pendingClear = true;
		scheduleFlush(0);
	};

	function deleteGameIdb() {
		return new Promise(function (res) {
			try {
				var req = indexedDB.deleteDatabase(IDB_NAME);
				req.onsuccess = req.onerror = req.onblocked = function () {
					res();
				};
			} catch (e) {
				res();
			}
		});
	}

	/** Replace all game keys in localStorage with `entries`. */
	function writeLocal(entries, ts) {
		gameKeys().forEach(function (k) {
			if (!(k in entries)) lsRemove(k);
		});
		Object.keys(entries).forEach(function (k) {
			lsSet(k, entries[k]);
		});
		lsSet(TS_KEY, String(ts));
	}

	function readAllPrefs() {
		return Prefs.keys().then(function (r) {
			var keys = (r.keys || []).filter(function (k) {
				return !INTERNAL.test(k);
			});
			var entries = {};
			return Promise.all(
				keys.map(function (k) {
					return Prefs.get({ key: k }).then(function (g) {
						if (g.value != null) entries[k] = g.value;
					});
				}),
			).then(function () {
				return entries;
			});
		});
	}

	/**
	 * Startup reconciliation. Resolves when it is safe to start the game.
	 * The game's IndexedDB loader is consulted before localStorage, so
	 * whenever localStorage is rewritten we drop the IndexedDB copy; the game
	 * then loads from localStorage and repopulates IndexedDB on its next save.
	 */
	function reconcile() {
		var wipe = lsGet(WIPE_IDB_KEY) === "1";
		var pre = wipe ? deleteGameIdb() : Promise.resolve();
		if (wipe) lsRemove(WIPE_IDB_KEY);
		if (!Prefs) return pre;

		return pre
			.then(function () {
				return Prefs.configure({ group: GROUP });
			})
			.then(function () {
				return Prefs.get({ key: TS_KEY });
			})
			.then(function (r) {
				var prefsTs = +(r && r.value) || 0;
				var localTs = +lsGet(TS_KEY) || 0;
				var localHasData = gameKeys().length > 0;

				// localTs is missing only if WebKit lost localStorage entirely.
				if (prefsTs > localTs || (prefsTs && !localTs && !localHasData)) {
					// localStorage missing or older -> restore from native.
					return readAllPrefs().then(function (entries) {
						if (!Object.keys(entries).length) return;
						console.log("[tom] restoring " + Object.keys(entries).length + " keys from Preferences");
						writeLocal(entries, prefsTs);
						return deleteGameIdb();
					});
				}
				if (localHasData && (localTs > prefsTs || !localTs)) {
					// Native copy missing or behind -> full push.
					return Prefs.keys().then(function (pk) {
						(pk.keys || []).forEach(function (k) {
							if (!INTERNAL.test(k) && lsGet(k) === null) dirty[k] = true;
						});
						gameKeys().forEach(function (k) {
							dirty[k] = true;
						});
						if (!localTs) bumpTs();
						return flush();
					});
				}
			});
	}

	function withTimeout(p, ms) {
		return Promise.race([
			p,
			new Promise(function (res) {
				setTimeout(res, ms);
			}),
		]);
	}

	function startGame() {
		var s = document.createElement("script");
		s.type = "module";
		s.src = GAME_ENTRY;
		document.head.appendChild(s);
	}

	withTimeout(
		reconcile().catch(function (e) {
			console.warn("[tom] reconcile failed", e);
		}),
		5000,
	).then(startGame);

	// Save + flush when the app goes to the background.
	document.addEventListener("visibilitychange", function () {
		if (document.visibilityState !== "hidden") return;
		try {
			var btn = document.querySelector(".top-bar .load-opts button");
			if (btn && btn.textContent.trim() === "Save" && !frozen) btn.click();
		} catch (e) {}
		setTimeout(function () {
			flush();
		}, 150);
		flush();
	});

	/* ------------------------------------------------------------------ */
	/* 3. Clipboard helpers + Export / Import UI                           */
	/* ------------------------------------------------------------------ */
	function copyText(text) {
		if (Clip) return Clip.write({ string: text });
		if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
		return Promise.reject(new Error("Clipboard unavailable"));
	}
	function pasteText() {
		if (Clip)
			return Clip.read().then(function (r) {
				return r.value || "";
			});
		if (navigator.clipboard && navigator.clipboard.readText) return navigator.clipboard.readText();
		return Promise.resolve(window.prompt("Paste your save:") || "");
	}

	function b64encode(str) {
		var bytes = new TextEncoder().encode(str);
		var bin = "";
		for (var i = 0; i < bytes.length; i += 0x8000) {
			bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		return btoa(bin);
	}
	function b64decode(b64) {
		var bin = atob(b64.replace(/\s+/g, ""));
		var bytes = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new TextDecoder().decode(bytes);
	}

	function triggerGameSave() {
		var btn = document.querySelector(".top-bar .load-opts button");
		if (btn && btn.textContent.trim() === "Save") btn.click();
	}

	function exportSave() {
		triggerGameSave();
		// Give the async game save (IndexedDB first, then localStorage) a moment.
		return new Promise(function (res) {
			setTimeout(res, 600);
		}).then(function () {
			var keys = {};
			gameKeys().forEach(function (k) {
				keys[k] = lsGet(k);
			});
			if (!keys.hall) throw new Error("No save found yet. Play a bit, then try again.");
			var payload = { app: "theory-of-magic", v: 1, ts: +lsGet(TS_KEY) || Date.now(), keys: keys };
			return copyText(EXPORT_PREFIX + b64encode(JSON.stringify(payload)));
		});
	}

	function parseImport(text) {
		text = (text || "").trim();
		if (!text) throw new Error("Clipboard is empty.");
		var json = text.indexOf(EXPORT_PREFIX) === 0 ? b64decode(text.slice(EXPORT_PREFIX.length)) : text;
		var data;
		try {
			data = JSON.parse(json);
		} catch (e) {
			throw new Error("Clipboard does not contain a Theory of Magic save.");
		}
		if (!data || typeof data.keys !== "object" || !data.keys.hall) {
			throw new Error("Clipboard does not contain an exported Theory of Magic save.");
		}
		var entries = {};
		Object.keys(data.keys).forEach(function (k) {
			if (!INTERNAL.test(k) && typeof data.keys[k] === "string") entries[k] = data.keys[k];
		});
		return entries;
	}

	function importSave() {
		return pasteText().then(function (text) {
			var entries = parseImport(text);
			if (!window.confirm("Replace your current save with the one from the clipboard? This cannot be undone.")) {
				return false;
			}
			frozen = true; // stop the running game from saving over the import
			if (flushTimer) clearTimeout(flushTimer);
			dirty = Object.create(null);
			var ts = Math.max(Date.now(), (+lsGet(TS_KEY) || 0) + 1);
			writeLocal(entries, ts);
			lsSet(WIPE_IDB_KEY, "1");
			var p = Promise.resolve();
			if (Prefs) {
				p = flushChain
					.then(function () {
						return Prefs.clear();
					})
					.then(function () {
						return Promise.all(
							Object.keys(entries).map(function (k) {
								return Prefs.set({ key: k, value: entries[k] });
							}),
						);
					})
					.then(function () {
						return Prefs.set({ key: TS_KEY, value: String(ts) });
					});
			}
			return p.then(function () {
				location.reload();
				return true;
			});
		});
	}

	function toast(msg, isError) {
		var t = document.createElement("div");
		t.className = "tom-toast" + (isError ? " tom-error" : "");
		t.textContent = msg;
		document.body.appendChild(t);
		setTimeout(function () {
			t.remove();
		}, 2600);
	}

	function buildUi() {
		if (document.getElementById("tom-save-fab")) return;
		var fab = document.createElement("button");
		fab.id = "tom-save-fab";
		fab.type = "button";
		fab.title = "Export / Import save";
		fab.textContent = "⇅";

		var panel = document.createElement("div");
		panel.id = "tom-save-panel";
		panel.hidden = true;
		panel.innerHTML =
			'<div class="tom-title">Save backup</div>' +
			'<button type="button" data-act="export">Export save (copy)</button>' +
			'<button type="button" data-act="import">Import save (paste)</button>' +
			'<div class="tom-hint">Saves are also mirrored to the device automatically.</div>';

		fab.addEventListener("click", function (e) {
			e.stopPropagation();
			panel.hidden = !panel.hidden;
		});
		document.addEventListener("click", function (e) {
			if (!panel.hidden && !panel.contains(e.target) && e.target !== fab) panel.hidden = true;
		});
		panel.addEventListener("click", function (e) {
			var act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
			if (!act) return;
			panel.hidden = true;
			if (act === "export") {
				exportSave().then(
					function () {
						toast("Save copied to clipboard");
					},
					function (err) {
						toast(err.message || String(err), true);
					},
				);
			} else if (act === "import") {
				importSave().then(
					function (done) {
						if (done) toast("Save imported – reloading…");
					},
					function (err) {
						frozen = false;
						toast(err.message || String(err), true);
					},
				);
			}
		});
		document.body.appendChild(panel);
		document.body.appendChild(fab);
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildUi);
	else buildUi();

	/* ------------------------------------------------------------------ */
	/* 4. Game "Get Save" / "Hall Save" -> clipboard                       */
	/* ------------------------------------------------------------------ */
	var rawAnchorClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () {
		var href = this.href || "";
		if (this.download && href.indexOf("blob:") === 0) {
			var name = this.download;
			fetch(href)
				.then(function (r) {
					return r.text();
				})
				.then(copyText)
				.then(
					function () {
						toast(name + " copied to clipboard");
					},
					function (err) {
						toast("Copy failed: " + (err.message || err), true);
					},
				);
			return;
		}
		return rawAnchorClick.apply(this, arguments);
	};

	// Never let the web view navigate away from the game.
	document.addEventListener(
		"click",
		function (e) {
			var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
			if (a && /^https?:/i.test(a.getAttribute("href") || "")) {
				e.preventDefault();
			}
		},
		true,
	);
})();
