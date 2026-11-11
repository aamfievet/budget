'use strict';
/* Budget Hebdo — application de budget hebdomadaire (XPF)
   Données stockées localement (IndexedDB) + sauvegarde Google Drive. */

const APP_VERSION = '1.6.1';
const DRIVE_FOLDER = 'Budget Hebdo';
const DRIVE_DATA = 'budget-data.json';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

/* ---------- Outils dates (toujours en UTC pour éviter les décalages) ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (s, n) => { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const today = () => { const n = new Date(); return n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate()); };
const mondayOf = s => { const d = parseD(s); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return ymd(d); };
const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return ymd(d).slice(0, 7); };
function isoWeek(s) {
  const d = parseD(s); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7 + 3);
  const y = d.getUTCFullYear(); const first = new Date(Date.UTC(y, 0, 4));
  first.setUTCDate(first.getUTCDate() - (first.getUTCDay() + 6) % 7 + 3);
  return { w: 1 + Math.round((d - first) / 6048e5), y };
}
const fdate = (s, o) => parseD(s).toLocaleDateString('fr-FR', Object.assign({ timeZone: 'UTC' }, o));
const fday = s => fdate(s, { weekday: 'long', day: 'numeric', month: 'long' });
const fshort = s => fdate(s, { day: 'numeric', month: 'short' });
const fmonth = ym => fdate(ym + '-01', { month: 'long', year: 'numeric' });

/* ---------- Outils divers ---------- */
const fmt = n => Math.round(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ') + ' F';
const toInt = v => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return isNaN(n) ? 0 : n; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = sel => document.querySelector(sel);
function toast(msg, ms = 2500) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }

