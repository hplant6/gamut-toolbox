// Kubernetes dev clusters (k3d) as project servers — main-process side.
// A k3d stack (e.g. Kindo's mono: `yarn local:up`) isn't one process on one port: a
// Docker load balancer publishes NodePorts (the app on 30580…), `kubectl port-forward`
// processes expose the rest (api 8100, next 3100…), and the ports shift per cluster.
// Port-by-port detection never matched any of that, so a cluster is tracked as ONE
// server: found by scanning k3d + the port-forward processes, attributed to a project
// by its worktree, started with `k3d cluster start` + re-created forwards, and paused
// with `k3d cluster stop` — which keeps the cluster's data. (`local:down` deletes the
// cluster, so it is never used.)
//
// Everything runs in the *nix env (WSL on Windows, the login shell on macOS/Linux)
// through the injected runner. Forwards are rebuilt from parsed, validated fields —
// never by replaying a captured command line.

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;                  // k3d cluster names
const TARGET_RE = /^(svc|service|pod|po|deploy|deployment|sts|statefulset)\/[a-z0-9][a-z0-9.-]{0,252}$/;
const NS_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const K8S_API_PORT = 6443;
const PF_TAG = 'gamut-pf-';                                     // marks Gamut's own forward loops (pkill target)
const SCAN_TTL = 5000;
const START_TIMEOUT_MS = 6 * 60 * 1000;

const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const port = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; };

// ── Parsing (pure; exported for tests) ──────────────────────────────────────

// `kubectl port-forward svc/api 8100:80 -n api --context k3d-x` → a forward, or null.
// argv is the process's NUL-split cmdline; a `bash -c 'while …kubectl…'` loop (Gamut's
// own) is parsed from its script text instead.
function parsePortForward(argv) {
  let a = argv;
  const bashC = a.indexOf('-c');
  if (/(^|\/)(ba)?sh$/.test(a[0] || '') && bashC !== -1 && a[bashC + 1]) a = a[bashC + 1].split(/[\s;]+/);
  const i = a.findIndex((t, k) => t === 'port-forward' && /(^|\/)kubectl$/.test(a[k - 1] || ''));
  if (i === -1) return null;
  const f = { target: '', local: null, remote: null, ns: '', context: '' };
  for (let k = i + 1; k < a.length; k++) {
    const t = a[k].replace(/^'|'$/g, '');
    const eq = /^--(namespace|context)=(.+)$/.exec(t);
    if (eq) { f[eq[1] === 'namespace' ? 'ns' : 'context'] = eq[2]; continue; }
    if (t === '-n' || t === '--namespace') { f.ns = (a[++k] || '').replace(/^'|'$/g, ''); continue; }
    if (t === '--context') { f.context = (a[++k] || '').replace(/^'|'$/g, ''); continue; }
    if (t === ';' || t === 'done' || t === 'sleep') break;
    if (!f.target && TARGET_RE.test(t)) { f.target = t; continue; }
    const m = /^(\d+):(\d+)$/.exec(t);
    if (m && f.local == null) { f.local = port(m[1]); f.remote = port(m[2]); }
  }
  const cm = /^k3d-(.+)$/.exec(f.context);
  if (!f.target || !f.local || !f.remote || !cm || !NAME_RE.test(cm[1])) return null;
  if (f.ns && !NS_RE.test(f.ns)) return null;
  f.cluster = cm[1];
  f.name = f.target.split('/')[1];
  return f;
}

// "0.0.0.0:30580->30080/tcp, [::]:30580->30080/tcp, 0.0.0.0:45053->6443/tcp" →
// [{ port: 30580, inner: 30080 }] — the Kubernetes API mapping is not a server port.
function parseLbPorts(s) {
  const out = new Map();
  for (const m of String(s || '').matchAll(/:(\d+)->(\d+)\/tcp/g)) {
    const p = port(m[1]), inner = port(m[2]);
    if (p && inner !== K8S_API_PORT && !out.has(p)) out.set(p, { port: p, inner });
  }
  return [...out.values()].sort((a, b) => a.inner - b.inner);
}

