// Beont: Telegram bot server on Cloudflare Workers.
// - /tg        Telegram webhook (chat: add tasks by text, buttons)
// - /api/*     Mini App API (tasks + settings), auth by Telegram initData
// - /setup     registers the webhook and bot commands
// - cron       every minute: sends due reminders
const APP_URL = 'https://bbblanckc.github.io/beont/';
const APP_ORIGIN = 'https://bbblanckc.github.io';
const UA = 'BeontBot/1.0 (+https://github.com/bbblanckc/beont)';
const enc = new TextEncoder();

const DEFAULT_SETTINGS = {
  tz: 'Europe/Moscow', maps: 'yandex', mode: 'car', buffer: 5, home: null, lastCat: 'study',
  notif: { on: true, leave: [30, 5], noPlace: 10, morning: '08:00', evening: null, quiet: null }
};

export default {
  async fetch(req, env, ctx) {
    try { return await route(req, env, ctx); }
    catch (e) { console.error('fetch error', e && e.stack || e); return json({ error: 'server' }, 500, req); }
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(tick(env).catch(e => console.error('tick', e && e.stack || e))); }
};

/* ---------------- helpers ---------------- */
const pad = n => String(n).padStart(2, '0');
const fmt = m => { m = ((m % 1440) + 1440) % 1440; return Math.floor(m / 60) + ':' + pad(m % 60); };
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const durTxt = m => m < 60 ? m + ' мин' : Math.floor(m / 60) + ' ч' + (m % 60 ? ' ' + (m % 60) + ' мин' : '');
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MG = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const CAT = { study: 'Учёба', work: 'Работа', personal: 'Личное', friends: 'Друзья', family: 'Семья', other: 'Другое' };
const HOW = { car: 'на машине', transit: 'на транспорте', walk: 'пешком' };

function cors(req) {
  const o = req && req.headers.get('origin');
  return {
    'access-control-allow-origin': o === APP_ORIGIN ? o : APP_ORIGIN,
    'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-init-data',
    'access-control-max-age': '86400', 'vary': 'origin'
  };
}
function json(obj, status, req) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(req)) });
}
async function sha256hex(s) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

/* ---------------- time zones ---------------- */
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'Europe/Moscow'; } }
function tzOffset(tz, ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = {}; f.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute);
  return Math.round((asUTC - Math.floor(ms / 60000) * 60000) / 60000);
}
function localToMs(dateKey, min, tz) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d) + min * 60000;
  const off = tzOffset(tz, guess);
  let ms = guess - off * 60000;
  const off2 = tzOffset(tz, ms);
  if (off2 !== off) ms = guess - off2 * 60000;
  return ms;
}
function nowLocal(tz, ms) {
  ms = ms || Date.now();
  const l = new Date(ms + tzOffset(tz, ms) * 60000);
  return { key: l.getUTCFullYear() + '-' + pad(l.getUTCMonth() + 1) + '-' + pad(l.getUTCDate()), min: l.getUTCHours() * 60 + l.getUTCMinutes(), dow: l.getUTCDay(), y: l.getUTCFullYear(), m: l.getUTCMonth() };
}
function addDaysKey(k, n) {
  const [y, m, d] = k.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
}
function dayLabel(k, tz) {
  const L = nowLocal(tz);
  if (k === L.key) return 'сегодня';
  if (k === addDaysKey(L.key, 1)) return 'завтра';
  const [y, m, d] = k.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WD[dow] + ', ' + d + ' ' + MG[m - 1];
}
const hhmm = s => { if (!s) return null; const p = String(s).split(':'); return (+p[0]) * 60 + (+p[1] || 0); };

