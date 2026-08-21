# 11 · Desktop signing & autoupdate

Status: draft. How the macOS desktop app (M6) is signed, notarized, and auto-updates — reusing the existing Apple Developer account.

## Two kinds of signing

1. **Apple code signing + notarization** — proves the `.app`/`.dmg` comes from a known developer so macOS runs it without warnings. Uses a **Developer ID Application** certificate and Apple notarization. These are **account-level**, so the same credentials used elsewhere (e.g. an Electron project via electron-builder) work here — only the variable *names* differ.
2. **Tauri updater signing** — a separate keypair Tauri uses to sign update packages so the app trusts them. This is Tauri-specific; there is no equivalent in an Electron setup, so it's a **new secret**. The public key is committed in `apps/desktop/src-tauri/tauri.conf.json`; the private key is a secret.

## Variable mapping (electron-builder / Brainstorm → Tauri)

`bun run desktop:build` (and the release workflow) accept either name; the build maps them:

| Purpose | Brainstorm / electron-builder | Tauri |
|---------|-------------------------------|-------|
| Developer ID cert (base64 .p12) | `CSC_LINK` / `MAC_CSC_LINK` | `APPLE_CERTIFICATE` |
| …its password | `CSC_KEY_PASSWORD` / `MAC_CSC_KEY_PASSWORD` | `APPLE_CERTIFICATE_PASSWORD` |
| Notarize (Apple ID) | `APPLE_ID` | `APPLE_ID` |
| …app-specific password | `APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_PASSWORD` |
| …team id | `APPLE_TEAM_ID` | `APPLE_TEAM_ID` |
| Notarize (API key) — key id | `APPLE_API_KEY_ID` | `APPLE_API_KEY` |
| …issuer | `APPLE_API_ISSUER` | `APPLE_API_ISSUER` |
| …key file path (.p8) | `APPLE_API_KEY` | `APPLE_API_KEY_PATH` |
| Updater private key (**new**) | — | `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) |

## Local signed build

```sh
# Apple creds (reuse your existing ones) + the updater key, in your env:
export CSC_LINK=... CSC_KEY_PASSWORD=... APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=...
export TAURI_SIGNING_PRIVATE_KEY="$(cat /path/to/swarm-updater.key)"
bun run desktop:build      # signs + notarizes, and emits updater artifacts + .sig
```
With none set, `desktop:build` produces an unsigned dev build.

## CI (GitHub Releases)

`.github/workflows/release.yml` builds on a `v*` tag. Set these **repository secrets** (the Apple ones are the same values used for the other project):

`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty if the key has no password).

The workflow uploads the `.dmg` plus the updater artifacts and `latest.json` to a draft Release; the app's updater polls `releases/latest/download/latest.json`.

## The updater keypair

Generated once with `bunx tauri signer generate`. The **public** key lives in `tauri.conf.json`. Keep the **private** key secret (repo secret + a safe backup) — losing it means shipped apps can no longer verify updates.