// Kindo's registry names its NodePorts; anything else is labelled by its inner port.
const KINDO_NODEPORT_NAMES = { nodePort: 'app', connectUI: 'connect-ui', nangoApi: 'nango-api', superadmin: 'superadmin' };

// Fold one scan's sections into cluster records. toHost maps a *nix path to the
// host's (WSL /mnt/c/x → C:\x); home is the *nix $HOME (a forward started from there
// says nothing about where the project lives).
function buildClusters({ list, lb, pf, kindo, home }, toHost = (p) => p) {
  const byName = new Map();
  const get = (name) => {
    if (!byName.has(name)) byName.set(name, { name, running: false, branch: '', worktree: '', appPort: null, ports: [], forwards: [] });
    return byName.get(name);
  };
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !NAME_RE.test(c.name || '')) continue;
    const e = get(c.name);
    const nodes = Array.isArray(c.nodes) ? c.nodes : [];
    e.running = (c.serversRunning > 0) || nodes.some(n => n && n.role === 'server' && n.State && n.State.Running);
  }
  const reg = (kindo && kindo.clusters) || {};
  for (const [name, r] of Object.entries(reg)) {
    if (!NAME_RE.test(name) || !byName.has(name)) continue;   // registry entries outlive deleted clusters
    const e = byName.get(name);
    e.branch = String(r.branch || '');
    if (r.worktree) e.worktree = toHost(String(r.worktree));
    const rp = r.ports || {};
    for (const [k, label] of Object.entries(KINDO_NODEPORT_NAMES)) if (port(rp[k])) e.ports.push({ name: label, port: port(rp[k]), kind: 'nodeport' });
    if (port(rp.nodePort)) e.appPort = port(rp.nodePort);
  }
  for (const { name, ports } of lb || []) {
    if (!byName.has(name)) continue;
    const e = byName.get(name);
    for (const p of parseLbPorts(ports)) {
      if (!e.ports.some(x => x.port === p.port)) e.ports.push({ name: e.ports.length ? 'nodeport ' + p.inner : 'app', port: p.port, kind: 'nodeport' });
      if (!e.appPort) e.appPort = p.port;   // lowest inner NodePort — the ingress, by convention
    }
  }
  const cwds = new Map();   // cluster → { cwd: count }
  for (const { cwd, argv } of pf || []) {
    const f = parsePortForward(argv);
    if (!f || !byName.has(f.cluster)) continue;
    const e = byName.get(f.cluster);
    if (!e.forwards.some(x => x.local === f.local)) {
      e.forwards.push({ name: f.name, target: f.target, local: f.local, remote: f.remote, ns: f.ns, context: f.context });
      if (!e.ports.some(x => x.port === f.local)) e.ports.push({ name: f.name, port: f.local, kind: 'forward' });
    }
    if (cwd && cwd !== '/' && cwd !== home) {
      const m = cwds.get(f.cluster) || {}; m[cwd] = (m[cwd] || 0) + 1; cwds.set(f.cluster, m);
    }
  }
  for (const e of byName.values()) {
    if (!e.worktree && cwds.has(e.name)) {   // no registry: the folder its forwards were started from
      const best = Object.entries(cwds.get(e.name)).sort((a, b) => b[1] - a[1])[0][0];
      e.worktree = toHost(best);
    }
    // Names may repeat on the next scan; the app port always leads.
    e.ports.sort((a, b) => (a.port === e.appPort ? -1 : b.port === e.appPort ? 1 : 0));
  }
  return [...byName.values()];
}

