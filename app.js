// BLACKWIRE: a client-side CheerpX integration. No simulated command responses.
const ENGINE_URL = 'https://cxrtnc.leaningtech.com/1.4.0/cx.esm.js';
const DISK_URL = 'wss://disks.webvm.io/debian_buster_large_permis_fixed_01-06-2026.ext2';
const DISK_ID = 'blackwire-debian-buster-v1';
const $ = (id) => document.getElementById(id);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let cx, term, fitAddon, sendKey, booting = false, bootFailed = false;
let startedAt = 0, connected = false, loginPending = false, loginTimer, outputSeen = false;
let fontSize = window.innerWidth < 700 ? 11 : 12;
let connectAfterBoot = false, pendingCommand = '', releaseRuntimeLock;
let resizeFrame, toastTimer, currentLoginUrl = null;

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function showView(view) {
  if (!['terminal', 'network', 'toolkit', 'notes'].includes(view)) return;
  $$('.view').forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  $$('.nav-link[data-view]').forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('breadcrumb-title').textContent = {terminal: 'Terminal', network: 'Network', toolkit: 'Toolkit', notes: 'Field notes'}[view];
  if (view === 'terminal') requestAnimationFrame(() => { resizeTerminal(); if (outputSeen) term?.focus(); });
}
$$('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
function showDialog(id) { if (!$(id).open) $(id).showModal(); }
$$('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
$('help-button').addEventListener('click', () => showDialog('guide-dialog'));
$$('[data-action="open-guide"]').forEach((button) => button.addEventListener('click', () => showDialog('guide-dialog')));

function browserConnectivity() {
  $('browser-state').textContent = navigator.onLine ? 'Browser online' : 'Browser offline';
  $('browser-dot').classList.toggle('on', navigator.onLine);
  $('browser-dot').classList.toggle('warning', !navigator.onLine);
}
browserConnectivity();
window.addEventListener('online', browserConnectivity);
window.addEventListener('offline', browserConnectivity);

async function isolateBrowser() {
  if (!window.isSecureContext) throw new Error('A secure HTTPS page is required. Open the published GitHub Pages URL, rather than a file or an insecure preview.');
  if (window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') return;
  if (!('serviceWorker' in navigator)) throw new Error('This browser does not support the isolation service worker. Try a current desktop Chrome, Edge, or Firefox browser.');
  progress('Preparing browser isolation. The page will reload once…');
  const previousAttempt = Number(sessionStorage.getItem('blackwire.isolationReload') || 0);
  if (Date.now() - previousAttempt < 30000 && navigator.serviceWorker.controller) {
    throw new Error('Cross-origin isolation is unavailable in this context. Open this site in a normal browser tab, outside embedded previews. Check that service workers and site storage are enabled.');
  }
  await navigator.serviceWorker.register(new URL('./service-worker.js', import.meta.url), {scope: './'});
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The isolation service worker did not take control. Reload the page and try again.')), 15000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, {once: true});
    });
  }
  sessionStorage.setItem('blackwire.isolationReload', String(Date.now()));
  sessionStorage.setItem('blackwire.resumeBoot', '1');
  if (connectAfterBoot) sessionStorage.setItem('blackwire.resumeConnect', '1');
  location.reload();
  await new Promise(() => {});
}

