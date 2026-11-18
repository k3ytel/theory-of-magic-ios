# Theory of Magic – offline iOS wrapper

An unofficial, fully offline iOS build of the idle game **Theory of Magic**
(Arcanum, [gitlab.com/mathiashjelm/arcanum](https://gitlab.com/mathiashjelm/arcanum), MIT licence),
wrapped with [Capacitor](https://capacitorjs.com) and built **without code signing**
on GitHub Actions, for sideloading (AltStore, SideStore, Sideloadly, …).

<img src="icon.png" width="128" alt="App icon">

* Bundle id: `com.k3ytel.theoryofmagic` (never changes, so reinstalling keeps your save)
* Upstream game is pinned as a git submodule (`arcanum/`); this repo never modifies it.

## Getting the .ipa

Every push to `main` runs [`.github/workflows/ios.yml`](.github/workflows/ios.yml), which produces the
artifact **TheoryOfMagic-unsigned-ipa**. With the GitHub CLI:

```bash
gh run download --repo k3ytel/theory-of-magic-ios --name TheoryOfMagic-unsigned-ipa
```

Sign/install it with your sideloading tool of choice.

## What the wrapper changes

| Area | How |
| --- | --- |
| **Offline** | Google Fonts → vendored Open Sans (`@fontsource/open-sans`); CSP restricted to the app's own origin; external Discord/Wiki/Reddit/test-site links removed; web view never navigates to http(s) links. The build fails if any network URL is left in `www/` (`scripts/check-offline.mjs`). |
| **Saves** | The game saves to IndexedDB + localStorage. `native/tom-native.js` mirrors every localStorage write to native storage (`@capacitor/preferences` / UserDefaults). On launch, before the game starts, it restores from native storage when localStorage is missing or older (and drops the stale IndexedDB copy so the restored data is what loads). The game is also saved when the app goes to the background. |
| **Export / Import** | Floating ⇅ button (bottom-right): *Export save* copies a `TOMSAVE1:` string to the clipboard, *Import save* reads it back from the clipboard. The game's own *Get Save* / *Hall Save* buttons copy their JSON to the clipboard (WKWebView can't download files). |
| **Native feel** | Fullscreen (status bar + home indicator hidden), web view pinned to the safe area (notch / Dynamic Island / home indicator), no bounce scrolling, no zoom / callouts, portrait + landscape. On phones the desktop UI is laid out at 640 px (portrait) / 1024 px (landscape) and scaled to fit. |

## Layout

```
arcanum/                 upstream game (submodule, pinned)
arcanum.package-lock.json  lockfile used for the upstream build
native/                  injected shim (tom-native.js / .css)
scripts/build-web.mjs    copy → patch → vite build → post-process → offline check
scripts/check-offline.mjs
scripts/make-icon.mjs    generates the app icon + launch images
ios/                     Capacitor iOS project (SPM)
```

## Building locally

```bash
git submodule update --init
npm ci
npm run build:web     # -> www/
npx cap sync ios      # then open ios/App/App.xcodeproj on a Mac
```

To update the game, move the submodule to a newer upstream commit, refresh
`arcanum.package-lock.json` if upstream dependencies changed, and push.