// Split the scan script's output into its sections.
function parseScan(lines) {
  const out = { k3d: true, docker: true, list: [], lb: [], pf: [], kindo: null, home: '' };
  let sec = '';
  for (const ln of lines) {
    if (ln === '@nok3d') { out.k3d = false; continue; }
    if (ln === '@nodocker') { out.docker = false; continue; }
    if (ln.startsWith('@home ')) { out.home = ln.slice(6); continue; }
    if (/^@(list|lb|pf|kindo)$/.test(ln)) { sec = ln.slice(1); continue; }
    if (sec === 'list') { try { out.list = JSON.parse(ln); } catch (_) {} }
    else if (sec === 'kindo') { try { out.kindo = JSON.parse(ln); } catch (_) {} }
    else if (sec === 'lb') { const [name, ports] = ln.split('\t'); if (name) out.lb.push({ name, ports }); }
    else if (sec === 'pf') { const [, cwd, args] = ln.split('\t'); if (args) out.pf.push({ cwd, argv: args.split('\x1f').filter(Boolean) }); }
  }
  return out;
}

// One script, one shell hop. /proc gives each forward's cwd + exact argv on Linux/WSL;
// macOS falls back to ps + lsof (argv split on spaces — fine for kubectl's).
const SCAN_SCRIPT = [
  'command -v k3d >/dev/null 2>&1 || { echo @nok3d; exit 0; }',
  'echo "@home $HOME"',
  'docker info >/dev/null 2>&1 || { echo @nodocker; exit 0; }',
  'echo @list; k3d cluster list -o json 2>/dev/null | tr -d "\\n"; echo',
  `echo @lb; docker ps --filter label=k3d.role=loadbalancer --format '{{.Label "k3d.cluster"}}\t{{.Ports}}' 2>/dev/null`,
  'echo @pf; for pid in $(pgrep -f "kubectl port-forward" 2>/dev/null); do',
  '  if [ -r /proc/$pid/cmdline ]; then cwd=$(readlink /proc/$pid/cwd 2>/dev/null); args=$(tr "\\0" "\\037" < /proc/$pid/cmdline);',
  '  else cwd=$(lsof -a -d cwd -p $pid -Fn 2>/dev/null | sed -n "s/^n//p" | head -1); args=$(ps -o args= -p $pid | tr " " "\\037"); fi',
  '  printf "%s\\t%s\\t%s\\n" "$pid" "$cwd" "$args"; done',
  'echo @kindo; cat "$HOME/.kindo/clusters.json" 2>/dev/null | tr -d "\\n"; echo',
].join('\n');

// The bash that brings a stopped cluster back: start it, wait for its pods, then one
// self-restarting loop per forward (kubectl exits whenever its pod restarts). The loop
// carries a tag so stop can find it; cwd is the worktree so the next scan still
// attributes the forwards to the right project.
function startScript(c, nixDir = (d) => d) {
  const lines = [
    'command -v setsid >/dev/null 2>&1 && DETACH=setsid || DETACH=',   // no setsid on macOS
    'docker info >/dev/null 2>&1 || { echo "Docker isn\'t running — start Docker Desktop first."; exit 3; }',
    `echo "k3d cluster start ${c.name}"`,
    `k3d cluster start ${sq(c.name)} 2>&1 || exit 4`,
  ];
  const fwds = (c.forwards || []).filter(validForward(c.name));
  const nss = [...new Set(fwds.map(f => f.ns).filter(Boolean))];
  for (const ns of nss) {
    lines.push(`echo "waiting for pods in ${ns}…"`, `kubectl wait --for=condition=Ready pods --all -n ${sq(ns)} --context ${sq('k3d-' + c.name)} --timeout=300s 2>&1 | tail -3`);
  }
  if (c.worktree) lines.push(`cd ${sq(nixDir(c.worktree))} 2>/dev/null || cd ~`);
  for (const f of fwds) {
    const kc = `kubectl port-forward ${f.target} ${f.local}:${f.remote}${f.ns ? ' -n ' + f.ns : ''} --context k3d-${c.name}`;
    lines.push(`echo "forward ${f.name}: localhost:${f.local}"`,
      `ss -tlnH "sport = :${f.local}" 2>/dev/null | grep -q . || $DETACH nohup bash -c ${sq(`while :; do ${kc}; sleep 2; done`)} ${PF_TAG}${c.name} >/dev/null 2>&1 &`);
  }
  lines.push('echo "__started__"');
  return lines.join('\n');
}
const validForward = (name) => (f) => f && TARGET_RE.test(f.target || '') && port(f.local) && port(f.remote)
  && (!f.ns || NS_RE.test(f.ns)) && f.context === 'k3d-' + name;

