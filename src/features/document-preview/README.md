# Document preview

The project editor supports read-only PDF, DOCX, XLSX and PPTX previews up to
20 MiB. Macros, legacy binary Office formats and encrypted Office containers
fall back to the existing system viewer action. Parsing failures do likewise.
The preview never writes a source file and does not promise Office layout fidelity.

The main reader owns project containment, descriptor identity and byte limits.
Safe links inside the project are accepted; escaping links are rejected. OpenXML
containers are checked before rendering: at most 10,000 entries, 64 MiB per entry
and 128 MiB total actual inflated bytes. Encrypted/ZIP64 containers are rejected.
Preload exposes only a typed read operation through the existing editor API.
Browser/server mode remains unsupported, matching the desktop project editor.

Flyfish React and the office preset are isolated in a local iframe with a stricter
CSP than the application. External document resources and navigation are blocked.
Parent and frame validate the WindowProxy, origin and versioned message identity;
only a basename and a bounded ArrayBuffer cross into the frame. No project path or
filesystem API is exposed to the viewer. A tab switch removes the frame; late IPC
responses are discarded. The official component destroys its controller on unmount.
PDF and XLSX readiness uses Flyfish's public thumbnail preparation lifecycle,
which waits for asynchronous parsing and reports parser failures. Each load has a
60-second timeout. These bounds do not guarantee an absolute parser RAM/CPU ceiling.
XLSX keeps a light workbook surface at 100% zoom for readable authored cell colors.

The Vite plugin copies workers, WASM, fonts and vendor files from pinned npm
packages under `file-viewer/` for development and production. The standalone HTML
entry is packaged alongside the main renderer. No CDN or upload service is used.
Only the iframe permits WebAssembly compilation; the application CSP is unchanged.

Flyfish-authored packages use Apache-2.0. The office preset also includes its
upstream dependencies and their license notices; CAD/AGPL renderer packages are
not installed. Legacy binary PPT is outside this feature's accepted format set.
