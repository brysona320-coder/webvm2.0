# BLACKWIRE / WebVM 2.0

A pentesting-inspired workstation with a **real Debian terminal running entirely in your browser**. No separate Debian machine, SSH server, or terminal bridge is needed.

BLACKWIRE is a custom frontend built on [WebVM](https://github.com/leaningtech/webvm), [CheerpX](https://cheerpx.io/), and xterm.js. Debian programs run through CheerpX's x86-to-WebAssembly engine and Linux syscall emulation. This is a genuine Linux userspace, with the compatibility limits of that engine; it is not a full hardware VM or an unrestricted Linux kernel.

## Open the app

After the GitHub Pages workflow succeeds, open:

**https://brysona320-coder.github.io/webvm2.0/**

1. Click **Boot Debian**. On the first boot the isolation service worker may reload the page once.
2. Wait for the real Bash prompt. The engine loads from Leaning Technologies; Debian disk blocks stream from WebVM as needed.
3. Use the terminal normally. Commands, pipes, scripts, history, tab completion, and Ctrl-C are handled by Bash and the running programs.
4. Open **Toolkit** to prepare a command. Commands are inserted without pressing Enter.

Use a current desktop browser with WebAssembly, SharedArrayBuffer, IndexedDB, and service workers enabled. Open the HTTPS URL in a normal top-level tab, not through `file://` or an embedded preview. First boot and disk reads depend on your connection to the external runtime and disk services.

## Tailscale networking

Click **Connect Tailscale**, follow the login link, approve the browser VM, and return to BLACKWIRE. The Network view shows the IP address and peer map returned by the actual Tailscale runtime; there are no generated Wi-Fi scan results.

**To reach the public internet, your tailnet needs an approved exit node.** The exit node can be your Windows PC; it does not need to run Debian. Follow the official [Windows exit node instructions](https://tailscale.com/docs/features/exit-nodes/how-to/setup?tab=windows). Advertise the exit node and approve it in the Tailscale admin console. WebVM uses an advertised exit node automatically. Tailnet policy still controls access.

For a connection check inside Debian:

```sh
curl -I https://example.com
```

The browser cannot access your physical Wi-Fi radio. Wireless scans, monitor mode, packet injection, and USB Wi-Fi passthrough are unavailable. Tailscale supplies routed network connectivity, not a virtual radio. ICMP `ping`, raw packet operations, and other kernel-dependent tools may not work; use ordinary TCP-based tools supported by WebVM. Access to other physical LAN hosts requires suitable Tailscale subnet routing.

No Tailscale auth key needs to be pasted into this app. Login goes directly to Tailscale in another tab. BLACKWIRE has no application backend or analytics.

## Storage and notes

- The base Debian image is read-only and loaded remotely on demand. Disk changes are stored in this browser's IndexedDB overlay.
- Your files remain tied to this site origin, browser profile, and device. Clearing site data removes them. Browser storage can also be evicted, so keep backups.
- The app requests a browser lock to prevent concurrent use of the same VM disk by two tabs where the Web Locks API is available.
- Field notes autosave in localStorage and can be exported as Markdown.
- **Export** downloads the terminal's current text buffer; it is not a disk backup.

## Deploy to GitHub Pages

The included `.github/workflows/pages.yml` validates the app, builds `dist/`, and publishes it on pushes to `main`.

If the first run cannot enable Pages automatically, open **Settings → Pages → Build and deployment → Source → GitHub Actions**, then rerun the workflow. The repository's Actions policy must permit the official GitHub Pages actions.

All asset paths are relative, so the app works below the `/webvm2.0/` project path. GitHub Pages cannot set custom COOP/COEP response headers; `service-worker.js` supplies them for same-origin resources after registration. `_headers` is also included for hosts that support that convention.

## Development

No dependency install is required for the frontend build:

```sh
npm test
npm run build
```

Serve `dist/` over HTTPS or localhost. A simple `python3 -m http.server --directory dist 8080` works at `http://localhost:8080/` with the isolation service worker. Opening files directly does not work.

`app.js` pins the hosted CheerpX runtime to **1.4.0** and the Debian disk to the image used by the current upstream WebVM terminal configuration. The CheerpX runtime is **referenced from its official host**, not copied into this repository. The vendored terminal assets come from WebVM's xterm directory.

## Licenses and credits

- BLACKWIRE frontend and WebVM integration: Apache License 2.0. See [LICENSE](./LICENSE).
- WebVM: [Leaning Technologies](https://github.com/leaningtech/webvm), Apache License 2.0.
- xterm.js and fit addon: MIT. See [THIRD-PARTY-NOTICES.txt](./THIRD-PARTY-NOTICES.txt).
- CheerpX is a separately licensed engine. Its public hosted runtime is free for individual technological exploration and testing. Organizational use and self-hosting the engine require an appropriate license. Review the [CheerpX licensing terms](https://cheerpx.io/docs/licensing).
- Debian packages retain their respective upstream licenses.

BLACKWIRE is an independent project and is not affiliated with Debian, Tailscale, or Leaning Technologies.