/* ---------------- storage ---------------- */
let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, settings TEXT NOT NULL DEFAULT \'{}\', rc INTEGER DEFAULT 0)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tasks (user_id INTEGER NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (user_id, id))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS rem (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, task_id TEXT, at INTEGER NOT NULL, kind TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS rem_at ON rem (sent, at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS tasks_date ON tasks (user_id, date)')
  ]);
  ready = true;
}
function mergeSettings(s) {
  s = s || {};
  const out = Object.assign({}, DEFAULT_SETTINGS, s);
  out.notif = Object.assign({}, DEFAULT_SETTINGS.notif, s.notif || {});
  out.tz = validTz(out.tz || 'Europe/Moscow');
  return out;
}
async function getUser(env, uid) {
  const r = await env.DB.prepare('SELECT settings FROM users WHERE id=?').bind(uid).first();
  if (!r) { await env.DB.prepare('INSERT OR IGNORE INTO users (id, settings) VALUES (?, ?)').bind(uid, '{}').run(); return mergeSettings({}); }
  let s = {}; try { s = JSON.parse(r.settings); } catch (e) {}
  return mergeSettings(s);
}
async function putSettings(env, uid, s) {
  const clean = mergeSettings(s);
  await env.DB.prepare('INSERT INTO users (id, settings) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings').bind(uid, JSON.stringify(clean)).run();
  return clean;
}
function cleanTask(t) {
  const p = t.place && isFinite(+t.place.lat) && isFinite(+t.place.lon) ? { name: String(t.place.name || 'Место').slice(0, 120), addr: String(t.place.addr || '').slice(0, 160), lat: +(+t.place.lat).toFixed(6), lon: +(+t.place.lon).toFixed(6) } : null;
  return {
    id: String(t.id || '').slice(0, 40) || crypto.randomUUID().slice(0, 12),
    title: String(t.title || 'Дело').slice(0, 200),
    cat: CAT[t.cat] ? t.cat : 'other',
    date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : '1970-01-01',
    start: Math.max(0, Math.min(1439, Math.round(+t.start || 0))),
    dur: Math.max(5, Math.min(1435, Math.round(+t.dur || 60))),
    place: p, mode: ['car', 'transit', 'walk'].indexOf(t.mode) >= 0 ? t.mode : null,
    manual: t.manual == null || t.manual === '' ? null : Math.max(0, Math.min(300, Math.round(+t.manual))),
    tmin: t.tmin == null ? null : Math.max(0, Math.min(600, Math.round(+t.tmin))),
    tfrom: t.tfrom ? String(t.tfrom).slice(0, 60) : null,
    done: !!t.done, note: String(t.note || '').slice(0, 1500)
  };
}
async function putTask(env, uid, t) {
  const c = cleanTask(t);
  await env.DB.prepare('INSERT INTO tasks (user_id, id, date, data) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET date=excluded.date, data=excluded.data').bind(uid, c.id, c.date, JSON.stringify(c)).run();
  return c;
}
async function listTasks(env, uid, from, to) {
  let q = 'SELECT data FROM tasks WHERE user_id=?', b = [uid];
  if (from) { q += ' AND date>=?'; b.push(from); }
  if (to) { q += ' AND date<=?'; b.push(to); }
  const r = await env.DB.prepare(q).bind(...b).all();
  return (r.results || []).map(x => { try { return JSON.parse(x.data); } catch (e) { return null; } }).filter(Boolean);
}