async function acquireRuntimeLock() {
  if (!navigator.locks) return;
  await new Promise((resolve, reject) => {
    navigator.locks.request(DISK_ID, {ifAvailable: true}, async (lock) => {
      if (!lock) { reject(new Error('This VM disk is already open in another tab. Close that session before booting here.')); return; }
      resolve();
      await new Promise((release) => { releaseRuntimeLock = release; });
    }).catch(reject);
  });
}
function progress(message) {
  $('boot-progress').hidden = false;
  $('boot-message').textContent = message;
  $('shell-state').textContent = message;
}
async function withTimeout(operation, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })
    ]);
  } finally { clearTimeout(timer); }
}
function initTerminal() {
  if (term) return;
  if (typeof window.Terminal !== 'function' || !window.FitAddon) throw new Error('The terminal assets did not load. Reload the page and check your connection.');
  term = new window.Terminal({
    cursorBlink: true, cursorStyle: 'block', convertEol: true, scrollback: 5000,
    fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize, lineHeight: 1.25, allowTransparency: false,
    theme: {background: '#090e0b', foreground: '#bfcec2', cursor: '#c3f977', cursorAccent: '#101810', selectionBackground: '#4d683f77', black: '#172019', red: '#ef8f86', green: '#c3f977', yellow: '#e7c681', blue: '#8bbbcf', magenta: '#cda4d8', cyan: '#8cd1b3', white: '#d1ded3', brightBlack: '#6e8573', brightGreen: '#d7ffa7', brightWhite: '#edf5ee'}
  });
  fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('console'));
  term.onData(sendInput);
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyC') {
      if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => toast('Use your browser’s Copy menu for the selected text.'));
      return false;
    }
    return true;
  });
  resizeTerminal();
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(resizeTerminal);
  }).observe($('console'));
}
function sendInput(string) {
  if (!sendKey) return;
  for (let i = 0; i < string.length; i++) sendKey(string.charCodeAt(i));
}
function terminalOutput(buffer, vt) {
  if (vt !== undefined && vt !== 1) return;
  term.write(new Uint8Array(buffer));
  if (!outputSeen) {
    outputSeen = true;
    startedAt = Date.now();
    booting = false;
    $('boot-screen').hidden = true;
    $('console').classList.add('visible');
    $('vm-status').textContent = 'VM running';
    $('shell-state').textContent = 'Debian · local session';
    $('vm-dot').classList.add('on');
    $('shell-dot').classList.add('on');
    $('uptime').textContent = '00:00:00';
    resizeTerminal();
    term.focus();
    if (pendingCommand) {
      // Wait for the prompt before preparing a command; never press Enter for the user.
      const command = pendingCommand;
      pendingCommand = '';
      setTimeout(() => { sendInput(command); term.focus(); }, 600);
    }
    if (connectAfterBoot) { connectAfterBoot = false; setTimeout(openConnection, 100); }
  }
}
function resizeTerminal() {
  if (!term || $('view-terminal').hidden) return;
  fitAddon.fit();
  $('terminal-size').textContent = `${term.cols} × ${term.rows}`;
  if (cx) sendKey = cx.setCustomConsole(terminalOutput, term.cols, term.rows);
}
function reportBootFailure(error) {
  booting = false;
  bootFailed = true;
  $('boot-screen').hidden = false;
  $('boot-screen').classList.remove('loading');
  $('boot-progress').hidden = true;
  $('boot-error').hidden = false;
  $('boot-error').textContent = `${error?.message || String(error)}\n\nThe runtime and Debian disk are loaded from Leaning Technologies / WebVM. Allow those connections, keep site storage enabled, then reload to retry.`;
  $('boot-button').disabled = false;
  $('boot-button').textContent = 'Reload & retry';
  $('vm-status').textContent = 'Boot interrupted';
  $('shell-state').textContent = 'Boot interrupted';
  $('vm-dot').classList.remove('on');
  $('shell-dot').classList.remove('on');
  releaseRuntimeLock?.();
}