function stopScript(name) {
  return [
    `pkill -f ${sq(PF_TAG + name + '$')} 2>/dev/null`,
    `pkill -f ${sq('kubectl port-forward .*--context[= ]k3d-' + name + '( |$)')} 2>/dev/null`,
    'docker info >/dev/null 2>&1 || exit 0',   // Docker off → the cluster is already down
    `k3d cluster stop ${sq(name)} 2>&1`,
  ].join('\n');
}

// ── Runtime ────────────────────────────────────────────────────────────────

// runNix(script, timeoutMs) → Promise<lines>; runNixLong(script, onLine, timeoutMs) → Promise<exitCode>.
// toHost/toNix convert paths between the *nix env and the host (identity off Windows).
function createClusters({ runNix, runNixLong, toHost, toNix, probePort }) {
  let cache = { at: 0, value: null };
  const ops = new Map();   // server id → { status, log } for the row's output popover

  async function scan(force = false) {
    if (!force && cache.value && Date.now() - cache.at < SCAN_TTL) return cache.value;
    const s = parseScan(await runNix(SCAN_SCRIPT, 15000));
    const value = { ok: true, k3d: s.k3d, docker: s.docker, clusters: s.k3d && s.docker ? buildClusters(s, toHost) : [] };
    cache = { at: Date.now(), value };
    return value;
  }

  const logTo = (op) => (line) => { op.log = (op.log + line + '\n').slice(-6000); };

  // Resolves once the start is under way (or refused); the slow part runs on and is
  // reported through the op's status/log.
  async function start(id, c) {
    if (!c || !NAME_RE.test(c.name || '')) return { ok: false, error: 'invalid cluster' };
    const pre = await scan(true);
    if (!pre.k3d) return { ok: false, error: 'k3d isn\'t installed' };
    if (!pre.docker) return { ok: false, error: 'Docker isn\'t running — start Docker Desktop first' };
    const op = { status: 'starting', log: '' };
    ops.set(id, op);
    const deadline = Date.now() + START_TIMEOUT_MS;
    runNixLong(startScript(c, toNix), logTo(op), START_TIMEOUT_MS).then(async (code) => {
      if (code !== 0) { op.status = 'error'; logTo(op)(`[exited ${code}]`); return; }
      while (c.appPort && Date.now() < deadline && !(await probePort(c.appPort, 800))) await new Promise(r => setTimeout(r, 2000));
      op.status = 'running';
      cache.at = 0;
    });
    return { ok: true, port: c.appPort || null, pending: true };
  }

  async function stop(id, c) {
    const name = c && c.name;
    if (!NAME_RE.test(name || '')) return { ok: false, error: 'invalid cluster' };
    const op = ops.get(id) || { status: '', log: '' };
    ops.set(id, op);
    logTo(op)(`k3d cluster stop ${name}`);
    (await runNix(stopScript(name), 120000)).forEach(logTo(op));
    op.status = 'stopped';
    cache.at = 0;
    return { ok: true, stopped: true };
  }

  return { scan, start, stop, op: (id) => ops.get(id) || null };
}

module.exports = { createClusters, parsePortForward, parseLbPorts, buildClusters, parseScan, startScript, stopScript, SCAN_SCRIPT };