/* ---------------- geo ---------------- */
function hav(a, b) {
  const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function estimate(from, to, mode, km) {
  km = km || hav(from, to) * 1.35;
  if (mode === 'walk') return Math.max(1, Math.round(km / 4.7 * 60));
  if (mode === 'transit') return Math.max(5, Math.round(8 + km / 17 * 60));
  return Math.max(2, Math.round(4 + km / 28 * 60));
}
async function travel(from, to, mode) {
  if (hav(from, to) < 0.08) return 1;
  try {
    const prof = mode === 'walk' ? 'routed-foot' : 'routed-car';
    const r = await fetch('https://routing.openstreetmap.de/' + prof + '/route/v1/driving/' + from.lon + ',' + from.lat + ';' + to.lon + ',' + to.lat + '?overview=false', { headers: { 'user-agent': UA } });
    const j = await r.json(); const rt = j && j.routes && j.routes[0];
    if (!rt) throw new Error('no route');
    if (mode === 'car') return Math.max(2, Math.round(rt.duration / 60 * 1.25 + 2));
    if (mode === 'walk') return Math.max(1, Math.round(rt.duration / 60));
    return estimate(from, to, 'transit', rt.distance / 1000);
  } catch (e) { return estimate(from, to, mode); }
}
function normQ(q) {
  let s = ' ' + q + ' ';
  s = s.replace(/\s(г\.?|город)\s/gi, ' ');
  s = s.replace(/\s(д\.?|дом)\s*(?=\d)/gi, ' ');
  s = s.replace(/\sул\.?\s/gi, ' улица ');
  s = s.replace(/\s(пр-т|просп\.?)\s/gi, ' проспект ');
  s = s.replace(/\sпер\.?\s/gi, ' переулок ');
  return s.replace(/\s+/g, ' ').trim();
}
async function geocode(q, bias) {
  let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&accept-language=ru&q=' + encodeURIComponent(normQ(q));
  if (bias) url += '&viewbox=' + (bias.lon - 0.6).toFixed(3) + ',' + (bias.lat + 0.4).toFixed(3) + ',' + (bias.lon + 0.6).toFixed(3) + ',' + (bias.lat - 0.4).toFixed(3);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ru' } });
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) return null;
    const num = (normQ(q).match(/\d+[а-яa-z]?/i) || [''])[0].toLowerCase();
    let x = j.find(e => e.address && String(e.address.house_number || '').toLowerCase() === num) || j[0];
    const a = x.address || {};
    const road = a.road || a.pedestrian || '';
    const street = [road, a.house_number].filter(Boolean).join(', ');
    const name = x.name && x.name !== road && x.name !== a.house_number ? x.name : '';
    const area = a.suburb || a.city_district || '';
    const city = a.city || a.town || a.village || '';
    return { name: name || street || String(x.display_name).split(',')[0], addr: [name && street, area !== city && area, city].filter(Boolean).join(', '), lat: +x.lat, lon: +x.lon };
  } catch (e) { return null; }
}
function routeUrl(app, to, mode) {
  const t = to.lat + ',' + to.lon;
  if (app === 'google') return 'https://www.google.com/maps/dir/?api=1&destination=' + t + '&travelmode=' + ({ car: 'driving', transit: 'transit', walk: 'walking' }[mode]);
  if (app === 'gis') return 'https://2gis.ru/routeSearch/rsType/' + ({ car: 'car', transit: 'bus', walk: 'pedestrian' }[mode]) + '/to/' + to.lon + ',' + to.lat;
  if (app === 'apple') return 'https://maps.apple.com/?daddr=' + t + '&dirflg=' + ({ car: 'd', transit: 'r', walk: 'w' }[mode]);
  return 'https://yandex.ru/maps/?rtext=~' + t + '&rtt=' + ({ car: 'auto', transit: 'mt', walk: 'pd' }[mode]);
}

/* ---------------- day plan: origin, travel, leave ---------------- */
function originFor(task, list, s) {
  let prev = null;
  for (const t of list) { if (t.id !== task.id && t.start < task.start && t.place) prev = t; }
  if (prev) return { place: prev.place, label: 'после «' + prev.title + '»' };
  if (s.home) return { place: s.home, label: 'из дома' };
  return null;
}
const okey = (p, mode) => p.lat.toFixed(4) + ',' + p.lon.toFixed(4) + '|' + mode;
async function refreshTravel(env, uid, list, s) {
  // recompute travel for tasks whose origin changed since it was last computed
  let n = 0;
  for (const t of list) {
    if (!t.place || n >= 6) continue;
    const mode = t.mode || s.mode;
    const o = originFor(t, list, s);
    if (!o) continue;
    const k = okey(o.place, mode);
    if (t.tfrom === k && t.tmin != null) continue;
    t.tmin = await travel(o.place, t.place, mode); t.tfrom = k; n++;
    await putTask(env, uid, t);
  }
}
function leaveOf(t, s) {
  if (!t.place) return null;
  const tm = t.manual != null ? t.manual : t.tmin;
  if (tm == null) return null;
  return { leave: t.start - tm - (s.buffer || 0), tmin: tm };
}
function inQuiet(min, q) {
  if (!q || !q.length) return false;
  const a = hhmm(q[0]), b = hhmm(q[1]);
  return a <= b ? (min >= a && min < b) : (min >= a || min < b);
}