async function boot() {
  if (bootFailed) { sessionStorage.setItem('blackwire.resumeBoot', '1'); location.reload(); return; }
  if (booting || cx) { showView('terminal'); return; }
  showView('terminal');
  booting = true;
  $('boot-button').disabled = true;
  $('boot-screen').classList.add('loading');
  $('boot-error').hidden = true;
  $('vm-status').textContent = 'Booting Debian';
  $('vm-dot').classList.add('warning');
  try {
    await isolateBrowser();
    sessionStorage.removeItem('blackwire.isolationReload');
    await acquireRuntimeLock();
    initTerminal();
    progress('Loading CheerpX 1.4.0 from Leaning Technologies…');
    const CheerpX = await withTimeout(import(ENGINE_URL), 90000, 'The CheerpX runtime took too long to load. Check access to cxrtnc.leaningtech.com.');
    progress('Connecting the Debian disk. Blocks load on demand…');
    let disk;
    try {
      disk = await withTimeout(CheerpX.CloudDevice.create(DISK_URL), 20000, 'The WebSocket disk connection did not respond.');
    } catch {
      progress('Trying the HTTPS disk connection…');
      disk = await withTimeout(CheerpX.CloudDevice.create(DISK_URL.replace('wss:', 'https:')), 45000, 'The WebVM disk service did not respond over WebSocket or HTTPS. Check access to disks.webvm.io.');
    }
    const cache = await CheerpX.IDBDevice.create(DISK_ID);
    const overlay = await CheerpX.OverlayDevice.create(disk, cache);
    const data = await CheerpX.DataDevice.create();
    await data.writeFile('/blackwire.bashrc', [
      '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
      '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
      'export PS1="\\[\\e[38;5;150m\\]user@blackwire\\[\\e[0m\\]:\\[\\e[38;5;109m\\]\\w\\[\\e[0m\\] \\$ "',
      'printf "\\n\\033[38;5;150m  BLACKWIRE / DEBIAN WORKSPACE\\033[0m\\n"',
      'printf "  Real x86 programs. Local browser execution.\\n"',
      'printf "  Connect Tailscale for networking; curl for connectivity checks.\\n\\n"'
    ].join('\n'));
    progress('Creating the Linux environment and starting Bash…');
    cx = await CheerpX.Linux.create({
      mounts: [
        {type: 'ext2', path: '/', dev: overlay},
        {type: 'dir', path: '/data', dev: data},
        {type: 'devs', path: '/dev'},
        {type: 'devpts', path: '/dev/pts'},
        {type: 'proc', path: '/proc'},
        {type: 'sys', path: '/sys'}
      ],
      networkInterface: {loginUrlCb, stateUpdateCb, netmapUpdateCb}
    });
    cx.registerCallback('cpuActivity', (state) => $('cpu-dot').classList.toggle('on', state !== 'ready'));
    cx.registerCallback('diskActivity', (state) => $('disk-dot').classList.toggle('on', state !== 'ready'));
    resizeTerminal();
    $('vm-dot').classList.remove('warning');
    // A real Bash process handles every command, completion, history, and Ctrl-C.
    // Exiting Bash opens a fresh shell against the same persistent overlay.
    while (true) {
      await cx.run('/bin/bash', ['--rcfile', '/data/blackwire.bashrc', '-i'], {
        env: ['HOME=/home/user', 'TERM=xterm-256color', 'USER=user', 'LOGNAME=user', 'SHELL=/bin/bash', 'EDITOR=vim', 'LANG=en_US.UTF-8', 'LC_ALL=C', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
        cwd: '/home/user', uid: 1000, gid: 1000
      });
      term.writeln('\r\n\x1b[38;5;150mShell exited. Opening a new session…\x1b[0m\r\n');
    }
  } catch (error) { reportBootFailure(error); }
}
$('boot-button').addEventListener('click', boot);
$('boot-from-connect').addEventListener('click', () => {
  $('connect-dialog').close();
  connectAfterBoot = true;
  boot();
});

function loginUrlCb(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'login.tailscale.com') throw new Error('The Tailscale runtime returned an unexpected login URL.');
    currentLoginUrl = parsed.href;
    clearTimeout(loginTimer);
    loginPending = false;
    $('connect-progress').hidden = true;
    $('connect-description').textContent = 'Continue to Tailscale in a new tab. Approve this browser VM, then return here. The connection status updates automatically.';
    $('tailscale-login').href = currentLoginUrl;
    $('tailscale-login').hidden = false;
    $('retry-login').hidden = true;
  } catch (error) { loginFailure(error.message); }
}
function stateUpdateCb(state) {
  const running = state === 6;
  connected = running;
  $('network-dot').classList.toggle('on', running);
  $('uplink-tag').classList.toggle('connected', running);
  $('uplink-tag').replaceChildren();
  const dot = document.createElement('i');
  dot.className = `tiny-dot${running ? ' on' : ''}`;
  $('uplink-tag').append(dot, document.createTextNode(running ? 'Tailscale connected' : 'Not connected'));
  $('network-state').textContent = running ? 'Connected' : 'Disconnected';
  $('network-state').classList.toggle('connected', running);
  if (running) {
    loginPending = false;
    clearTimeout(loginTimer);
    $('connect-progress').hidden = true;
    $('boot-from-connect').hidden = true;
    $('retry-login').hidden = true;
    $('connect-description').textContent = 'This browser VM is connected to your tailnet. Use the Network panel to see addresses and advertised exit nodes.';
    $('tailscale-login').href = 'https://login.tailscale.com/admin/machines';
    $('tailscale-login').textContent = 'Open Tailscale devices ↗';
    $('tailscale-login').hidden = false;
    toast('Tailscale connected. Your browser VM has joined the tailnet.');
  } else {
    $('vm-ip').textContent = 'Not assigned';
    $('network-address').textContent = 'Waiting for login';
    $('exit-status').textContent = 'Exit node required';
    $('peers-list').replaceChildren(createEmptyPeers());
    $('peer-count').textContent = 'No peer data';
  }
}
function createEmptyPeers() {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const title = document.createElement('strong'); title.textContent = 'No peer data available';
  const detail = document.createElement('p'); detail.textContent = 'Connect Tailscale to load your network map.';
  empty.append(title, detail);
  return empty;
}
function netmapUpdateCb(map) {
  const address = map?.self?.addresses?.[0] || 'Not assigned';
  const peers = Array.isArray(map?.peers) ? map.peers : [];
  $('vm-ip').textContent = address;
  $('network-address').textContent = address;
  const hasExitNode = peers.some((peer) => peer.exitNode);
  $('exit-status').textContent = hasExitNode ? 'Exit node advertised' : 'No exit node found';
  $('exit-status').style.color = hasExitNode ? 'var(--accent-dim)' : '';
  $('peer-count').textContent = `${peers.length} peer${peers.length === 1 ? '' : 's'} in map`;
  const list = $('peers-list');
  list.replaceChildren();
  if (!peers.length) {
    const empty = createEmptyPeers();
    empty.querySelector('strong').textContent = 'No peers in the network map';
    empty.querySelector('p').textContent = 'Add another device or check your tailnet access rules.';
    list.append(empty);
  }
  peers.forEach((peer, index) => {
    const row = document.createElement('div'); row.className = 'peer-row';
    // All peer-provided fields are inserted as text, never HTML.
    const body = document.createElement('div');
    const name = document.createElement('div'); name.className = 'peer-name'; name.textContent = peer.name || peer.hostName || peer.hostname || `Peer ${String(index + 1).padStart(2, '0')}`;
    const ip = document.createElement('div'); ip.className = 'peer-address'; ip.textContent = (peer.addresses || []).join(' · ') || 'No address supplied';
    body.append(name, ip);
    const badge = document.createElement('span'); badge.className = 'peer-tag'; badge.textContent = peer.exitNode ? 'EXIT NODE' : 'TAILNET';
    row.append(body, badge); list.append(row);
  });
}
function loginFailure(message) {
  loginPending = false;
  clearTimeout(loginTimer);
  $('connect-progress').hidden = true;
  $('connect-description').textContent = message;
  $('retry-login').hidden = false;
}
function openConnection() {
  showDialog('connect-dialog');
  $('boot-from-connect').hidden = Boolean(cx);
  if (!cx) {
    $('connect-description').textContent = booting ? 'Debian is starting. Wait for the shell, then connect to your tailnet.' : 'Boot Debian first, then join your Tailscale network from this browser.';
    $('boot-from-connect').disabled = booting;
    $('tailscale-login').hidden = true;
    return;
  }
  if (connected) return;
  if (currentLoginUrl) {
    $('tailscale-login').href = currentLoginUrl;
    $('tailscale-login').hidden = false;
    return;
  }
  if (loginPending) return;
  loginPending = true;
  $('connect-description').textContent = 'Starting the browser VM’s Tailscale network stack. A login link will appear here.';
  $('connect-progress').hidden = false;
  $('retry-login').hidden = true;
  loginTimer = setTimeout(() => loginFailure('Tailscale has not returned a login link yet. Check your browser connection and allow the Tailscale / WebVM network services, then retry.'), 60000);
  Promise.resolve(cx.networkLogin()).catch((error) => loginFailure(error.message || 'Tailscale could not start. Try again.'));
}
['top-connect', 'side-connect', 'network-connect'].forEach((id) => $(id).addEventListener('click', openConnection));
$('retry-login').addEventListener('click', () => { currentLoginUrl = null; openConnection(); });

