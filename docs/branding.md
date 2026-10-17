# sMackedOffice branding

The original custom logo is `packages/ui/src/assets/smackedoffice-logo.png`.
It was moved, unchanged, from the shell's `app-icon.png`. Its dark background is
part of the supplied image. Render it with its original proportions and colors;
do not invert it for dark themes or crop its corners.

Renderer imports can use `@genoffice/ui/branding/smackedoffice-logo.png`.
Electron main processes import the same source with electron-vite's `?asset`
suffix so the image is included in both standalone and shell builds. HTML entry
points use the shared favicon, and the update screen uses the shared logo.

After replacing the source image, regenerate platform assets from the repo root:

```sh
node tools/gen-branding-icons.mjs
```

This uses the existing Playwright dependency and installed Chrome. It generates:

- `packages/ui/src/assets/favicon.png` (32px).
- `apps/{shell,docs,slides}/build/icon.png`, `icon-mac.png`, `icon.ico`, and `icon.icns`.
- `apps/{shell,docs,slides}/build/icons/*.png` (16px through 1024px).

ICO files contain seven PNG sizes. ICNS files contain standard and Retina PNG
representations with transparent macOS margins. These are generated packaging
outputs, not separate logo sources. The shell's installer and uninstaller use
`build/icon.ico`; Linux uses `build/icons`; macOS and standalone builds use the
standard electron-builder build-resource names. Per-document file association
icons remain distinct from the application logo.

Branding covers the shell home/sidebar, first-run welcome, localized settings and
integration copy, update/password windows, shared About/help menus, editor window
titles, favicons, native window icons, assistant identities, and CLI display text.
Docs, Sheets, Slides, PDF, Markdown, and HTML keep their existing editor layouts.

Keep `@genoffice/*`, CLI commands, IPC/MCP identifiers, protocol schemes, app IDs,
font aliases, authentication endpoints, and stored document metadata unchanged.
Existing profile/save paths are also compatibility contracts: in particular,
packaged standalone Docs and Slides continue to use their prior profile folders.
Retain upstream authorship, licenses, notices, provider logos, and historical
documentation. Existing document authors named GenOffice remain user data.

Rebuild applications after changing assets. Previously generated installers in
`release/` need to be repackaged separately; changing source does not alter an
already installed application. Validate installer, dock/taskbar, and file
association appearance on each target operating system when packaging releases.
