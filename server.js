// =====================================================================
//  IT Asset Tracker - back end
//  Serves the tracker page and stores everyone's data in ONE shared file
//  on this server (data/tracker.json), instead of in each person's browser.
//
//  Start it with:   node server.js
//  Then open:       http://localhost:3000   (or http://SERVERNAME:3000 from other PCs)
// =====================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- Settings (from config.json, if it exists) ----------
const DEFAULT_CONFIG = {
  port: 3000,
  // Low inventory email: ONE email when a tile drops to "emailAt" or lower.
  // It won't email about that tile again until it's back up to "restockedAt" or more.
  lowInventory: {
    emailAt: 2,
    restockedAt: 3,
    emailEachDrop: true,  // true = another email each time it drops lower (2, then 1, then 0); false = one email only
    forTile: {}           // different numbers for certain tiles, e.g. { "HDMI Cables": { "emailAt": 4, "restockedAt": 6 } }
  },
  email: {
    enabled: false,          // set to true once IT gives you the mail server details
    host: '',                // company SMTP relay, e.g. "smtp.yourcompany.com"
    port: 25,
    secure: false,
    user: '',                // leave blank if the relay doesn't need a login
    pass: '',
    from: '',                // e.g. "IT Tracker <it-notifications@yourcompany.com>"
    to: '',                  // who gets the alert
    subject: 'low inventory'
  }
};

function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;
  try {
    const user = JSON.parse(fs.readFileSync(file, 'utf8'));
    const merged = { ...DEFAULT_CONFIG, ...user, email: { ...DEFAULT_CONFIG.email, ...(user.email || {}) } };
    merged.lowInventory = { ...DEFAULT_CONFIG.lowInventory, ...(user.lowInventory || {}) };
    // Older config files: "belowDefault"/"belowForTile" (email below a number) or "lowInventoryLevel"
    const old = user.lowInventory || {};
    if (old.emailAt === undefined && typeof old.belowDefault === 'number') {
      merged.lowInventory.emailAt = old.belowDefault - 1;
      merged.lowInventory.restockedAt = old.belowDefault;
    }
    if (!old.forTile && old.belowForTile) {
      merged.lowInventory.forTile = {};
      Object.entries(old.belowForTile).forEach(([name, below]) => {
        merged.lowInventory.forTile[name] = { emailAt: Number(below) - 1, restockedAt: Number(below) };
      });
    }
    if (!user.lowInventory && typeof user.lowInventoryLevel === 'number') {
      merged.lowInventory.emailAt = user.lowInventoryLevel;
      merged.lowInventory.restockedAt = user.lowInventoryLevel + 1;
    }
    return merged;
  } catch (e) {
    console.error('config.json has a mistake in it, using default settings:', e.message);
    return DEFAULT_CONFIG;
  }
}
const CONFIG = loadConfig();

// ---------- Data storage ----------
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracker.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

let db = { assets: [], inventory: [], lowAlerts: {}, knownTiles: {}, tileNames: {} };   // tileNames: names typed in "+ New Tile"   // lowAlerts: { tile: last count emailed about }

function loadData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db.assets = Array.isArray(saved.assets) ? saved.assets : [];
      db.inventory = Array.isArray(saved.inventory) ? saved.inventory : [];
      // Older versions stored a plain list of tiles; "null" means "already emailed, count not recorded"
      if (Array.isArray(saved.lowAlerts)) { db.lowAlerts = {}; saved.lowAlerts.forEach(k => { db.lowAlerts[k] = null; }); }
      else db.lowAlerts = saved.lowAlerts && typeof saved.lowAlerts === 'object' ? saved.lowAlerts : {};
      db.knownTiles = saved.knownTiles && typeof saved.knownTiles === 'object' ? saved.knownTiles : {};
      db.tileNames = saved.tileNames && typeof saved.tileNames === 'object' ? saved.tileNames : {};
    } catch (e) {
      console.error('Could not read data/tracker.json - it may be damaged. Stopping so nothing gets overwritten.');
      process.exit(1);
    }
  }
}