function prepareCommand(command) {
  showView('terminal');
  if (!outputSeen) {
    pendingCommand = command;
    toast('Boot Debian first. Your command will be prepared when the shell opens.');
    $('boot-button').focus();
    return;
  }
  sendInput('\x15' + command); // Clear the current editable line; do not execute.
  term.focus();
  toast('Command prepared. Press Enter in the terminal to run it.');
}
$$('[data-command]').forEach((button) => button.addEventListener('click', () => prepareCommand(button.dataset.command)));
const tools = [
  ['System identity', 'Read the release information from the Debian filesystem.', 'cat /etc/os-release', 'SYSTEM', 'terminal'],
  ['Python runtime', 'Check the Python interpreter installed inside your VM.', 'python3 --version', 'DEVELOPMENT', 'box'],
  ['HTTP headers', 'Inspect the response headers of an example web server. Requires networking.', 'curl -I https://example.com', 'NETWORK', 'network'],
  ['Socket overview', 'Inspect socket information exposed by the emulated environment.', 'ss -tuln', 'NETWORK', 'network'],
  ['File fingerprints', 'Calculate a SHA-256 digest with the installed Debian tools.', 'sha256sum /etc/os-release', 'FILES', 'shield'],
  ['Git version', 'Check your version of Git before starting a project.', 'git --version', 'DEVELOPMENT', 'box'],
  ['Working directory', 'Explore files and permissions in your current directory.', 'ls -lah', 'FILES', 'notes'],
  ['Process view', 'See processes visible to the browser’s Linux environment.', 'ps aux', 'SYSTEM', 'terminal'],
  ['Local HTTP server', 'Run Python’s HTTP server inside Debian. Stop it with Ctrl-C.', 'python3 -m http.server 8000', 'DEVELOPMENT', 'network']
];
function renderTools(query = '') {
  const grid = $('tool-grid'); grid.replaceChildren();
  tools.filter((tool) => tool.join(' ').toLowerCase().includes(query.toLowerCase())).forEach(([name, description, command, category, icon]) => {
    const card = document.createElement('button'); card.className = 'tool-card';
    const head = document.createElement('div'); head.className = 'tool-card-head';
    // Icons come from the fixed local list, not from external data.
    head.innerHTML = `<svg><use href="#i-${icon}"/></svg>`;
    const tag = document.createElement('span'); tag.textContent = category; head.append(tag);
    const heading = document.createElement('h2'); heading.textContent = name;
    const detail = document.createElement('p'); detail.textContent = description;
    const code = document.createElement('code'); code.textContent = command;
    card.append(head, heading, detail, code);
    card.addEventListener('click', () => prepareCommand(command));
    grid.append(card);
  });
  if (!grid.children.length) { const empty = document.createElement('p'); empty.className = 'tool-empty'; empty.textContent = 'No commands match your search.'; grid.append(empty); }
}
renderTools();
$('tool-search').addEventListener('input', (event) => renderTools(event.target.value));

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], {type: 'text/plain;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportTerminal() {
  if (!term || !outputSeen) { toast('Boot Debian before exporting a terminal transcript.'); return; }
  const lines = [];
  for (let i = 0; i < term.buffer.active.length; i++) lines.push(term.buffer.active.getLine(i)?.translateToString(true) || '');
  downloadText('blackwire-terminal.txt', lines.join('\n'));
}
$$('[data-action="export-terminal"]').forEach((button) => button.addEventListener('click', exportTerminal));
$('clear-terminal').addEventListener('click', () => {
  if (!term || !outputSeen) { toast('Your terminal is ready to boot.'); return; }
  term.clear(); term.focus();
});
function changeFont(amount) {
  fontSize = Math.max(9, Math.min(22, fontSize + amount));
  if (term) { term.options.fontSize = fontSize; resizeTerminal(); }
  toast(`Terminal font: ${fontSize}px`);
}
$('font-down').addEventListener('click', () => changeFont(-1));
$('font-up').addEventListener('click', () => changeFont(1));
$('expand-terminal').addEventListener('click', () => {
  const expanded = document.querySelector('.terminal-panel').classList.toggle('expanded');
  $('expand-terminal').setAttribute('aria-label', expanded ? 'Restore terminal size' : 'Expand terminal');
  $('expand-terminal').title = expanded ? 'Restore terminal size' : 'Expand terminal';
  resizeTerminal();
});
$('confirm-restart').addEventListener('click', () => { sessionStorage.setItem('blackwire.resumeBoot', '1'); location.reload(); });