/* ---------------- reminders ---------------- */
async function recompute(env, uid) {
  const s = await getUser(env, uid);
  await env.DB.prepare('DELETE FROM rem WHERE user_id=? AND sent=0').bind(uid).run();
  await env.DB.prepare('UPDATE users SET rc=? WHERE id=?').bind(Date.now(), uid).run();
  const n = s.notif;
  if (!n.on) return;
  const tz = s.tz, L = nowLocal(tz), now = Date.now();
  const to = addDaysKey(L.key, 14);
  const tasks = await listTasks(env, uid, L.key, to);
  const byDay = {};
  tasks.forEach(t => { (byDay[t.date] = byDay[t.date] || []).push(t); });
  Object.values(byDay).forEach(l => l.sort((a, b) => a.start - b.start));
  for (const k of Object.keys(byDay)) await refreshTravel(env, uid, byDay[k], s);
  const rows = [];
  const add = (dateKey, min, kind, taskId) => {
    const lm = ((min % 1440) + 1440) % 1440, dk = min < 0 ? addDaysKey(dateKey, -1) : dateKey;
    if (inQuiet(lm, n.quiet)) return;
    const at = localToMs(dk, lm, tz);
    if (at > now + 30000) rows.push([uid, taskId, at, kind]);
  };
  for (const k of Object.keys(byDay)) {
    for (const t of byDay[k]) {
      if (t.done) continue;
      const lv = leaveOf(t, s);
      if (lv) (n.leave || []).forEach(m => add(k, lv.leave - m, 'leave:' + m, t.id));
      else if (n.noPlace != null) add(k, t.start - n.noPlace, 'start:' + n.noPlace, t.id);
    }
  }
  for (let i = 0; i <= 14; i++) {
    const k = addDaysKey(L.key, i);
    if (n.morning && byDay[k] && byDay[k].some(t => !t.done)) add(k, hhmm(n.morning), 'morning', k);
    const nk = addDaysKey(k, 1);
    if (n.evening && byDay[nk] && byDay[nk].some(t => !t.done)) add(k, hhmm(n.evening), 'evening', nk);
  }
  for (let i = 0; i < rows.length; i += 40) {
    const chunk = rows.slice(i, i + 40);
    await env.DB.batch(chunk.map(r => env.DB.prepare('INSERT INTO rem (user_id, task_id, at, kind) VALUES (?, ?, ?, ?)').bind(...r)));
  }
}
function dayListText(list, s) {
  return list.filter(t => !t.done).map(t => {
    const lv = leaveOf(t, s);
    return '<b>' + fmt(t.start) + '</b>  ' + esc(t.title) + (t.place ? ' · ' + esc(t.place.name) : '') + (lv ? '\n        выйти в ' + fmt(lv.leave) : '');
  }).join('\n');
}
async function tick(env) {
  await init(env);
  const now = Date.now();
  const due = await env.DB.prepare('SELECT * FROM rem WHERE sent=0 AND at<=? ORDER BY at LIMIT 40').bind(now + 20000).all();
  const rows = due.results || [];
  const cache = {};
  for (const r of rows) {
    await env.DB.prepare('UPDATE rem SET sent=1 WHERE id=?').bind(r.id).run();
    if (r.at < now - 15 * 60000) continue; // too late, skip
    try {
      const u = cache[r.user_id] || (cache[r.user_id] = await getUser(env, r.user_id));
      await sendReminder(env, r, u);
    } catch (e) { console.error('send', e && e.stack || e); }
  }
  await env.DB.prepare('DELETE FROM rem WHERE sent=1 AND at<?').bind(now - 2 * 86400000).run();
  // once an hour refresh users whose plan was not recomputed for 12h (rolls the 14-day window)
  if (new Date(now).getUTCMinutes() === 7) {
    const stale = await env.DB.prepare('SELECT id FROM users WHERE rc<? LIMIT 20').bind(now - 12 * 3600000).all();
    for (const u of (stale.results || [])) await recompute(env, u.id);
  }
}
async function sendReminder(env, r, s) {
  const [kind, arg] = r.kind.split(':');
  const appBtn = [{ text: 'Открыть Beont', web_app: { url: APP_URL } }];
  if (kind === 'morning' || kind === 'evening') {
    const list = (await listTasks(env, r.user_id, r.task_id, r.task_id)).sort((a, b) => a.start - b.start);
    if (!list.some(t => !t.done)) return;
    const head = kind === 'morning' ? 'Доброе утро! План на сегодня:' : 'План на завтра, ' + dayLabel(r.task_id, s.tz).replace('завтра', '').replace(/^, /, '') ;
    const text = (kind === 'morning' ? head : 'План на ' + dayLabel(r.task_id, s.tz) + ':') + '\n\n' + dayListText(list, s);
    return send(env, r.user_id, text, [appBtn]);
  }
  const row = await env.DB.prepare('SELECT data FROM tasks WHERE user_id=? AND id=?').bind(r.user_id, r.task_id).first();
  if (!row) return;
  const t = JSON.parse(row.data);
  if (t.done) return;
  if (kind === 'leave' || kind === 'snooze') {
    const lv = leaveOf(t, s);
    const m = +arg;
    const title = kind === 'snooze' || m === 0 ? 'Пора выходить' : 'Через ' + durTxt(m) + ' выходить';
    const mode = t.mode || s.mode;
    let text = '<b>' + title + '</b>\n' + esc(t.title) + ' в ' + fmt(t.start);
    if (t.place) text += '\n' + esc(t.place.name) + (t.place.addr ? ', ' + esc(t.place.addr) : '');
    if (lv) text += '\nДорога ' + durTxt(lv.tmin) + ' ' + HOW[mode] + ', выход в ' + fmt(lv.leave);
    const app = s.maps === 'ask' || s.maps === 'apple' ? 'yandex' : s.maps;
    const kb = [];
    if (t.place) kb.push([{ text: 'Маршрут', url: routeUrl(app, t.place, mode) }]);
    kb.push([{ text: 'Через 5 мин', callback_data: 'snz:' + t.id }, { text: 'Уже выхожу', callback_data: 'go:' + t.id }]);
    return send(env, r.user_id, text, kb);
  }
  if (kind === 'start') {
    const text = '<b>Через ' + durTxt(+arg) + '</b>: ' + esc(t.title) + ' в ' + fmt(t.start) + (t.note ? '\n' + esc(t.note.slice(0, 300)) : '');
    return send(env, r.user_id, text, [[{ text: 'Готово', callback_data: 'done:' + t.id }], appBtn]);
  }
}

