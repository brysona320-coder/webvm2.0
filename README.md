# BLACKWIRE / WebVM 2.0

A pentesting-inspired workstation with a **real Debian terminal running entirely in your browser**. No separate Debian machine, SSH server, or terminal bridge is needed.

BLACKWIRE is a custom frontend built on [WebVM](https://github.com/leaningtech/webvm), [CheerpX](https://cheerpx.io/), and xterm.js. Debian programs run through CheerpX's x86-to-WebAssembly engine and Linux syscall emulation. This is a genuine Linux userspace, with the compatibility limits of that engine; it is not a full hardware VM or an unrestricted Linux kernel.

## Open the app

After the GitHub Pages workflow succeeds, open:

**https://brysona320-coder.github.io/webvm2.0/**

1. Click **Boot Debian**. On the first boot the isolation service worker may reload the page once.
2. Wait for the real Bash prompt. The engine loads from Leaning Technologies; verified Debian mini disk blocks stream from this GitHub Pages site as needed. Wisp connects automatically at `wss://anura.pro/`.
3. Use the terminal normally. Commands, pipes, scripts, history, tab completion, and Ctrl-C are handled by Bash and the running programs.
4. Open **Toolkit** to prepare a command. Commands are inserted without pressing Enter.

Use a current desktop browser with WebAssembly, SharedArrayBuffer, IndexedDB, and service workers enabled. Open the HTTPS URL in a normal top-level tab, not through `file://` or an embedded preview. First boot and disk reads depend on your connection to the external CheerpX runtime and this site’s disk files.

## Wisp networking (default)

The default protocol is **Wisp**, using **`wss://anura.pro/`** as requested. No Tailscale account, installed VPN client, Debian host, or exit node is needed. The VM runs locally; outbound connections pass through the selected third-party relay.

Open **Network** to choose a relay preset, enter a custom secure WebSocket URL, reconnect, or select Tailscale instead. Applying a different Wisp relay closes current network connections and reconnects without restarting Debian. Retry interrupted network commands afterwards. Switching between Wisp and Tailscale still offers a VM restart and keeps its disk.

**Test selected relay** works before booting Debian. It separately checks the Wisp handshake, a DNS answer through the relay, and an HTTP response from `example.com`. Each stage reports a real result; a handshake alone is never reported as successful internet access. The test does not change the VM’s selected relay. Public relay availability varies by network, so test a preset before applying it.

Included presets:

| Preset | Endpoint | Published source |
| --- | --- | --- |
| Anura (default) | `wss://anura.pro/` | User-selected endpoint |
| Anura alternate path | `wss://anura.pro/wisp/` | Same operator; separately tested endpoint |
| Mercury Workshop | `wss://wisp.mercurywork.shop/` | [Official transport documentation](https://github.com/MercuryWorkshop/bare-mux/blob/master/documentation/Upgrading.md) |
| RHW / SPLASH | `wss://wisp.rhw.one/wisp/` | [Operator’s project README](https://github.com/rhenryw/SPLASH) |
| Widgetry | `wss://relay.widgetry.org/` | [Anura’s published configuration](https://anura.pro/config.json) |

Custom relay URLs remain supported. Presets are endpoints, not uptime guarantees or an endorsement of a third-party operator. The app never silently moves your VM traffic to another server.

The CheerpX 1.4 custom network interface is backed by standard readable/writable streams. `wisp-network.js` adapts these to Wisp TCP and UDP streams. DNS datagrams on port 53 are carried as length-prefixed DNS-over-TCP through the same Wisp relay: Anura’s TCP path passed our DNS test while its UDP DNS path did not respond. DNS sends are asynchronous: a failed query does not block the UDP writer or prevent a nameserver retry. Other UDP destinations depend on relay policy. Wisp supplies outbound connections; it does not publish listening VM ports.

Test from the real Debian shell:

```sh
curl -I https://example.com
python3 -c "import socket; print(socket.gethostbyname('example.com'))"
```

Anura is an independent third-party relay. Its uptime, destination restrictions, and usage rules apply. A connected relay status confirms the handshake, not that every internet destination is reachable. If networking stops, use **Reconnect Wisp**, or test and apply another preset. The adapter clears failed handshakes and socket state so retries can start immediately. Cancelling a reader, a closed WebSocket, or a relay shutdown cannot interrupt local socket cleanup.

## Optional Tailscale networking

Select **Tailscale** in Network, save the connection, then click **Connect Tailscale**, follow the login link, approve the browser VM, and return to BLACKWIRE. The Network view shows the IP address and peer map returned by the actual Tailscale runtime; there are no generated Wi-Fi scan results.

**To reach the public internet, your tailnet needs an approved exit node.** The exit node can be your Windows PC; it does not need to run Debian. Follow the official [Windows exit node instructions](https://tailscale.com/docs/features/exit-nodes/how-to/setup?tab=windows). Advertise the exit node and approve it in the Tailscale admin console. WebVM uses an advertised exit node automatically. Tailnet policy still controls access.

For a connection check inside Debian:

```sh
curl -I https://example.com
```

The browser cannot access your physical Wi-Fi radio. Wireless scans, monitor mode, packet injection, and USB Wi-Fi passthrough are unavailable. Tailscale supplies routed network connectivity, not a virtual radio. ICMP `ping`, raw packet operations, and other kernel-dependent tools may not work; use ordinary TCP-based tools supported by WebVM. Access to other physical LAN hosts requires suitable Tailscale subnet routing.

No Tailscale auth key needs to be pasted into this app. Login goes directly to Tailscale in another tab. BLACKWIRE has no application backend or analytics.

## Root shell

Click **USER** above the terminal to select **ROOT** before booting. During a running session, the control offers to restart with the other account. Root runs as UID/GID 0 with `/root` as its home; no root password is needed. The pinned mini image’s root password login is locked. The default session remains UID/GID 1000 in `/home/user`.

## Storage and notes

- The pinned 600 MiB Debian mini image is read-only and streamed from this site in 128 KiB blocks. Disk changes are stored in this browser's IndexedDB overlay.
- Your files remain tied to this site origin, browser profile, and device. Clearing site data removes them. Browser storage can also be evicted, so keep backups.
- The app requests a browser lock to prevent concurrent use of the same VM disk by two tabs where the Web Locks API is available. If another tab holds the disk, **Open a separate lab** creates a fresh independent overlay, leaving the original files intact. The `workspace` URL parameter identifies that lab; keep the URL to reopen its disk.
- Field notes autosave in localStorage and can be exported as Markdown.
- The mini image uses its own overlay ID. An older large-image overlay, if present, is left intact rather than reused against incompatible disk blocks.
- **Export** downloads the terminal's current text buffer; it is not a disk backup.

## Deploy to GitHub Pages

The included `.github/workflows/pages.yml` validates the app, builds `dist/`, downloads and verifies the official Debian mini image, splits it into the format expected by `GitHubDevice`, and publishes it on pushes to `main`.

If the first run cannot enable Pages automatically, open **Settings → Pages → Build and deployment → Source → GitHub Actions**, then rerun the workflow. The repository's Actions policy must permit the official GitHub Pages actions.

All asset paths are relative, so the app works below the `/webvm2.0/` project path. GitHub Pages cannot set custom COOP/COEP response headers; `service-worker.js` supplies them for same-origin resources after registration. `_headers` is also included for hosts that support that convention.

## Development

No dependency install is required for the frontend build:

```sh
npm test
npm run build
```

Serve `dist/` over HTTPS or localhost. A simple `python3 -m http.server --directory dist 8080` works at `http://localhost:8080/` with the isolation service worker. Opening files directly does not work.

To include the disk for local preview, download the upstream image and prepare it after building:

```sh
curl -fL -o /tmp/debian-mini.ext2 https://github.com/leaningtech/webvm/releases/download/ext2_image/debian_mini_20230519_5022088024.ext2
node scripts/prepare-disk.mjs /tmp/debian-mini.ext2 dist/images/debian-mini.ext2
```

`app.js` pins the hosted CheerpX runtime to **1.4.0**. The base disk is upstream’s `debian_mini_20230519_5022088024.ext2`, exactly 629,145,600 bytes with SHA-256 `0805d88eaaa300efd5b89c2a3970a2d289c07c7c6be7ad80a5da4a3451bd0045`. It contains Debian Buster, Bash, Python, curl, and other tools; it is not a complete pentesting distribution. Install additional compatible tools as needed. The build checks the image size, SHA-256 and ext2 magic before splitting it. Each chunk uses a six-digit hexadecimal index and a `.txt` suffix, matching upstream WebVM’s Pages deployment format. A content hash on app/style imports prevents stale cached assets after deployments.

The build uses the existing `/mnt` directory for the temporary startup file. The regular user’s home is made writable in its persistent overlay before Bash starts. The CheerpX runtime is **referenced from its official host**, not copied into this repository. The vendored terminal assets come from WebVM's xterm directory.

## Licenses and credits

- BLACKWIRE frontend and WebVM integration: Apache License 2.0. See [LICENSE](./LICENSE).
- WebVM: [Leaning Technologies](https://github.com/leaningtech/webvm), Apache License 2.0.
- xterm.js and fit addon: MIT. See [THIRD-PARTY-NOTICES.txt](./THIRD-PARTY-NOTICES.txt).
- CheerpX is a separately licensed engine. Its public hosted runtime is free for individual technological exploration and testing. Organizational use and self-hosting the engine require an appropriate license. Review the [CheerpX licensing terms](https://cheerpx.io/docs/licensing).
- Wisp-JS 0.5.0: MercuryWorkshop, LGPL-3.0-or-later. The replaceable client module, source map, corresponding client sources, build configuration, and license texts are in `vendor/`. See [vendor/WISP-README.md](./vendor/WISP-README.md).
- Debian packages retain their respective upstream licenses.

BLACKWIRE is an independent project and is not affiliated with Debian, Tailscale, or Leaning Technologies.