// Writes to a temporary file first, then swaps it in, so a crash mid-save can't corrupt the data.
// The previous version is kept as tracker.backup.json.
function saveDataFile() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, path.join(DATA_DIR, 'tracker.backup.json'));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- Live updates (Server-Sent Events) ----------
// Every open tracker page keeps one connection here. When data or the page code changes,
// the server tells every page right away, so nobody has to press F5.
const liveClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
  liveClients.forEach(res => { try { res.write(msg); } catch (e) { liveClients.delete(res); } });
}

function openLiveConnection(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');   // if the connection drops, the page reconnects after 3 seconds
  liveClients.add(res);
  req.on('close', () => liveClients.delete(res));
}

// A small "still here" message every 25 seconds keeps the connections from timing out
setInterval(() => liveClients.forEach(res => { try { res.write(': ping\n\n'); } catch (e) {} }), 25000);

// Watch the page code: when public/index.html is saved, tell every page to reload
let codeTimer = null;
let lastCode = '';
function watchCode() {
  const file = path.join(PUBLIC_DIR, 'index.html');
  try { lastCode = fs.readFileSync(file, 'utf8'); } catch (e) {}
  try {
    fs.watch(PUBLIC_DIR, () => {
      clearTimeout(codeTimer);
      codeTimer = setTimeout(() => {
        let now;
        try { now = fs.readFileSync(file, 'utf8'); } catch (e) { return; }   // mid-save; the next event will catch it
        if (now && now !== lastCode) {
          lastCode = now;
          console.log('Tracker page updated - telling open pages to reload');
          broadcast('code', {});
        }
      }, 700);
    });
  } catch (e) {
    console.log('Could not watch the page for updates (pages will need F5 after code changes):', e.message);
  }
}