/* ---------------- Telegram ---------------- */
async function tg(env, method, body) {
  const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.warn('tg', method, JSON.stringify(j).slice(0, 300));
  return j;
}
function send(env, chat, text, kb) {
  return tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb ? { inline_keyboard: kb } : undefined });
}
async function webhookSecret(env) { return (await sha256hex('beont:' + env.BOT_TOKEN)).slice(0, 48); }

const HELP = 'Напиши мне дело обычными словами, и я его запишу. Например:\n\n' +
  '<i>завтра в 14 стоматолог, Беломорская 5</i>\n<i>пара в 10:30, Кремлёвская 18</i>\n<i>в пятницу с 19 до 22 кино с друзьями</i>\n<i>15 ноября в 12 позвонить маме</i>\n\n' +
  'Если укажешь адрес после запятой, я посчитаю дорогу и напомню, когда выходить. Напоминания настраиваются в приложении: Настройки → Уведомления.\n\n' +
  '/today — дела на сегодня\n/tomorrow — на завтра';

async function onUpdate(env, u) {
  if (u.callback_query) return onCallback(env, u.callback_query);
  const m = u.message;
  if (!m || !m.text || !m.from || m.chat.type !== 'private') return;
  const uid = m.from.id, text = m.text.trim();
  const s = await getUser(env, uid);
  const appBtn = [{ text: 'Открыть Beont', web_app: { url: APP_URL } }];
  if (/^\/start/.test(text)) {
    await recompute(env, uid);
    return send(env, uid, '<b>Привет! Я Beont.</b>\nПланирую дела с дорогой: считаю, сколько ехать, и напоминаю, когда выходить.\n\n' + HELP, [appBtn]);
  }
  if (/^\/help/.test(text)) return send(env, uid, HELP, [appBtn]);
  if (/^\/(today|tomorrow)/.test(text)) {
    const L = nowLocal(s.tz), k = /tomorrow/.test(text) ? addDaysKey(L.key, 1) : L.key;
    const list = (await listTasks(env, uid, k, k)).sort((a, b) => a.start - b.start);
    const label = /tomorrow/.test(text) ? 'завтра' : 'сегодня';
    return send(env, uid, list.length ? '<b>Дела на ' + label + ':</b>\n\n' + dayListText(list, s) : 'На ' + label + ' дел нет.', [appBtn]);
  }
  if (/^\//.test(text)) return send(env, uid, HELP, [appBtn]);
  const p = parseTask(text, s.tz);
  if (p.error) return send(env, uid, 'Не понял, во сколько. Напиши, например: <i>завтра в 14 стоматолог, Беломорская 5</i>', [appBtn]);
  const t = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 12), title: p.title, cat: p.cat, date: p.date, start: p.start, dur: p.dur, place: null, mode: s.mode, manual: null, done: false, note: '' };
  let placeNote = '';
  if (p.placeQ) {
    const bias = s.home || null;
    const pl = await geocode(p.placeQ, bias);
    if (pl) t.place = pl; else placeNote = '\nАдрес «' + esc(p.placeQ) + '» не нашёл на карте, сохранил без места. Место можно добавить в приложении.';
  }
  await putTask(env, uid, t);
  await recompute(env, uid);
  const saved = JSON.parse((await env.DB.prepare('SELECT data FROM tasks WHERE user_id=? AND id=?').bind(uid, t.id).first()).data);
  const lv = leaveOf(saved, s);
  let msg = '<b>Записал</b>\n' + esc(saved.title) + ' · ' + CAT[saved.cat] + '\n' + dayLabel(saved.date, s.tz) + ', ' + fmt(saved.start) + '–' + fmt(saved.start + saved.dur);
  if (saved.place) msg += '\n' + esc(saved.place.name) + (saved.place.addr ? ', ' + esc(saved.place.addr) : '');
  if (lv) msg += '\nДорога ' + durTxt(lv.tmin) + ' ' + HOW[saved.mode || s.mode] + ', выйти в <b>' + fmt(lv.leave) + '</b>';
  else if (saved.place && !s.home) msg += '\nУкажи дом в настройках приложения, и я посчитаю дорогу.';
  msg += placeNote;
  return send(env, uid, msg, [[{ text: 'Изменить в Beont', web_app: { url: APP_URL } }], [{ text: 'Удалить', callback_data: 'del:' + saved.id }]]);
}
async function onCallback(env, q) {
  const uid = q.from.id, [act, id] = String(q.data || '').split(':');
  const answer = t => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: t });
  if (act === 'snz') {
    await env.DB.prepare('INSERT INTO rem (user_id, task_id, at, kind) VALUES (?, ?, ?, ?)').bind(uid, id, Date.now() + 5 * 60000, 'snooze:0').run();
    return answer('Напомню через 5 минут');
  }
  if (act === 'go') {
    await env.DB.prepare("DELETE FROM rem WHERE user_id=? AND task_id=? AND sent=0 AND (kind LIKE 'leave:%' OR kind LIKE 'snooze:%')").bind(uid, id).run();
    return answer('Хорошей дороги!');
  }
  if (act === 'done') {
    const row = await env.DB.prepare('SELECT data FROM tasks WHERE user_id=? AND id=?').bind(uid, id).first();
    if (row) { const t = JSON.parse(row.data); t.done = true; await putTask(env, uid, t); await recompute(env, uid); }
    return answer('Отмечено');
  }
  if (act === 'del') {
    await env.DB.prepare('DELETE FROM tasks WHERE user_id=? AND id=?').bind(uid, id).run();
    await recompute(env, uid);
    if (q.message) await tg(env, 'editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    return answer('Удалено');
  }
  return answer('');
}