/* ---------- Base de données (IndexedDB) ---------- */
const STORES = ['settings', 'incomeTypes', 'chargeTypes', 'categories', 'monthItems', 'expenses', 'photos'];
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('budget-hebdo', 1);
    r.onupgradeneeded = () => STORES.forEach(s => { if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' }); });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const tx = (store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode); const st = t.objectStore(store); const out = fn(st);
  t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error);
});
const dbAll = s => new Promise((res, rej) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbGet = (s, id) => new Promise((res, rej) => { const r = db.transaction(s).objectStore(s).get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbPut = (s, o) => tx(s, 'readwrite', st => { st.put(o); });
const dbDel = (s, id) => tx(s, 'readwrite', st => { st.delete(id); });
const dbClear = s => tx(s, 'readwrite', st => { st.clear(); });

/* Données en mémoire (tout sauf les photos) */
const S = { settings: null, incomeTypes: [], chargeTypes: [], categories: [], monthItems: [], expenses: [] };
const LIST_STORES = ['incomeTypes', 'chargeTypes', 'categories', 'monthItems', 'expenses'];
function put(store, obj) { const arr = S[store]; const i = arr.findIndex(x => x.id === obj.id); if (i >= 0) arr[i] = obj; else arr.push(obj); dbPut(store, obj); invalidate(); }
function remove(store, id) { S[store] = S[store].filter(x => x.id !== id); dbDel(store, id); invalidate(); }
function saveSettings() { dbPut('settings', S.settings); invalidate(); }

function defaults() {
  const t = today();
  S.settings = { id: 'main', carryOver: true, startDate: mondayOf(t), clientId: '', lastBackup: null, months: {}, dataFileId: null, folderId: null };
  const inc = [
    { id: uid(), name: 'Salaire', variable: false, amount: 0, active: true, note: 'Reçu le 25 du mois précédent' },
    { id: uid(), name: 'Revenu complémentaire', variable: true, amount: 0, active: true, note: 'Reçu entre le 12 et le 17' }];
  const ch = ['Loyer', 'Électricité', 'Eau', 'Téléphone / Internet', 'Assurances', 'Crédit'].map(n => ({ id: uid(), name: n, amount: 0, active: true }));
  const cats = [
    ['Courses', '🛒', 'casino,carrefour,geant,géant,super u,leader price,champion,korail,johnston,ballande,marché,supermarche'],
    ['Carburant', '⛽', 'total,mobil,pacific energy,station,gazole,gasoil,essence,sp95,sans plomb,carburant'],
    ['Santé', '💊', 'pharmacie,médecin,docteur,laboratoire'],
    ['Maison', '🏠', 'bricolage,quincaillerie,mr bricolage,leroy'],
    ['Loisirs', '🎉', 'restaurant,snack,cinéma,bar'],
    ['Divers', '📦', '']].map(([name, icon, keywords]) => ({ id: uid(), name, icon, keywords }));
  dbPut('settings', S.settings);
  inc.forEach(o => { S.incomeTypes.push(o); dbPut('incomeTypes', o); });
  ch.forEach(o => { S.chargeTypes.push(o); dbPut('chargeTypes', o); });
  cats.forEach(o => { S.categories.push(o); dbPut('categories', o); });
}

/* ---------- Calcul du budget ---------- */
let cache = { daily: new Map(), spentByDay: null };
function invalidate() { cache = { daily: new Map(), spentByDay: null }; }
const curYm = () => today().slice(0, 7);
const startYm = () => S.settings.startDate.slice(0, 7);

/* Crée les lignes du mois (revenus fixes + charges) à partir des types, une seule fois par mois */
function ensureMonth(ym) {
  if (ym < startYm()) return false;
  if (S.settings.months[ym]) return true;
  S.settings.months[ym] = true;
  S.incomeTypes.filter(t => t.active && !t.variable && t.amount > 0).forEach(t => put('monthItems', { id: uid(), month: ym, kind: 'income', typeId: t.id, name: t.name, amount: t.amount, date: ym + '-01', auto: true }));
  S.chargeTypes.filter(t => t.active && t.amount > 0).forEach(t => put('monthItems', { id: uid(), month: ym, kind: 'charge', typeId: t.id, name: t.name, amount: t.amount, date: ym + '-01', auto: true }));
  saveSettings();
  return true;
}
/* Quand on modifie un type, on répercute sur le mois en cours et les suivants (lignes automatiques seulement) */
function syncType(kind, t, deleted) {
  const cur = curYm();
  Object.keys(S.settings.months).filter(ym => ym >= cur).forEach(ym => {
    const items = S.monthItems.filter(i => i.month === ym && i.typeId === t.id);
    const autoIt = items.find(i => i.auto);
    const wanted = !deleted && t.active && !(kind === 'income' && t.variable) && t.amount > 0;
    if (wanted) {
      if (autoIt) put('monthItems', { ...autoIt, amount: t.amount, name: t.name });
      else if (!items.length) put('monthItems', { id: uid(), month: ym, kind, typeId: t.id, name: t.name, amount: t.amount, date: ym + '-01', auto: true });
    } else if (autoIt) remove('monthItems', autoIt.id);
    items.filter(i => !i.auto && !deleted).forEach(i => { if (i.name !== t.name) put('monthItems', { ...i, name: t.name }); });
  });
}
/* Répartit un montant entier sur des jours, sans perte d'arrondi */
function spread(arr, amount, from) {
  from = Math.max(0, Math.min(from, arr.length - 1));
  const n = arr.length - from; const base = Math.trunc(amount / n); let r = amount - base * n;
  for (let i = 0; i < n; i++) { let v = base; if (r > 0) { v++; r--; } else if (r < 0) { v--; r++; } arr[from + i] += v; }
}
/* Budget par jour d'un mois : charges réparties sur tout le mois, chaque revenu à partir de sa date de réception */
function monthDaily(ym) {
  if (cache.daily.has(ym)) return cache.daily.get(ym);
  const arr = new Array(daysInMonth(ym)).fill(0);
  if (ensureMonth(ym)) {
    const byStart = {}; // montants nets regroupés par jour de départ (évite les écarts d'arrondi)
    S.monthItems.filter(i => i.month === ym).forEach(i => {
      const from = i.kind === 'charge' ? 0 : (i.date && i.date.slice(0, 7) === ym) ? parseD(i.date).getUTCDate() - 1 : 0;
      byStart[from] = (byStart[from] || 0) + (i.kind === 'charge' ? -i.amount : i.amount);
    });
    Object.entries(byStart).forEach(([from, amt]) => spread(arr, amt, +from));
  }
  cache.daily.set(ym, arr);
  return arr;
}
const dayBudget = s => s < S.settings.startDate ? 0 : monthDaily(s.slice(0, 7))[parseD(s).getUTCDate() - 1];
function spentOn(s) {
  if (!cache.spentByDay) { cache.spentByDay = new Map(); S.expenses.forEach(e => cache.spentByDay.set(e.date, (cache.spentByDay.get(e.date) || 0) + e.amount)); }
  return cache.spentByDay.get(s) || 0;
}
function weekRaw(mon) {
  let budget = 0, spent = 0; const parts = {};
  for (let i = 0; i < 7; i++) { const d = addDays(mon, i); const b = dayBudget(d); budget += b; spent += spentOn(d); const ym = d.slice(0, 7); parts[ym] = (parts[ym] || 0) + b; }
  return { budget, spent, parts };
}
/* État d'une semaine avec report des semaines précédentes */
function weekState(mon) {
  const startMon = mondayOf(S.settings.startDate);
  let carry = 0;
  if (mon >= startMon) {
    for (let w = startMon; w < mon; w = addDays(w, 7)) { const r = weekRaw(w); carry = S.settings.carryOver ? carry + r.budget - r.spent : 0; }
  }
  const r = weekRaw(mon); const avail = r.budget + (S.settings.carryOver ? carry : 0);
  return { ...r, carry: S.settings.carryOver ? carry : 0, avail, remain: avail - r.spent };
}

/* ---------- Navigation & rendu ---------- */
const ui = { tab: 'week', week: mondayOf(today()), month: curYm() };
function go(tab) { ui.tab = tab; render(); window.scrollTo(0, 0); }
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  $('#fab').classList.toggle('hidden', ui.tab === 'settings');
  const v = $('#view');
  v.innerHTML = ui.tab === 'week' ? viewWeek() : ui.tab === 'month' ? viewMonth() : viewSettings();
  loadThumbs();
}
function status(remain, avail) { if (remain < 0) return 'bad'; if (avail === 0 && remain === 0) return 'ok'; if (avail <= 0) return remain > 0 ? 'ok' : 'bad'; return remain / avail < 0.25 ? 'warn' : 'ok'; }
const catOf = id => S.categories.find(c => c.id === id) || { name: 'Sans catégorie', icon: '❔' };
const HUES = [145, 200, 30, 280, 340, 50, 175, 230];
const catHue = id => HUES[Math.max(0, S.categories.findIndex(c => c.id === id)) % HUES.length];

function banners() {
  let h = '';
  const noIncome = !S.monthItems.some(i => i.kind === 'income') && !S.incomeTypes.some(t => t.amount > 0);
  if (noIncome) h += `<div class="banner">👋 Bienvenue ! Commence par saisir ton salaire et tes charges fixes dans <b>Réglages</b>.<br><button class="btn" onclick="go('settings')">Ouvrir les réglages</button></div>`;
  const lb = S.settings.lastBackup;
  if (!noIncome && S.expenses.length && (!lb || Date.now() - lb > 7 * 864e5)) h += `<div class="banner">☁️ ${lb ? 'Dernière sauvegarde il y a plus de 7 jours.' : 'Aucune sauvegarde pour l’instant.'} <br><button class="btn" onclick="A.backup()">Sauvegarder sur Google Drive</button></div>`;
  const pend = pendingVariable(curYm());
  if (pend.length) h += `<div class="banner">⏳ En attente ce mois-ci : <b>${pend.map(t => esc(t.name)).join(', ')}</b>. Dès réception, saisis le montant pour mettre à jour tes semaines.<br><button class="btn" onclick="A.addIncome('${curYm()}','${pend[0].id}')">Saisir le montant reçu</button></div>`;
  return h;
}
function pendingVariable(ym) {
  if (ym < startYm()) return [];
  return S.incomeTypes.filter(t => t.active && t.variable && !S.monthItems.some(i => i.month === ym && i.typeId === t.id));
}

function viewWeek() {
  const mon = ui.week, sun = addDays(mon, 6), st = weekState(mon), { w } = isoWeek(mon);
  const cls = status(st.remain, st.avail);
  const pct = st.avail > 0 ? Math.min(100, Math.max(0, st.spent / st.avail * 100)) : 100;
  const t = today(), isCur = t >= mon && t <= sun;
  let perday = '';
  if (isCur) { const left = Math.round((parseD(sun) - parseD(t)) / 864e5) + 1; perday = st.avail === 0 && st.spent === 0 ? '' : st.remain > 0 ? `≈ ${fmt(st.remain / left)} par jour pendant ${left} jour${left > 1 ? 's' : ''}` : 'Budget de la semaine épuisé'; }
  const partsTxt = Object.keys(st.parts).length > 1 ? Object.entries(st.parts).map(([ym, v]) => `${fmt(v)} de ${fdate(ym + '-01', { month: 'long' })}`).join(' + ') : '';
  const leftRatio = st.avail > 0 ? Math.min(1, Math.max(0, st.remain / st.avail)) : 0;
  const C = 2 * Math.PI * 52;
  let mood;
  if (st.avail === 0 && st.spent === 0) mood = 'Prêt à démarrer 🚀';
  else if (t > sun) mood = st.remain >= 0 ? `Semaine réussie ! ${S.settings.carryOver ? fmt(st.remain) + ' reportés 🎉' : '🎉'}` : 'Semaine dépassée, on se rattrape 💪';
  else if (t < mon) mood = 'Semaine à venir 🔮';
  else if (cls === 'bad') mood = 'Oups, budget dépassé 😬 On ralentit un peu.';
  else if (cls === 'warn') mood = 'Attention, on lève le pied 🐢';
  else mood = leftRatio > 0.6 ? 'Tout roule, continue comme ça 👌' : 'Sur la bonne voie 🙂';
  let h = `<header class="hero ${cls}">
    <div class="hero-top"><button class="round" onclick="A.week(-1)" aria-label="Semaine précédente">‹</button>
      <div class="wk-pill">Semaine ${w}</div>
      <button class="round" onclick="A.week(1)" aria-label="Semaine suivante">›</button></div>
    <div class="hero-dates">du ${fshort(mon)} au ${fshort(sun)}</div>
    <div class="ring"><svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="52"/><circle class="prog" cx="60" cy="60" r="52" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - leftRatio)).toFixed(1)}"/></svg>
      <div class="ring-txt"><small>Il me reste</small><b class="remain">${fmt(st.remain)}</b><small>sur ${fmt(st.avail)}</small></div></div>
    <div class="mood">${mood}</div>
    ${perday ? `<div class="perday">${perday}</div>` : ''}
    ${!isCur ? `<button class="today-btn" onclick="A.thisWeek()">↩ Revenir à cette semaine</button>` : ''}
  </header>
  ${isCur ? banners() : ''}
  <div class="stats">
    <div class="stat s1"><span>🎯</span><small>Budget</small><b>${fmt(st.budget)}</b></div>
    <div class="stat s2"><span>🔁</span><small>Report</small><b>${st.carry > 0 ? '+' : ''}${fmt(st.carry)}</b></div>
    <div class="stat s3"><span>🧾</span><small>Dépensé</small><b>${fmt(st.spent)}</b></div>
  </div>
  ${partsTxt ? `<p class="help" style="padding:0 20px">Semaine à cheval sur deux mois : ${partsTxt}</p>` : ''}
  <div class="section"><h2>Mes dépenses <button onclick="A.expense()">+ Ajouter</button></h2>`;
  const exps = S.expenses.filter(e => e.date >= mon && e.date <= sun).sort((a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0));
  if (!exps.length) h += `<div class="list"><div class="empty"><div class="empty-ico">🌱</div>Aucune dépense cette semaine.<br>Touche le bouton <b>+</b> pour en ajouter une.</div></div>`;
  let day = null;
  exps.forEach(e => {
    if (e.date !== day) {
      if (day) h += '</div>';
      day = e.date; const tot = exps.filter(x => x.date === day).reduce((s, x) => s + x.amount, 0);
      h += `<div class="day-title"><span style="text-transform:capitalize">${fday(day)}</span><span>${fmt(tot)}</span></div><div class="list">`;
    }
    h += expRow(e);
  });
  if (day) h += '</div>';
  return h + '</div>';
}
function expRow(e) {
  const c = catOf(e.categoryId);
  return `<div class="row" onclick="A.expense('${e.id}')">
    ${e.photoId ? `<img class="thumb" data-photo="${e.photoId}" alt="">` : `<span class="bubble" style="--h:${catHue(e.categoryId)}">${c.icon || '•'}</span>`}
    <div class="mid"><div>${esc(e.note || c.name)}</div><small>${esc(c.name)}${e.photoId ? ' · 📷' : ''}</small></div>
    <div class="amt">${fmt(e.amount)}</div></div>`;
}

function viewMonth() {
  const ym = ui.month; ensureMonth(ym);
  const items = S.monthItems.filter(i => i.month === ym);
  const inc = items.filter(i => i.kind === 'income'), ch = items.filter(i => i.kind === 'charge');
  const tInc = inc.reduce((s, i) => s + i.amount, 0), tCh = ch.reduce((s, i) => s + i.amount, 0);
  const pend = pendingVariable(ym);
  const before = ym < startYm();
  let h = `<header class="month-head"><div class="wk-nav"><button onclick="A.month(-1)">‹</button><div><div class="wk-num">${fmonth(ym)}</div><div class="wk-dates">Solde du mois</div></div><button onclick="A.month(1)">›</button></div>
    <div class="big" style="color:${tInc - tCh < 0 ? 'var(--red)' : 'var(--green)'}">${fmt(tInc - tCh)}</div>
    <div class="muted" style="font-size:14px">${fmt(tInc)} de revenus − ${fmt(tCh)} de charges</div></header>`;
  if (before) return h + `<div class="empty">Ce mois est avant la date de début de suivi (${fshort(S.settings.startDate)}).<br>Tu peux la modifier dans Réglages.</div>`;
  h += `<div class="section"><h2>Revenus <button onclick="A.addIncome('${ym}')">+ Ajouter</button></h2><div class="list">`;
  inc.sort((a, b) => a.date.localeCompare(b.date)).forEach(i => h += `<div class="row" onclick="A.editItem('${i.id}')"><span class="ico">💶</span><div class="mid"><div>${esc(i.name)}</div><small>${i.date.slice(0, 7) === ym ? 'compté à partir du ' + fshort(i.date) : 'compté sur tout le mois'}</small></div><div class="amt pos">+${fmt(i.amount)}</div></div>`);
  pend.forEach(t => h += `<div class="row" onclick="A.addIncome('${ym}','${t.id}')"><span class="ico" style="--h:40">⏳</span><div class="mid"><div>${esc(t.name)}</div><small class="pending">En attente — touche pour saisir le montant reçu</small></div><div class="amt">—</div></div>`);
  if (!inc.length && !pend.length) h += `<div class="empty">Aucun revenu. Ajoute tes types de revenus dans Réglages.</div>`;
  h += `</div></div><div class="section"><h2>Charges fixes <button onclick="A.addCharge('${ym}')">+ Ajouter</button></h2><div class="list">`;
  ch.sort((a, b) => b.amount - a.amount).forEach(i => h += `<div class="row" onclick="A.editItem('${i.id}')"><span class="ico" style="--h:20">📄</span><div class="mid"><div>${esc(i.name)}</div></div><div class="amt neg">−${fmt(i.amount)}</div></div>`);
  if (!ch.length) h += `<div class="empty">Aucune charge fixe ce mois-ci.</div>`;
  h += `</div></div>`;
  // Répartition par semaine
  const first = ym + '-01', last = ym + '-' + pad(daysInMonth(ym));
  const arr = monthDaily(ym); const curMon = mondayOf(today());
  h += `<div class="section"><h2>Répartition par semaine</h2><table class="weeks"><tr><th>Semaine</th><th>Dates</th><th>Jours</th><th>Part du mois</th></tr>`;
  for (let m = mondayOf(first); m <= last; m = addDays(m, 7)) {
    let days = 0, part = 0;
    for (let i = 0; i < 7; i++) { const d = addDays(m, i); if (d >= first && d <= last && d >= S.settings.startDate) { days++; part += arr[parseD(d).getUTCDate() - 1]; } }
    h += `<tr class="${m === curMon ? 'cur' : ''}" onclick="A.openWeek('${m}')"><td><b>S${isoWeek(m).w}</b></td><td>${fshort(m)} → ${fshort(addDays(m, 6))}</td><td>${days}</td><td><b>${fmt(part)}</b></td></tr>`;
  }
  h += `</table><p class="help">Les charges sont réparties sur tous les jours du mois ; chaque revenu à partir de sa date de réception. Une semaine à cheval prend une part de chaque mois.</p></div>`;
  // Dépenses du mois par catégorie
  const exps = S.expenses.filter(e => e.date >= first && e.date <= last); const tExp = exps.reduce((s, e) => s + e.amount, 0);
  const byCat = {}; exps.forEach(e => byCat[e.categoryId] = (byCat[e.categoryId] || 0) + e.amount);
  h += `<div class="section"><h2>Dépenses du mois</h2><div class="list">`;
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([id, v]) => { const c = catOf(id); h += `<div class="row"><span class="ico" style="--h:${catHue(c.id)}">${c.icon}</span><div class="mid"><div>${esc(c.name)}</div><small>${Math.round(v / tExp * 100)} %</small></div><div class="amt">${fmt(v)}</div></div>`; });
  h += `<div class="row total-row"><span class="ico">Σ</span><div class="mid"><div>Total dépensé</div></div><div class="amt">${fmt(tExp)}</div></div>
    <div class="row total-row"><span class="ico">=</span><div class="mid"><div>Reste sur le mois</div></div><div class="amt ${tInc - tCh - tExp < 0 ? 'neg' : 'pos'}">${fmt(tInc - tCh - tExp)}</div></div></div></div>`;
  return h;
}

function viewSettings() {
  const st = S.settings;
  let h = `<header class="month-head"><div class="wk-num">Réglages</div></header>`;
  h += `<div class="section"><h2>Types de revenus <button onclick="A.incomeType()">+ Ajouter</button></h2><div class="list">`;
  S.incomeTypes.forEach(t => h += `<div class="row" onclick="A.incomeType('${t.id}')"><span class="ico">💶</span><div class="mid"><div>${esc(t.name)}${t.active ? '' : ' (inactif)'}</div><small>${t.variable ? 'Montant variable, saisi chaque mois' : 'Fixe, chaque mois'}</small></div><div class="amt">${t.variable ? '—' : fmt(t.amount)}</div></div>`);
  h += `</div></div><div class="section"><h2>Charges fixes <button onclick="A.chargeType()">+ Ajouter</button></h2><div class="list">`;
  S.chargeTypes.forEach(t => h += `<div class="row" onclick="A.chargeType('${t.id}')"><span class="ico" style="--h:20">📄</span><div class="mid"><div>${esc(t.name)}${t.active ? '' : ' (inactif)'}</div></div><div class="amt">${fmt(t.amount)}</div></div>`);
  const tI = S.incomeTypes.filter(t => t.active && !t.variable).reduce((s, t) => s + t.amount, 0), tC = S.chargeTypes.filter(t => t.active).reduce((s, t) => s + t.amount, 0);
  h += `<div class="row total-row"><span class="ico">=</span><div class="mid"><div>Solde mensuel de base</div><small>revenus fixes − charges (hors revenus variables)</small></div><div class="amt ${tI - tC < 0 ? 'neg' : 'pos'}">${fmt(tI - tC)}</div></div>`;
  h += `</div><p class="help">Une modification s’applique au mois en cours et aux suivants. Pour un changement ponctuel, modifie la ligne dans l’onglet Mois.</p></div>`;
  h += `<div class="section"><h2>Catégories de dépenses <button onclick="A.category()">+ Ajouter</button></h2><div class="list">`;
  S.categories.forEach(c => h += `<div class="row" onclick="A.category('${c.id}')"><span class="ico" style="--h:${catHue(c.id)}">${c.icon}</span><div class="mid"><div>${esc(c.name)}</div><small>${esc(c.keywords || 'aucun mot-clé')}</small></div></div>`);
  h += `</div></div>`;
  h += `<div class="section"><h2>Options</h2><div class="list" style="padding:4px 14px">
    <label class="chk"><input type="checkbox" ${st.carryOver ? 'checked' : ''} onchange="A.setCarry(this.checked)"> Reporter le reste (ou le dépassement) sur la semaine suivante</label>
    <label class="f"><span>Thème de l’affichage</span><select onchange="A.setTheme(this.value)">${[['auto','Automatique (comme le téléphone)'],['light','☀️ Clair'],['dark','🌙 Sombre']].map(([v,l])=>`<option value="${v}" ${(st.theme||'auto')===v?'selected':''}>${l}</option>`).join('')}</select></label>
    <label class="f"><span>Début du suivi (le budget est calculé à partir de cette date)</span><input type="date" value="${st.startDate}" onchange="A.setStart(this.value)"></label></div></div>`;
  h += `<div class="section"><h2>Sauvegarde Google Drive</h2><div class="list" style="padding:4px 14px 14px">
    <label class="f"><span>Identifiant client Google (voir le guide d’installation)</span><input id="cid" value="${esc(clientId())}" placeholder="xxxxxxxx.apps.googleusercontent.com"></label><button class="btn ghost block" onclick="A.setClientId($('#cid').value)">Enregistrer l’identifiant</button>${(window.BUDGET_CONFIG || {}).googleClientId ? '<p class="help">✅ Identifiant intégré à l’application (fichier config.js).</p>' : ''}
    <p class="help">Dernière sauvegarde : ${st.lastBackup ? new Date(st.lastBackup).toLocaleString('fr-FR') : 'jamais'}</p>
    <div id="drive-status" class="help"></div>
    <div class="btns"><button class="btn" onclick="A.backup()">☁️ Sauvegarder</button><button class="btn ghost" onclick="A.restore()">⤓ Restaurer</button></div>
    <p class="help">L’app n’a accès qu’au dossier « ${DRIVE_FOLDER} » qu’elle crée dans ton Drive.</p></div></div>`;
  h += `<div class="section"><h2>Fichier de secours</h2><div class="list" style="padding:4px 14px 14px">
    <p class="help">Exporte toutes tes données (photos comprises) dans un fichier, sans passer par Google.</p>
    <div class="btns"><button class="btn ghost" onclick="A.exportFile()">Exporter</button><label class="btn ghost">Importer<input type="file" accept="application/json,.json" hidden onchange="A.importFile(this.files[0])"></label></div></div></div>`;
  h += `<div class="section">${deferredInstall ? `<button class="btn block" onclick="A.install()">📲 Installer l’application</button>` : ''}<button class="btn ghost block" onclick="A.checkUpdate()">🔄 Vérifier les mises à jour</button><p class="help" style="text-align:center">Budget Hebdo v${APP_VERSION} · ${S.expenses.length} dépenses enregistrées</p></div>`;
  return h;
}

/* ---------- Feuille modale ---------- */
function sheet(html) { const s = $('#sheet'); s.querySelector('.sheet-body').innerHTML = html; s.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeSheet() { $('#sheet').classList.add('hidden'); document.body.style.overflow = ''; }
$('#sheet .sheet-bg').onclick = closeSheet;

/* Formulaire générique */
function form(title, fields, vals, onSave, onDelete) {
  let h = `<h3>${esc(title)}</h3><form id="gf">`;
  fields.forEach(f => {
    const v = vals[f.k] ?? '';
    if (f.t === 'chk') h += `<label class="chk"><input type="checkbox" name="${f.k}" ${v ? 'checked' : ''}> ${esc(f.l)}</label>`;
    else if (f.t === 'select') h += `<label class="f"><span>${esc(f.l)}</span><select name="${f.k}">${f.o.map(o => `<option value="${o.v}" ${o.v === v ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select></label>`;
    else if (f.t === 'money') h += `<label class="f"><span>${esc(f.l)}</span><input class="amount" name="${f.k}" inputmode="numeric" value="${v === '' ? '' : v}" placeholder="0"></label>`;
    else h += `<label class="f"><span>${esc(f.l)}</span><input name="${f.k}" type="${f.t || 'text'}" value="${esc(v)}" ${f.ph ? `placeholder="${esc(f.ph)}"` : ''}></label>`;
    if (f.help) h += `<p class="help">${f.help}</p>`;
  });
  h += `<div class="btns"><button type="submit" class="btn">Enregistrer</button><button type="button" class="btn ghost" onclick="closeSheet()">Annuler</button></div>
    ${onDelete ? `<div class="btns"><button type="button" class="btn danger block" id="gf-del">Supprimer</button></div>` : ''}</form>`;
  sheet(h);
  const el = $('#gf');
  el.onsubmit = e => {
    e.preventDefault(); const out = {};
    fields.forEach(f => { const i = el.elements[f.k]; out[f.k] = f.t === 'chk' ? i.checked : f.t === 'money' ? toInt(i.value) : i.value.trim(); });
    if (onSave(out) !== false) { closeSheet(); render(); }
  };
  if (onDelete) $('#gf-del').onclick = () => { if (confirm('Supprimer définitivement ?')) { onDelete(); closeSheet(); render(); } };
}

/* ---------- Photos : compression & OCR ---------- */
async function loadImg(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
}
function drawScaled(img, max, gray) {
  const w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  const x = c.getContext('2d'); if (gray) x.filter = 'grayscale(1) contrast(1.4)'; x.drawImage(img, 0, 0, c.width, c.height); return c;
}
const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
/* Photo conservée : 1280 px max, JPEG, visée < 250 Ko */
async function compress(img) {
  const c = drawScaled(img, 1280); let q = 0.7, b = await toBlob(c, q);
  while (b.size > 250000 && q > 0.35) { q -= 0.1; b = await toBlob(c, q); }
  return b;
}
let tessLoading;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Chargement impossible : ' + src)); document.head.appendChild(s); }); }
async function ocr(img, onProgress) {
  if (!window.Tesseract) { tessLoading = tessLoading || loadScript(TESSERACT_URL); await tessLoading; }
  const worker = await Tesseract.createWorker('fra', 1, { logger: m => m.status === 'recognizing text' && onProgress && onProgress(Math.round(m.progress * 100)) });
  try { const { data } = await worker.recognize(drawScaled(img, 1800, true)); return data.text || ''; }
  finally { worker.terminate(); }
}
/* Extraction montant / date / magasin / catégorie depuis le texte du ticket */
function parseNumbers(line) {
  line = line.replace(/[\d ,.]+\s*%/g, " "); // les pourcentages ne sont pas des montants
  const out = []; const re = /\d{1,3}(?:[ . ]\d{3})+(?!\d)|\d+(?:[,.]\d{1,2})?(?!\d)/g; let m;
  while ((m = re.exec(line))) {
    const s = m[0]; let n;
    if (/^\d{1,3}([ . ]\d{3})+$/.test(s)) n = parseInt(s.replace(/[ . ]/g, ''), 10);
    else n = Math.round(parseFloat(s.replace(',', '.')));
    if (n > 0 && n < 5000000) out.push(n);
  }
  return out;
}
/* Recherche de la date d'achat : tolère les erreurs de lecture (O/0, l/1, espaces),
   les formats 10/11/2026, 10-11-26, 10.11.26, 2026-11-10 et « 10 nov. 2026 ».
   On garde de préférence une date suivie d'une heure, de moins de 2 mois (jamais dans le futur). */
const MOIS = { jan: 1, fev: 2, fév: 2, mar: 3, avr: 4, mai: 5, juin: 6, juil: 7, aou: 8, aoû: 8, sep: 9, oct: 10, nov: 11, dec: 12, déc: 12 };
function findDate(text) {
  const t = text.replace(/(?<=\d)[oO](?=\d|[\/.-])|(?<=[\/.-])[oO]/g, '0').replace(/(?<=\d|[\/.-])[lI|](?=\d)|(?<=\d)[lI|]/g, '1');
  const max = today(), min = addDays(max, -62), cands = []; // ticket de moins de 2 mois
  const ok = (y, m, d) => {
    y = +y; m = +m; d = +d; if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const s = `${y}-${pad(m)}-${pad(d)}`; const dt = parseD(s);
    if (isNaN(dt) || dt.getUTCDate() !== d) return null;
    return s >= min && s <= max ? s : null;
  };
  let m; const re1 = /(\d{1,2})\s*[\/.-]\s*(\d{1,2})\s*[\/.-]\s*(\d{4}|\d{2})(?!\d)/g;
  while ((m = re1.exec(t))) cands.push([m.index, ok(m[3], m[2], m[1]), /^\s*\d{1,2}\s*[:hH]\s*\d{2}/.test(t.slice(m.index + m[0].length, m.index + m[0].length + 12))]);
  const re2 = /(20\d{2})-(\d{2})-(\d{2})/g;
  while ((m = re2.exec(t))) cands.push([m.index, ok(m[1], m[2], m[3])]);
  const re3 = /(\d{1,2})\s*(jan\w*|f[ée]v\w*|mar\w*|avr\w*|mai|juin|juil\w*|ao[uû]\w*|sep\w*|oct\w*|nov\w*|d[ée]c\w*)\.?\s*(\d{4}|\d{2})?/gi;
  while ((m = re3.exec(t))) {
    const k = m[2].toLowerCase(); const mo = MOIS[k.slice(0, 4)] || MOIS[k.slice(0, 3)];
    let y = m[3] || max.slice(0, 4); let s = ok(y, mo, m[1]);
    if (!s && !m[3]) s = ok(+y - 1, mo, m[1]);
    cands.push([m.index, s]);
  }
  const good = cands.filter(c => c[1]).sort((a, b) => (b[2] ? 1 : 0) - (a[2] ? 1 : 0) || b[1].localeCompare(a[1]));
  return good.length ? good[0][1] : null;
}
/* Enseignes connues (Nouvelle-Calédonie) : servent à reconnaître le magasin malgré les erreurs de lecture.
   Les mots-clés des catégories (Réglages) sont aussi utilisés. */
const SHOPS = ['Carrefour Market', 'Carrefour', 'Champion', 'Géant Casino', 'Casino', 'Super U', 'Hyper U', 'Leader Price', 'Korail',
  'Johnston', 'Ballande', 'Pacific Energy', 'Total', 'Mobil', 'Pharmacie', 'Mr Bricolage', 'Bricorama', 'Pacific Food', 'Discount'];
const compact = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
function lev(a, b) {
  const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
/* Cherche le mot k dans la ligne en acceptant ~1 erreur sur 4 lettres.
   Renvoie la meilleure correspondance {start, end, d} (en lettres) ou null. */
function fuzzyMatch(line, k) {
  const L = compact(line), K = compact(k); if (K.length < 4 || L.length < K.length - 1) return null;
  const tol = Math.floor(K.length / 4); let best = null;
  for (let len = K.length - 1; len <= K.length + 1; len++)
    for (let i = 0; i + len <= L.length; i++) {
      const d = lev(L.substr(i, len), K) + (len !== K.length ? 0.5 : 0);
      if (Math.floor(d) <= tol && (!best || d < best.d || (d === best.d && i < best.start))) best = { start: i, end: i + len, d };
    }
  return best;
}
const fuzzyIn = (line, k) => fuzzyMatch(line, k) ? 1 : -1;
const HEADER_JUNK = /(description|\bqt[ée]\b|montant|nontant|\btaux\b|article|divers|payer|totaux|\bprix\b|quantit|t[ée]l\b|t[ée]l\s*:|ridet|rc\s|siret|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|\d+h\d*|horaire|bienvenue|merci|www|\S@\S|\brue\b|route|bp\s?\d|bp\b|nou[mn][ée]a)/i;
function findStore(lines) {
  const head = lines.slice(0, 10).concat(lines.length > 10 ? lines.slice(-6) : []);
  const names = SHOPS.concat(S.categories.flatMap(c => (c.keywords || '').split(',').map(k => k.trim()).filter(k => k.length >= 4 && k.toLowerCase() !== 'total')));
  // 1) une enseigne connue dans l'en-tête : on garde l'enseigne bien écrite + la suite de la ligne (ex. « Champion Robinson »)
  for (const l of head) {
    if (HEADER_JUNK.test(l) || (/(total|payer|montant|carte|cb\b)/i.test(l) && /\d/.test(l))) continue;
    const hit = names.map(n => ({ n, m: fuzzyMatch(l, n) })).filter(x => x.m)
      .sort((a, b) => a.m.start - b.m.start || compact(b.n).length - compact(a.n).length)[0];
    if (hit) {
      const words = l.split(/\s+/); let acc = 0; const rest = [];
      for (const w of words) { const c = compact(w).length; if (acc >= hit.m.end && c) rest.push(w); acc += c; }
      const tail = rest.filter(w => /^[\p{L}'-]{3,}$/u.test(w) && !fuzzyMatch(w, hit.n)).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase());
      const brand = hit.n.toLowerCase().replace(/(^|\s)\p{L}/gu, c => c.toUpperCase());
      return { name: [brand, ...tail].join(' ').slice(0, 30), known: hit.n };
    }
  }
  // 2) sinon la ligne d'en-tête la plus « propre » (mots de 3 lettres ou plus), en retirant les débris de logo
  let best = null, bestScore = 0;
  head.forEach((l, i) => {
    if (i >= 10) return;
    if (HEADER_JUNK.test(l) || /\d{3,}/.test(l)) return;
    const words = l.split(/\s+/).filter(w => /^[\p{L}'&-]{3,}$/u.test(w));
    const score = words.reduce((s, w) => s + w.length, 0) - i; // un peu de bonus aux premières lignes
    if (words.length && score > bestScore) { bestScore = score; best = words.join(' '); }
  });
  return best ? { name: best.slice(0, 30) } : null;
}
function parseReceipt(text) {
  const lines = text.split(/\n/).map(l => l.trim().replace(/(?<=\d)[oO](?=[\dF\s]|$)/g, '0')).filter(Boolean); const res = {};
  // Montant : on note chaque nombre candidat (lignes TOTAL / À PAYER / CB, nombres suivis de F ou XPF)
  const prio = /(t?otal|net\s*[aà]\s*payer|[aà]\s*payer|montant|esp[eè]ces|carte|bancaire|cb\b|xpf)/i, excl = /(sous[\s-]*total|tgc|tva|taxe|hors\s*taxe|rendu|monnaie|[ée]conomi|remise|fid[ée]lit|points?|article)/i;
  const score = new Map(); const add = (n, s) => score.set(n, (score.get(n) || 0) + s);
  // Bloc des taxes (TGC / TVA / Hors Taxe) : on l'écarte, mais on s'en sert pour vérifier le total (HT + TGC = TTC)
  const taxHead = /(hors\s*taxe|\bH\.?T\.?\b|\bTGC\b|\bTVA\b|taxe)/i, totalWord = /(t?otal|[aà]\s*payer|net\s)/i;
  let taxRows = 0; const taxNums = [];
  lines.forEach(l => {
    const isTax = taxHead.test(l) && !/[aà]\s*payer/i.test(l);
    const header = isTax && parseNumbers(l).filter(n => n >= 10).length === 0; // ligne de titres de colonnes
    if (isTax) taxRows = header ? 2 : 0; else if (taxRows > 0) taxRows--;
    if (isTax || (taxRows > 0 && !prio.test(l))) { taxNums.push(...parseNumbers(l).filter(n => n >= 10)); return; }
    if (excl.test(l) || /t[ée]l|ridet/i.test(l)) return;
    const clean = l.replace(/\d{1,2}\s*[\/.-]\s*\d{1,2}\s*[\/.-]\s*\d{2,4}/g, ' ');
    const isPrio = prio.test(l), isTotal = totalWord.test(l);
    parseNumbers(clean).forEach(n => { if (isPrio && n >= 10) add(n, isTotal ? 2.5 : 1.5); });
    let m; const reF = /(\d{1,3}(?:[ . ]\d{3})+|\d+)\s*(?:F\b|F(?=\s|$)|XPF|CFP)/gi;
    while ((m = reF.exec(clean))) { const n = parseInt(m[1].replace(/[ . ]/g, ''), 10); if (n >= 10 && n < 5000000) add(n, 2); }
  });
  // Contrôle : un montant égal à HT + taxe est très probablement le total TTC
  const ht = new Set(taxNums);
  for (const a of taxNums) for (const b of taxNums) if (a > b) { const s = a + b; if (score.has(s)) add(s, 4); else if (!score.size || taxNums.length <= 4) add(s, 2.5); }
  const sums = new Set(); taxNums.forEach(a => taxNums.forEach(b => { if (a > b) sums.add(a + b); }));
  ht.forEach(n => { if (score.has(n) && !sums.has(n)) add(n, -3); }); // un montant du bloc HT/TGC n'est pas le total
  // Priorité à la ligne « TOTAL À PAYER » (ou NET À PAYER, TOTAL TTC, MONTANT DÛ) quand elle est lisible
  const payLine = /([aà]\s*pa[yv][eé]|total\s*t\.?t\.?c|montant\s*d[uû]|net\s*[aà])/i;
  lines.forEach(l => {
    if (!payLine.test(l)) return;
    const nums = parseNumbers(l.replace(/\d+\s*articles?\S*/i, ' ')).filter(n => n >= 10);
    if (nums.length) add(Math.max(...nums), 6);
  });
  if (score.size) {
    res.amount = [...score.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  } else {
    const cand = []; lines.forEach(l => { if (!/\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|t[ée]l|ridet/i.test(l)) cand.push(...parseNumbers(l)); });
    if (cand.length) res.amount = Math.max(...cand);
  }
  const dt = findDate(text); if (dt) res.date = dt;
  const st = findStore(lines); if (st) res.store = st.name;
  // Catégorie : d'abord d'après le magasin reconnu, puis d'après les mots-clés (lecture tolérante aux erreurs)
  const kw = c => (c.keywords || '').split(',').map(k => k.trim()).filter(Boolean);
  let cat = null;
  if (st) cat = S.categories.find(c => kw(c).some(k => compact(st.name).includes(compact(k)) || (st.known && compact(st.known).includes(compact(k)))));
  if (!cat) cat = S.categories.find(c => kw(c).some(k => k.toLowerCase() !== 'total' && (k.length >= 4 ? lines.some(l => fuzzyIn(l, k) >= 0) : text.toLowerCase().includes(k.toLowerCase()))));
  if (cat) res.categoryId = cat.id;
  return res;
}
const photoUrls = new Map();
async function photoUrl(id) {
  if (photoUrls.has(id)) return photoUrls.get(id);
  const p = await dbGet('photos', id); if (!p) return '';
  const u = URL.createObjectURL(p.blob); photoUrls.set(id, u); return u;
}
function loadThumbs() { document.querySelectorAll('img[data-photo]').forEach(async i => { i.src = await photoUrl(i.dataset.photo); }); }

/* ---------- Saisie d'une dépense ---------- */
let draft = null;
function expenseSheet(id) {
  const e = id ? S.expenses.find(x => x.id === id) : null;
  draft = e ? { ...e, newBlob: null } : { id: null, date: today(), amount: '', categoryId: (S.categories[0] || {}).id, note: '', photoId: null, newBlob: null };
  const chips = S.categories.map(c => `<button type="button" class="chip ${c.id === draft.categoryId ? 'on' : ''}" data-cat="${c.id}">${c.icon} ${esc(c.name)}</button>`).join('');
  sheet(`<h3>${e ? 'Modifier la dépense' : 'Nouvelle dépense'}</h3>
    <div class="photo-zone">
      <label class="btn">📷 Photo du ticket<input type="file" accept="image/*" capture="environment" hidden id="ph-cam"></label>
      <label class="btn ghost">🖼️ Galerie<input type="file" accept="image/*" hidden id="ph-gal"></label>
    </div>
    <img id="ph-prev" class="preview ${draft.photoId ? '' : 'hidden'}" alt="Photo du ticket">
    <div id="ocr" class="ocr hidden"></div>
    <form id="ef">
      <label class="f"><span>Montant (F CFP)</span><input class="amount" name="amount" inputmode="numeric" placeholder="0" value="${draft.amount}"></label>
      <label class="f"><span>Date</span><input type="date" name="date" value="${draft.date}"></label>
      <label class="f"><span>Catégorie</span></label><div class="chips" id="chips">${chips}</div>
      <label class="f"><span>Description (magasin, détail…)</span><input name="note" value="${esc(draft.note)}" placeholder="ex. Casino Johnston"></label>
      <div class="btns"><button type="submit" class="btn">Enregistrer</button><button type="button" class="btn ghost" onclick="closeSheet()">Annuler</button></div>
      ${e ? `<div class="btns">${e.photoId ? `<button type="button" class="btn ghost" id="ph-rm">Retirer la photo</button>` : ''}<button type="button" class="btn danger" id="ex-del">Supprimer</button></div>` : ''}
    </form>`);
  if (draft.photoId) photoUrl(draft.photoId).then(u => $('#ph-prev').src = u);
  $('#ph-prev').onclick = () => { if ($('#ph-prev').src) window.open($('#ph-prev').src, '_blank'); };
  $('#chips').onclick = ev => { const b = ev.target.closest('.chip'); if (!b) return; draft.categoryId = b.dataset.cat; document.querySelectorAll('#chips .chip').forEach(c => c.classList.toggle('on', c === b)); };
  ['#ph-cam', '#ph-gal'].forEach(s => $(s).onchange = ev => ev.target.files[0] && handlePhoto(ev.target.files[0]));
  const f = $('#ef');
  f.onsubmit = async ev => {
    ev.preventDefault();
    const amount = toInt(f.amount.value); if (amount <= 0) { toast('Indique un montant'); return; }
    const exp = { id: draft.id || uid(), date: f.date.value || today(), amount, categoryId: draft.categoryId, note: f.note.value.trim(), photoId: draft.photoId, created: draft.created || Date.now() };
    if (draft.newBlob) {
      if (draft.oldPhotoId) await dbDel('photos', draft.oldPhotoId);
      exp.photoId = uid(); await dbPut('photos', { id: exp.photoId, blob: draft.newBlob, driveId: null });
    } else if (draft.removePhoto && draft.oldPhotoId) await dbDel('photos', draft.oldPhotoId);
    put('expenses', exp); closeSheet();
    ui.week = mondayOf(exp.date); ui.tab = 'week'; render();
    toast(`Dépense de ${fmt(amount)} enregistrée`);
  };
  if (e) {
    $('#ex-del').onclick = async () => { if (!confirm('Supprimer cette dépense ?')) return; if (e.photoId) await dbDel('photos', e.photoId); remove('expenses', e.id); closeSheet(); render(); toast('Dépense supprimée'); };
    if ($('#ph-rm')) $('#ph-rm').onclick = () => { draft.oldPhotoId = draft.photoId; draft.photoId = null; draft.removePhoto = true; $('#ph-prev').classList.add('hidden'); $('#ph-rm').remove(); };
  }
}
async function handlePhoto(file) {
  const o = $('#ocr'); o.classList.remove('hidden'); o.textContent = 'Compression de la photo…';
  try {
    const img = await loadImg(file); const blob = await compress(img);
    if (draft.photoId && !draft.oldPhotoId) draft.oldPhotoId = draft.photoId;
    draft.newBlob = blob; draft.photoId = 'pending';
    const p = $('#ph-prev'); p.src = URL.createObjectURL(blob); p.classList.remove('hidden');
    o.textContent = `Photo optimisée : ${Math.round(file.size / 1024)} Ko → ${Math.round(blob.size / 1024)} Ko. Lecture du ticket…`;
    const kb = Math.round(blob.size / 1024);
    const text = await ocr(img, pc => { if ($('#ocr')) $('#ocr').textContent = `Photo : ${kb} Ko. Lecture du ticket… ${pc} %`; });
    const r = parseReceipt(text); const f = $('#ef'); if (!f) return;
    const found = [];
    if (r.amount) { f.amount.value = r.amount; found.push('montant ' + fmt(r.amount)); }
    if (r.date) { f.date.value = r.date; found.push('date ' + fshort(r.date)); }
    const noDate = !r.date;
    if (r.store && !f.note.value) { f.note.value = r.store; found.push('« ' + r.store + ' »'); }
    if (r.categoryId) { draft.categoryId = r.categoryId; document.querySelectorAll('#chips .chip').forEach(c => c.classList.toggle('on', c.dataset.cat === r.categoryId)); found.push(catOf(r.categoryId).name); }
    $('#ocr').innerHTML = (found.length ? `✅ Trouvé : ${esc(found.join(', '))}.${noDate ? '<br>📅 Date non trouvée sur le ticket : vérifie la date ci-dessous.' : ''}<br><b>Vérifie avant d’enregistrer.</b>` : '⚠️ Je n’ai pas réussi à lire le ticket. Saisis le montant à la main (la photo sera bien conservée).')
      + `<details style="margin-top:6px"><summary>Voir le texte lu</summary><pre style="white-space:pre-wrap;font-size:12px;margin:6px 0 0">${esc(text)}</pre></details>`;
  } catch (err) {
    console.error(err);
    if ($('#ocr')) $('#ocr').textContent = draft.newBlob ? '⚠️ Lecture automatique indisponible (connexion internet nécessaire). Saisis le montant à la main, la photo est conservée.' : '⚠️ Impossible de lire cette image.';
  }
}

/* ---------- Google Drive ---------- */
let gToken = null, gExp = 0;
const clientId = () => (S.settings.clientId || (window.BUDGET_CONFIG || {}).googleClientId || '').trim();
async function token() {
  if (!clientId()) throw new Error('Renseigne d’abord l’identifiant client Google dans Réglages (voir le guide).');
  if (gToken && Date.now() < gExp) return gToken;
  if (!window.google || !google.accounts) await loadScript('https://accounts.google.com/gsi/client');
  return new Promise((res, rej) => {
    const c = google.accounts.oauth2.initTokenClient({
      client_id: clientId(), scope: 'https://www.googleapis.com/auth/drive.file',
      callback: r => { if (r.error) return rej(new Error(r.error)); gToken = r.access_token; gExp = Date.now() + (r.expires_in - 60) * 1000; res(gToken); },
      error_callback: e => rej(new Error(e.message || e.type || 'Connexion Google annulée'))
    });
    c.requestAccessToken();
  });
}
async function gf(url, opt = {}) {
  const t = await token(); opt.headers = Object.assign({}, opt.headers, { Authorization: 'Bearer ' + t });
  const r = await fetch(url, opt); if (!r.ok) throw new Error('Google Drive : erreur ' + r.status + ' ' + (await r.text()).slice(0, 150)); return r;
}
const DAPI = 'https://www.googleapis.com/drive/v3/files', UAPI = 'https://www.googleapis.com/upload/drive/v3/files';
async function gFind(q) { const r = await gf(`${DAPI}?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`); return (await r.json()).files[0]; }
async function gFolder() {
  let f = await gFind(`name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  if (!f) f = await (await gf(`${DAPI}?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }) })).json();
  return f.id;
}
async function gUpload(meta, blob, fileId) {
  const fd = new FormData(); fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' })); fd.append('file', blob);
  const r = await gf(fileId ? `${UAPI}/${fileId}?uploadType=multipart&fields=id` : `${UAPI}?uploadType=multipart&fields=id`, { method: fileId ? 'PATCH' : 'POST', body: fd });
  return (await r.json()).id;
}
function dstat(t) { const e = $('#drive-status'); if (e) e.textContent = t; toast(t); }
async function snapshot(withPhotoData) {
  const photos = await dbAll('photos'); const data = { app: 'budget-hebdo', version: 1, exportedAt: new Date().toISOString() };
  data.settings = { ...S.settings }; LIST_STORES.forEach(s => data[s] = S[s]);
  data.photos = withPhotoData ? await Promise.all(photos.map(async p => ({ id: p.id, driveId: p.driveId, data: await blobToDataUrl(p.blob) }))) : photos.map(p => ({ id: p.id, driveId: p.driveId }));
  return data;
}
const blobToDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
async function importData(data, getPhoto) {
  if (!data || data.app !== 'budget-hebdo') throw new Error('Fichier non reconnu');
  for (const s of STORES) await dbClear(s);
  const keep = { clientId: S.settings.clientId };
  S.settings = Object.assign({ months: {} }, data.settings, keep.clientId ? keep : {}); await dbPut('settings', S.settings);
  for (const s of LIST_STORES) { S[s] = data[s] || []; for (const o of S[s]) await dbPut(s, o); }
  photoUrls.clear(); let n = 0;
  for (const p of data.photos || []) {
    try { const blob = await getPhoto(p); if (blob) await dbPut('photos', { id: p.id, blob, driveId: p.driveId || null }); } catch (e) { console.warn('photo', p.id, e); }
    n++; dstat(`Restauration des photos… ${n}/${data.photos.length}`);
  }
  invalidate();
}

/* ---------- Installation PWA ---------- */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (ui.tab === 'settings') render(); });

/* ---------- Actions ---------- */
const A = {
  week(n) { ui.week = addDays(ui.week, 7 * n); render(); },
  thisWeek() { ui.week = mondayOf(today()); render(); },
  openWeek(m) { ui.week = m; go('week'); },
  month(n) { ui.month = addMonths(ui.month, n); render(); },
  expense(id) { expenseSheet(id); },
  addIncome(ym, typeId) {
    const types = S.incomeTypes.filter(t => t.active); if (!types.length) { toast('Ajoute d’abord un type de revenu dans Réglages'); return; }
    const t0 = types.find(t => t.id === typeId) || types[0];
    const d = ym === curYm() ? today() : ym + '-01';
    form('Revenu reçu — ' + fmonth(ym), [
      { k: 'typeId', l: 'Type de revenu', t: 'select', o: types.map(t => ({ v: t.id, l: t.name })) },
      { k: 'amount', l: 'Montant reçu (F CFP)', t: 'money' },
      { k: 'date', l: 'Date de réception', t: 'date', help: 'Le montant est réparti sur les jours restants du mois à partir de cette date. Pour le salaire reçu le 25 du mois précédent, laisse le 1er du mois.' }],
      { typeId: t0.id, amount: t0.variable ? '' : t0.amount, date: t0.variable ? d : ym + '-01' },
      v => { if (v.amount <= 0) { toast('Indique un montant'); return false; } const t = S.incomeTypes.find(x => x.id === v.typeId); put('monthItems', { id: uid(), month: ym, kind: 'income', typeId: v.typeId, name: t.name, amount: v.amount, date: v.date || ym + '-01', auto: false }); toast('Revenu ajouté, semaines recalculées'); });
  },
  addCharge(ym) {
    form('Charge — ' + fmonth(ym), [{ k: 'name', l: 'Libellé', ph: 'ex. Réparation voiture' }, { k: 'amount', l: 'Montant (F CFP)', t: 'money' }], {},
      v => { if (!v.name || v.amount <= 0) { toast('Libellé et montant requis'); return false; } put('monthItems', { id: uid(), month: ym, kind: 'charge', typeId: null, name: v.name, amount: v.amount, date: ym + '-01', auto: false }); });
  },
  editItem(id) {
    const it = S.monthItems.find(i => i.id === id);
    const fields = [{ k: 'amount', l: 'Montant (F CFP)', t: 'money' }];
    if (it.kind === 'income') fields.push({ k: 'date', l: 'Date de réception', t: 'date', help: 'Réparti à partir de cette date jusqu’à la fin du mois.' });
    form(it.name + ' — ' + fmonth(it.month), fields, it,
      v => put('monthItems', { ...it, amount: v.amount, date: v.date || it.date, auto: false }),
      () => remove('monthItems', id));
  },
  incomeType(id) {
    const t = id ? S.incomeTypes.find(x => x.id === id) : { id: uid(), name: '', variable: false, amount: 0, active: true };
    form(id ? 'Modifier le revenu' : 'Nouveau type de revenu', [
      { k: 'name', l: 'Nom', ph: 'ex. Salaire' },
      { k: 'variable', l: 'Montant variable (je le saisis chaque mois à réception)', t: 'chk' },
      { k: 'amount', l: 'Montant mensuel habituel (si fixe)', t: 'money' },
      { k: 'active', l: 'Actif', t: 'chk' }], t,
      v => { if (!v.name) { toast('Nom requis'); return false; } const n = { ...t, ...v }; put('incomeTypes', n); syncType('income', n); },
      id ? () => { syncType('income', t, true); remove('incomeTypes', id); } : null);
  },
  chargeType(id) {
    const t = id ? S.chargeTypes.find(x => x.id === id) : { id: uid(), name: '', amount: 0, active: true };
    form(id ? 'Modifier la charge' : 'Nouvelle charge fixe', [
      { k: 'name', l: 'Nom', ph: 'ex. Loyer' }, { k: 'amount', l: 'Montant mensuel (F CFP)', t: 'money' }, { k: 'active', l: 'Active', t: 'chk' }], t,
      v => { if (!v.name) { toast('Nom requis'); return false; } const n = { ...t, ...v }; put('chargeTypes', n); syncType('charge', n); },
      id ? () => { syncType('charge', t, true); remove('chargeTypes', id); } : null);
  },
  category(id) {
    const c = id ? S.categories.find(x => x.id === id) : { id: uid(), name: '', icon: '🏷️', keywords: '' };
    form(id ? 'Modifier la catégorie' : 'Nouvelle catégorie', [
      { k: 'name', l: 'Nom', ph: 'ex. Courses' }, { k: 'icon', l: 'Icône (emoji)' },
      { k: 'keywords', l: 'Mots-clés pour reconnaître les tickets (séparés par des virgules)', ph: 'ex. casino,carrefour' }], c,
      v => { if (!v.name) { toast('Nom requis'); return false; } put('categories', { ...c, ...v }); },
      id ? () => { const n = S.expenses.filter(e => e.categoryId === id).length; if (n) { alert(`Impossible : ${n} dépense(s) utilisent cette catégorie. Renomme-la plutôt.`); return; } remove('categories', id); } : null);
  },
  setTheme(v) { S.settings.theme = v; saveSettings(); applyTheme(); },
  setCarry(v) { S.settings.carryOver = v; saveSettings(); },
  setStart(v) { if (!v) return; S.settings.startDate = v; saveSettings(); toast('Date de début mise à jour'); },
  setClientId(v) { S.settings.clientId = v.trim(); gToken = null; saveSettings(); toast('Identifiant enregistré'); },
  async backup() {
    try {
      dstat('Connexion à Google…');
      const folder = await gFolder();
      const photos = await dbAll('photos'); const todo = photos.filter(p => !p.driveId); let n = 0;
      for (const p of todo) { n++; dstat(`Envoi des photos… ${n}/${todo.length}`); p.driveId = await gUpload({ name: `ticket-${p.id}.jpg`, parents: [folder] }, p.blob); await dbPut('photos', p); }
      dstat('Envoi des données…');
      const blob = new Blob([JSON.stringify(await snapshot(false))], { type: 'application/json' });
      const existing = await gFind(`name='${DRIVE_DATA}' and '${folder}' in parents and trashed=false`);
      await gUpload(existing ? { name: DRIVE_DATA } : { name: DRIVE_DATA, parents: [folder] }, blob, existing && existing.id);
      const monthly = `budget-data-${curYm()}.json`; const m = await gFind(`name='${monthly}' and '${folder}' in parents and trashed=false`);
      await gUpload(m ? { name: monthly } : { name: monthly, parents: [folder] }, blob, m && m.id);
      S.settings.lastBackup = Date.now(); saveSettings(); dstat('✅ Sauvegarde terminée'); render();
    } catch (e) { console.error(e); dstat('❌ ' + e.message); }
  },
  async restore() {
    if (!confirm('Remplacer les données de ce téléphone par la sauvegarde Google Drive ?')) return;
    try {
      dstat('Connexion à Google…');
      const folder = await gFolder(); const f = await gFind(`name='${DRIVE_DATA}' and '${folder}' in parents and trashed=false`);
      if (!f) throw new Error('Aucune sauvegarde trouvée sur le Drive');
      const data = await (await gf(`${DAPI}/${f.id}?alt=media`)).json();
      await importData(data, async p => p.driveId ? await (await gf(`${DAPI}/${p.driveId}?alt=media`)).blob() : null);
      dstat('✅ Restauration terminée'); render();
    } catch (e) { console.error(e); dstat('❌ ' + e.message); }
  },
  async exportFile() {
    toast('Préparation du fichier…');
    const data = await snapshot(true); const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })); a.download = `budget-hebdo-${today()}.json`; a.click();
  },
  async importFile(file) {
    if (!file || !confirm('Remplacer les données de ce téléphone par ce fichier ?')) return;
    try { const data = JSON.parse(await file.text()); await importData(data, async p => p.data ? await (await fetch(p.data)).blob() : null); toast('✅ Import terminé'); render(); }
    catch (e) { alert('Import impossible : ' + e.message); }
  },
  async checkUpdate() {
    toast('Recherche d’une mise à jour…');
    try {
      const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update();
      const res = await fetch('app.js', { cache: 'no-store' }); const txt = await res.text();
      const v = (txt.match(/APP_VERSION = '([\d.]+)'/) || [])[1];
      if (v && v !== APP_VERSION) { toast('Nouvelle version ' + v + ', redémarrage…'); setTimeout(() => location.reload(), 1200); }
      else toast('Tu as déjà la dernière version (v' + APP_VERSION + ')');
    } catch { toast('Pas de connexion internet'); }
  },
  async install() { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; render(); }
};
window.A = A; window.go = go; window.closeSheet = closeSheet;

/* ---------- Thème ---------- */
function applyTheme() {
  const t = (S.settings && S.settings.theme) || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
}

/* ---------- Démarrage ---------- */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => go(b.dataset.tab));
$('#fab').onclick = () => A.expense();
(async function start() {
  db = await openDB();
  S.settings = await dbGet('settings', 'main');
  if (!S.settings) defaults();
  else for (const s of LIST_STORES) S[s] = await dbAll(s);
  S.settings.months = S.settings.months || {};
  applyTheme();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
    // Quand une nouvelle version s'installe, on recharge une fois pour l'afficher
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  }
  render();
})();