function updateNotesCount() { $('notes-count').textContent = `${$('notes').value.length.toLocaleString()} characters`; }
try { $('notes').value = localStorage.getItem('blackwire.fieldNotes') || ''; }
catch { $('notes-state').textContent = 'Storage unavailable · export a backup'; }
updateNotesCount();
$('notes').addEventListener('input', () => {
  updateNotesCount();
  try { localStorage.setItem('blackwire.fieldNotes', $('notes').value); $('notes-state').textContent = 'Saved in this browser'; }
  catch { $('notes-state').textContent = 'Not saved · export a backup'; }
});
$('export-notes').addEventListener('click', () => downloadText('blackwire-field-notes.md', $('notes').value));
window.addEventListener('keydown', (event) => {
  const inInput = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '') || Boolean(document.activeElement?.closest('.xterm'));
  if (event.key === 'Escape' && document.querySelector('.terminal-panel').classList.contains('expanded')) {
    document.querySelector('.terminal-panel').classList.remove('expanded'); resizeTerminal();
  }
  if (inInput || document.querySelector('dialog[open]')) return;
  if (event.key === '1') showView('terminal');
  if (event.key === '/') { event.preventDefault(); showView('toolkit'); $('tool-search').focus(); }
});
window.addEventListener('beforeunload', (event) => {
  if (outputSeen) { event.preventDefault(); event.returnValue = ''; }
});
setInterval(() => {
  if (!startedAt) return;
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  $('uptime').textContent = [Math.floor(elapsed / 3600), Math.floor(elapsed / 60) % 60, elapsed % 60].map((n) => String(n).padStart(2, '0')).join(':');
}, 1000);
if (sessionStorage.getItem('blackwire.resumeBoot') === '1') {
  sessionStorage.removeItem('blackwire.resumeBoot');
  connectAfterBoot = sessionStorage.getItem('blackwire.resumeConnect') === '1';
  sessionStorage.removeItem('blackwire.resumeConnect');
  boot();
}