/* ---------------- text → task ---------------- */
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DOWS = { 'воскресенье': 0, 'вс': 0, 'понедельник': 1, 'пн': 1, 'вторник': 2, 'вт': 2, 'среду': 3, 'среда': 3, 'ср': 3, 'четверг': 4, 'чт': 4, 'пятницу': 5, 'пятница': 5, 'пт': 5, 'субботу': 6, 'суббота': 6, 'сб': 6 };
function guessCat(t) {
  t = t.toLowerCase();
  if (/(пара|пары|лекци|семинар|экзамен|зач[её]т|учеб|учёб|универ|институт|колледж|школ|урок|курсов|контрольн|сессия|практик|лаб)/.test(t)) return 'study';
  if (/(работ|смена|смену|созвон|совещан|клиент|офис|дедлайн|собеседован|планерк)/.test(t)) return 'work';
  if (/(мам|пап|бабушк|дедушк|брат|сестр|семь|родител|сын|доч|тёт|тет|дяд)/.test(t)) return 'family';
  if (/(друз|друг|подруг|кино|бар|тусовк|днюх|день рождения|вечеринк|встреча с)/.test(t)) return 'friends';
  if (/(врач|стоматолог|зал|трениров|спорт|бассейн|парикмахер|массаж|йога|бег|поликлиник)/.test(t)) return 'personal';
  return 'other';
}
function parseTask(text, tz) {
  const L = nowLocal(tz);
  let s = ' ' + text.replace(/\s+/g, ' ').trim() + ' ';
  let date = null, start = null, end = null, dur = null, m;
  const take = re => { const x = s.match(re); if (x) s = s.slice(0, x.index) + ' ' + s.slice(x.index + x[0].length); return x; };
  const hm = (h, mi) => { h = +h; mi = +(mi || 0); return h <= 24 && mi < 60 ? (h % 24) * 60 + mi : null; };
  if (take(/\s(сегодня)(?=[\s,.])/i)) date = L.key;
  else if (take(/\s(послезавтра)(?=[\s,.])/i)) date = addDaysKey(L.key, 2);
  else if (take(/\s(завтра)(?=[\s,.])/i)) date = addDaysKey(L.key, 1);
  else if ((m = take(/\s(?:в|во)?\s?(понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье)(?=[\s,.])/i))) {
    let diff = (DOWS[m[1].toLowerCase()] - L.dow + 7) % 7; if (diff === 0) diff = 7; date = addDaysKey(L.key, diff);
  } else if ((m = take(/\s(\d{1,2})\s(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?=[\s,.])/i))) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()); let y = L.y;
    let k = y + '-' + pad(mo + 1) + '-' + pad(+m[1]); if (k < L.key) k = (y + 1) + '-' + pad(mo + 1) + '-' + pad(+m[1]); date = k;
  } else if ((m = take(/\s(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?(?=[\s,])/))) {
    if (+m[2] >= 1 && +m[2] <= 12) { let y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : L.y; let k = y + '-' + pad(+m[2]) + '-' + pad(+m[1]); if (!m[3] && k < L.key) k = (y + 1) + '-' + pad(+m[2]) + '-' + pad(+m[1]); date = k; }
  }
  const T = '(\\d{1,2})(?:[:.](\\d{2}))?';
  if ((m = take(new RegExp('\\s(?:с|c)\\s' + T + '\\s(?:до|по)\\s' + T + '(?=[\\s,.])', 'i')))) { start = hm(m[1], m[2]); end = hm(m[3], m[4]); }
  else if ((m = take(new RegExp('\\s(?:в|во|к)\\s?' + T + '\\s?[-–—]\\s?' + T + '(?=[\\s,.])', 'i')))) { start = hm(m[1], m[2]); end = hm(m[3], m[4]); }
  else if ((m = take(new RegExp('\\s(?:в|во|к)\\s' + T + '(?:\\s?(?:ч|час[аов]*))?(?:\\s(утра|дня|вечера|ночи))?(?=[\\s,.])', 'i')))) {
    start = hm(m[1], m[2]);
    if (start != null && m[3]) { const h = Math.floor(start / 60); const p = m[3].toLowerCase(); if ((p === 'вечера' || p === 'дня') && h < 12) start += 720; if (p === 'ночи' && h === 12) start -= 720; }
  } else if ((m = take(/\s(\d{1,2})[:.](\d{2})(?=[\s,.])/))) start = hm(m[1], m[2]);
  if ((m = take(/\sна\s(полчаса|полтора часа|час|(\d+(?:[.,]5)?)\s?(?:ч|час|часа|часов)|(\d+)\s?(?:мин|минут|минуты|минуту))(?=[\s,.])/i))) {
    const w = m[1].toLowerCase();
    dur = w === 'полчаса' ? 30 : w === 'час' ? 60 : w === 'полтора часа' ? 90 : m[2] ? Math.round(parseFloat(m[2].replace(',', '.')) * 60) : +m[3];
  }
  if (start == null) return { error: 'time' };
  if (!date) date = start > L.min ? L.key : addDaysKey(L.key, 1);
  if (end != null) { dur = end - start; if (dur <= 0) dur += 1440; }
  if (!dur) dur = 60;
  let title = s, placeQ = null;
  const ci = title.indexOf(',');
  if (ci >= 0) { placeQ = title.slice(ci + 1).replace(/^[\s,]+|[\s,.]+$/g, ''); title = title.slice(0, ci); }
  else if ((m = title.match(/\s(?:на|в|во)\s((?:ул\.?|улица|проспект|пр-т|переулок|пер\.?|бульвар|шоссе|площадь)?\s?[А-ЯЁA-Z][^\s,]*(?:\s[А-ЯЁа-яёA-Za-z-]+)?\s\d+[а-яa-z]?(?:\/\d+)?)\s*$/))) {
    placeQ = m[1]; title = title.slice(0, m.index);
  } else if ((m = title.match(/\s((?:ул\.?|улица|проспект|пр-т|переулок|пер\.?|бульвар|шоссе)\s.+)$/i))) {
    placeQ = m[1]; title = title.slice(0, m.index);
  }
  title = title.replace(/\s+/g, ' ').replace(/^[\s,.\-–—:]+|[\s,.\-–—:]+$/g, '').replace(/\s(в|во|на|к)$/i, '').trim();
  if (!title) title = 'Дело';
  title = title.charAt(0).toUpperCase() + title.slice(1);
  if (placeQ && placeQ.length < 3) placeQ = null;
  return { title: title.slice(0, 200), date, start, dur, placeQ, cat: guessCat(text) };
}