// ---------- Helpers ----------
function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) { reject(new Error('Too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

const validId = id => /^[\w.-]{1,64}$/.test(id);

// Adds a record, or replaces the one with the same id. New records go to the top of the list.
function upsert(list, record) {
  const i = list.findIndex(r => String(r.id) === String(record.id));
  if (i === -1) list.unshift(record);
  else list[i] = record;
}

// ---------- Low inventory email ----------
let mailer = null;
function getMailer() {
  if (mailer) return mailer;
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { throw new Error('Email add-on not installed. Run "npm install" in the tracker folder.'); }
  const e = CONFIG.email;
  mailer = nodemailer.createTransport({
    host: e.host, port: e.port, secure: e.secure,
    auth: e.user ? { user: e.user, pass: e.pass } : undefined
  });
  return mailer;
}

// The page sends the current tile counts. Each tile emails once when it hits the low level,
// and can email again after it's restocked and drops again.
// Finds the email/restock numbers for a tile. Names in "forTile" can be written like the
// tile title ("HDMI Cables") or its short form ("hdmi cable"); capitals and plurals don't matter.
function ruleFor(tile) {
  const simplify = t => String(t).toLowerCase().trim().replace(/\s+/g, ' ').replace(/(ies|es|s)$/, '');
  const special = CONFIG.lowInventory.forTile || {};
  for (const name of Object.keys(special)) {
    if (simplify(name) === simplify(tile.key) || simplify(name) === simplify(tile.label)) {
      const r = special[name];
      return {
        emailAt: Number(r.emailAt), restockedAt: Number(r.restockedAt),
        emailEachDrop: r.emailEachDrop !== undefined ? r.emailEachDrop !== false : CONFIG.lowInventory.emailEachDrop !== false
      };
    }
  }
  return {
    emailAt: Number(CONFIG.lowInventory.emailAt), restockedAt: Number(CONFIG.lowInventory.restockedAt),
    emailEachDrop: CONFIG.lowInventory.emailEachDrop !== false
  };
}

// Builds the sentence for one tile, using what's typed in Equipment Type and Model / Description:
// "According to our current inventory, we are down to 4 HDMI Cables – 6ft."
// Inventory items that belong to a tile: the tile's word appears in Equipment Type or Model / Description
// (the same rule the Inventory page uses to count its tiles)
function itemsForTile(key) {
  return db.inventory.filter(i =>
    ((i.type || '') + ' ' + (i.model || '')).toLowerCase().replace(/\s+/g, ' ').includes(key));
}

function describeLow(tile) {
  const items = itemsForTile(tile.key);
  let name = tile.label;                                   // e.g. "Headsets" (used for 0 and 2+)
  if (tile.count === 1 && items.length && (items[0].type || '').trim()) name = items[0].type.trim();   // e.g. "Laptop"
  const models = [...new Set(items.map(i => (i.model || '').trim()).filter(Boolean))];
  const modelText = models.length ? ` – ${models.join(', ')}` : '';
  return `According to our current inventory, we are down to ${tile.count} ${name}${modelText}.`;
}

// The page sends the current tile counts. A tile sends ONE email when it drops to its "emailAt"
// number or lower, then stays quiet until it's back up to its "restockedAt" number.
// Pages tell the server which tiles exist (name only). The server remembers every tile ever seen,
// so a tile whose last item is gone keeps showing at 0.
function registerTiles(defs) {
  let newTile = false, changed = false;
  defs.forEach(t => {
    if (db.knownTiles[t.key] !== t.label) { if (!db.knownTiles[t.key]) newTile = true; db.knownTiles[t.key] = t.label; changed = true; }
  });
  if (changed) saveDataFile();
  if (newTile) broadcast('data', {});   // lets every open page add the tile
}

// Checks run one at a time, right after any Inventory change, using the server's own counts
// (never a page's counts, which could be a few seconds out of date)
let lowCheckChain = Promise.resolve({ sent: [] });
function checkLowInventorySoon() {
  lowCheckChain = lowCheckChain.then(runLowInventoryCheck, runLowInventoryCheck).catch(err => {
    console.error('Low inventory check failed:', err.message);
    return { sent: [], error: err.message };
  });
  return lowCheckChain;
}

async function runLowInventoryCheck() {
  let changed = false;
  const tiles = Object.keys(db.knownTiles).map(key => ({ key, label: db.knownTiles[key], count: itemsForTile(key).length }));

  // Decide which tiles need an email
  const newlyLow = [];
  tiles.forEach(t => {
    const rule = ruleFor(t);
    const has = Object.prototype.hasOwnProperty.call(db.lowAlerts, t.key);
    const last = db.lowAlerts[t.key];
    if (t.count >= rule.restockedAt) {                       // restocked: start fresh
      if (has) { delete db.lowAlerts[t.key]; changed = true; }
      return;
    }
    if (t.count > rule.emailAt) return;                      // between the two numbers: no email
    if (!has) { newlyLow.push(t); return; }                  // first time it got low
    if (last === null) { db.lowAlerts[t.key] = t.count; changed = true; return; }   // older data: just record the count
    if (t.count < last) {                                    // dropped lower
      if (rule.emailEachDrop) newlyLow.push(t);
      else { db.lowAlerts[t.key] = t.count; changed = true; }
    } else if (t.count > last) {                             // went up a little but still low: remember it
      db.lowAlerts[t.key] = t.count; changed = true;
    }
  });
  if (newlyLow.length === 0) {
    if (changed) saveDataFile();
    return { sent: [] };
  }

  const lines = newlyLow.map(describeLow);

  if (!CONFIG.email.enabled) {
    // Email is off: remember them anyway so the window doesn't repeat itself, and show what would be sent
    newlyLow.forEach(t => { db.lowAlerts[t.key] = t.count; });
    saveDataFile();
    console.log('Low inventory (email is OFF in config.json). Would send:\n  ' + lines.join('\n  '));
    return { sent: [], emailOff: true };
  }

  // Mark them right away so two people's pages can't trigger two emails
  const previous = {};
  newlyLow.forEach(t => {
    previous[t.key] = Object.prototype.hasOwnProperty.call(db.lowAlerts, t.key) ? db.lowAlerts[t.key] : undefined;
    db.lowAlerts[t.key] = t.count;
  });
  saveDataFile();

  try {
    await getMailer().sendMail({
      from: CONFIG.email.from,
      to: CONFIG.email.to,
      subject: CONFIG.email.subject,
      text: lines.join('\n')
    });
    console.log('Low inventory email sent:\n  ' + lines.join('\n  '));
    return { sent: newlyLow.map(t => t.label) };
  } catch (err) {
    // Didn't send - un-mark them so it tries again next time
    newlyLow.forEach(t => {
      if (previous[t.key] === undefined) delete db.lowAlerts[t.key]; else db.lowAlerts[t.key] = previous[t.key];
    });
    saveDataFile();
    console.error('Low inventory email failed:', err.message);
    return { sent: [], error: err.message };
  }
}

// ---------- Serving the page ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, ''); }
  catch (e) { res.writeHead(400); res.end('Bad request'); return; }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- API routes ----------
//  GET    /api/data                  -> all employees and inventory
//  PUT    /api/assets/:id            -> add or update one employee
//  PATCH  /api/assets/:id            -> update only the changed boxes of one employee (same for inventory)
//  DELETE /api/assets/:id            -> delete one employee
//  PUT    /api/inventory/:id         -> add or update one inventory item
//  DELETE /api/inventory/:id         -> delete one inventory item
//  POST   /api/low-inventory         -> check tile counts and email if low
//  GET    /api/events                -> live updates (data changed / page code changed)
//  POST   /api/tiles                 -> create an Inventory tile ahead of time (shows 0)
//  POST   /api/tiles/delete          -> remove an empty Inventory tile
const server = http.createServer(async (req, res) => {
  // Odd or malicious addresses (for example from network security scanners) must never crash the tracker
  let url;
  try { url = new URL('http://localhost' + (req.url.startsWith('/') ? req.url : '/' + req.url)); }
  catch (e) { res.writeHead(400); res.end('Bad request'); return; }
  const parts = url.pathname.split('/').filter(Boolean);   // e.g. ['api','assets','123']

  try {
    if (parts[0] !== 'api') {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      return serveStatic(req, res, url.pathname);
    }

    if (req.method === 'GET' && parts[1] === 'events' && parts.length === 2) {
      return openLiveConnection(req, res);
    }

    if (req.method === 'GET' && parts[1] === 'data' && parts.length === 2) {
      return sendJSON(res, 200, { assets: db.assets, inventory: db.inventory, knownTiles: db.knownTiles, tileNames: db.tileNames });
    }

    if ((parts[1] === 'assets' || parts[1] === 'inventory') && parts.length === 3) {
      const list = db[parts[1]];
      const id = parts[2];
      if (!validId(id)) return sendJSON(res, 400, { error: 'Bad id' });

      if (req.method === 'PUT') {
        const record = await readBody(req);
        if (!record || typeof record !== 'object' || Array.isArray(record) || String(record.id) !== id) {
          return sendJSON(res, 400, { error: 'Record id does not match' });
        }
        upsert(list, record);
        saveDataFile();
        broadcast('data', { by: req.headers['x-client-id'] || '' });
        if (parts[1] === 'inventory') checkLowInventorySoon();
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'PATCH') {
        // Updates only the boxes that changed, so two people editing different boxes
        // on the same employee or item don't overwrite each other
        const body = await readBody(req);
        const changes = body && typeof body.changes === 'object' && !Array.isArray(body.changes) ? body.changes : null;
        const removed = Array.isArray(body && body.removed) ? body.removed : [];
        if (!changes) return sendJSON(res, 400, { error: 'Bad update' });
        const record = list.find(r => String(r.id) === id);
        if (!record) return sendJSON(res, 404, { error: 'Record no longer exists' });
        Object.keys(changes).forEach(k => { if (k !== 'id') record[k] = changes[k]; });
        removed.forEach(k => { if (k !== 'id') delete record[k]; });
        saveDataFile();
        broadcast('data', { by: req.headers['x-client-id'] || '' });
        if (parts[1] === 'inventory') checkLowInventorySoon();
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        db[parts[1]] = list.filter(r => String(r.id) !== id);
        saveDataFile();
        broadcast('data', { by: req.headers['x-client-id'] || '' });
        if (parts[1] === 'inventory') checkLowInventorySoon();
        return sendJSON(res, 200, { ok: true });
      }
    }

    if (req.method === 'POST' && parts[1] === 'tiles' && parts[2] === 'delete' && parts.length === 3) {
      // Removes an Inventory tile you no longer need (only allowed when nothing in Inventory belongs to it)
      const body = await readBody(req);
      const key = String(body.key || '').trim().toLowerCase();
      if (!key) return sendJSON(res, 400, { error: 'Bad tile' });
      if (itemsForTile(key).length > 0) return sendJSON(res, 409, { error: 'Tile still has items' });
      delete db.knownTiles[key];
      delete db.tileNames[key];
      delete db.lowAlerts[key];
      saveDataFile();
      broadcast('data', {});
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && parts[1] === 'tiles' && parts.length === 2) {
      // Creates an Inventory tile ahead of time (it shows 0 until items are added)
      const body = await readBody(req);
      const key = String(body.key || '').trim().toLowerCase();
      const label = String(body.label || '').trim();
      if (!key || !label || key.length > 60 || label.length > 60) return sendJSON(res, 400, { error: 'Bad tile name' });
      db.tileNames[key] = label;   // keep the exact name you typed
      if (!db.knownTiles[key]) {
        db.knownTiles[key] = label;
        // A brand-new empty tile shouldn't send a "down to 0" email; emails start once it's been stocked
        if (!Object.prototype.hasOwnProperty.call(db.lowAlerts, key)) db.lowAlerts[key] = 0;
        saveDataFile();
        broadcast('data', {});
      }
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && parts[1] === 'low-inventory' && parts.length === 2) {
      const body = await readBody(req);
      const defs = Array.isArray(body.tiles) ? body.tiles
        .filter(t => t && typeof t.key === 'string' && t.key.trim() && t.key.length <= 60)
        .map(t => ({ key: t.key, label: String(t.label || t.key).slice(0, 60) })) : [];
      registerTiles(defs);
      return sendJSON(res, 200, await checkLowInventorySoon());
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: err.message });
  }
});

// Last line of defense: log any unexpected error and keep running instead of shutting down
process.on('uncaughtException', err => console.error('Unexpected error (tracker kept running):', err.message));
process.on('unhandledRejection', err => console.error('Unexpected error (tracker kept running):', err && err.message));
server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {} });

loadData();
watchCode();
server.listen(CONFIG.port, () => {
  console.log(`IT Asset Tracker is running at http://localhost:${CONFIG.port}`);
  console.log(`Data is saved in ${DATA_FILE}`);
  console.log(`Low inventory email is ${CONFIG.email.enabled ? 'ON' : 'OFF'}${CONFIG.email.enabled ? ' (to: ' + CONFIG.email.to + ')' : ''}`);
  const li = CONFIG.lowInventory;
  const each = v => (v.emailEachDrop === false ? ', one email' : ', email each drop');
  const special = Object.entries(li.forTile || {}).map(([k, v]) => `${k}: email at ${v.emailAt}, restocked at ${v.restockedAt}${each({ emailEachDrop: v.emailEachDrop !== undefined ? v.emailEachDrop : li.emailEachDrop })}`);
  console.log(`Low inventory rules: email at ${li.emailAt}, restocked at ${li.restockedAt}${each(li)}${special.length ? '; ' + special.join('; ') : ''}`);
});