/* ---------------- Mini App auth ---------------- */
async function authUser(req, env) {
  const init = req.headers.get('x-init-data') || '';
  if (!init) return null;
  const p = new URLSearchParams(init);
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => k + '=' + v).join('\n');
  const secret = await hmac('WebAppData', env.BOT_TOKEN);
  const calc = hex(await hmac(secret, dcs));
  if (calc !== hash) return null;
  const age = Date.now() / 1000 - (+p.get('auth_date') || 0);
  if (age > 30 * 86400) return null;
  try { return JSON.parse(p.get('user')).id; } catch (e) { return null; }
}

/* ---------------- router ---------------- */
async function route(req, env, ctx) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (!env.BOT_TOKEN) return json({ error: 'BOT_TOKEN secret is not set' }, 500, req);
  await init(env);
  if (url.pathname === '/tg' && req.method === 'POST') {
    if (req.headers.get('x-telegram-bot-api-secret-token') !== await webhookSecret(env)) return new Response('forbidden', { status: 403 });
    const u = await req.json();
    ctx.waitUntil(onUpdate(env, u).catch(e => console.error('update', e && e.stack || e)));
    return new Response('ok');
  }
  if (url.pathname === '/setup') {
    const w = await tg(env, 'setWebhook', { url: url.origin + '/tg', secret_token: await webhookSecret(env), allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
    const c = await tg(env, 'setMyCommands', { commands: [{ command: 'today', description: 'Дела на сегодня' }, { command: 'tomorrow', description: 'Дела на завтра' }, { command: 'help', description: 'Как добавлять дела' }] });
    return new Response('webhook: ' + (w.ok ? 'ok' : JSON.stringify(w)) + '\ncommands: ' + (c.ok ? 'ok' : JSON.stringify(c)), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (url.pathname === '/') return new Response('Beont bot server is running', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (url.pathname.startsWith('/api/')) {
    const uid = await authUser(req, env);
    if (!uid) return json({ error: 'auth' }, 401, req);
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const s = await getUser(env, uid);
      const tasks = await listTasks(env, uid);
      return json({ settings: s, tasks }, 200, req);
    }
    if (url.pathname === '/api/task' && req.method === 'PUT') {
      const t = await putTask(env, uid, await req.json());
      ctx.waitUntil(recompute(env, uid));
      return json({ ok: true, task: t }, 200, req);
    }
    if (url.pathname === '/api/task' && req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM tasks WHERE user_id=? AND id=?').bind(uid, url.searchParams.get('id') || '').run();
      ctx.waitUntil(recompute(env, uid));
      return json({ ok: true }, 200, req);
    }
    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      const s = await putSettings(env, uid, await req.json());
      ctx.waitUntil(recompute(env, uid));
      return json({ ok: true, settings: s }, 200, req);
    }
    if (url.pathname === '/api/import' && req.method === 'POST') {
      const body = await req.json();
      const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id=?').bind(uid).first();
      if (have && have.n > 0) return json({ ok: false, reason: 'not empty' }, 200, req);
      for (const t of (body.tasks || []).slice(0, 500)) await putTask(env, uid, t);
      if (body.settings) await putSettings(env, uid, body.settings);
      ctx.waitUntil(recompute(env, uid));
      return json({ ok: true }, 200, req);
    }
    return json({ error: 'not found' }, 404, req);
  }
  return new Response('not found', { status: 404 });
}

