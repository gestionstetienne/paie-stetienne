// ============================================================
//  Rappels automatiques — Clinique St-Étienne
//  Exécuté par un cron Vercel (voir vercel.json).
//  Envoie un courriel aux employées qui ont des journées
//  sans heures ni statut, la veille de l'envoi de la paie
//  (dimanche 18h, heure de Toronto).
//
//  Variables d'environnement requises (Vercel > Settings > Environment Variables) :
//    RESEND_API_KEY  clé Resend (jamais dans le code!)
//    CRON_SECRET     mot de passe long et aléatoire (protège la fonction)
//    RESEND_FROM     ex: Clinique St-Étienne <paie@cliniquestetienne.com>
//  Optionnelles :
//    SUPABASE_URL, SUPABASE_KEY (par défaut : celles de l'application)
// ============================================================

const TZ = 'America/Toronto';
const APP_URL = 'https://paie-stetienne.vercel.app';
const DAYS_FR = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
const MONTHS_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const DAY_MS = 86400000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jurtntqtitbefdvyetyz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1cnRudHF0aXRiZWZkdnlldHl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNjk2MDUsImV4cCI6MjA5MzY0NTYwNX0.Lt2HlYD5VyfB6aM_T5IpoFAWwB4r62Q2ZQ8PKxMJlIY';

// ── Heure locale de Toronto ──
function torontoNow(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const g = t => parseInt(parts.find(p => p.type === t).value, 10);
  return { y: g('year'), m: g('month'), d: g('day'), hour: g('hour') };
}

// ── Période dont l'envoi (lundi 15h) a lieu demain, sinon null ──
function periodSentTomorrow(local, anchorStr) {
  const [ay, am, ad] = anchorStr.split('-').map(Number);
  const anchorUTC = Date.UTC(ay, am - 1, ad);
  const tomorrowUTC = Date.UTC(local.y, local.m - 1, local.d) + DAY_MS;
  const diffDays = Math.round((tomorrowUTC - anchorUTC) / DAY_MS);
  if (diffDays <= 0 || diffDays % 14 !== 0) return null;
  return { index: diffDays / 14 - 1, anchorUTC };
}

// Date (UTC minuit) de la journée i (0..9) de la période idx
function dayDate(anchorUTC, idx, i) {
  const offset = i < 5 ? i : 7 + (i - 5);
  return new Date(anchorUTC + idx * 14 * DAY_MS + offset * DAY_MS);
}

function dayLabel(anchorUTC, idx, i) {
  const dt = dayDate(anchorUTC, idx, i);
  return `${DAYS_FR[i % 5]} ${dt.getUTCDate()} ${MONTHS_FR[dt.getUTCMonth()]}`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildHtml(empName, periodStr, missingLabels) {
  const items = missingLabels.map(l => `<li>${esc(l)}</li>`).join('');
  return `
<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
  <div style="background:#1C3557;padding:20px 24px;border-radius:12px 12px 0 0">
    <h1 style="color:#fff;margin:0;font-size:20px">🦷 Clinique St-Étienne</h1>
    <p style="color:rgba(255,255,255,.7);margin:4px 0 0;font-size:13px">Feuille de temps — Rappel</p>
  </div>
  <div style="background:#F5F7FC;padding:24px;border-radius:0 0 12px 12px;border:1px solid #D8E1EF">
    <p style="font-size:15px;color:#1A2340">Bonjour <strong>${esc(empName)}</strong>,</p>
    <p style="font-size:14px;color:#1A2340;margin:12px 0">
      La période <strong>${esc(periodStr)}</strong> sera verrouillée <strong>demain à 15h00</strong>.
    </p>
    <div style="background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;padding:12px 16px;margin:16px 0">
      <p style="font-size:13px;color:#92400E;margin:0 0 6px">
        ⚠ Il manque des heures (ou un statut) pour ${missingLabels.length} journée(s) :
      </p>
      <ul style="font-size:13px;color:#92400E;margin:0;padding-left:20px">${items}</ul>
    </div>
    <a href="${APP_URL}"
       style="display:inline-block;background:#1C3557;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;margin:8px 0">
      Accéder à la feuille de temps →
    </a>
    <p style="font-size:12px;color:#6B7A99;margin-top:16px">
      Après 15h00 demain, la période sera verrouillée et vous ne pourrez plus modifier vos heures.
    </p>
  </div>
</div>`;
}

async function run({ now = new Date(), fetchImpl = fetch, env = process.env, dry = false, force = false } = {}) {
  const sb = async (path) => {
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    return r.json();
  };

  // 1) Quelle période? (la veille de son envoi) et est-ce 18h à Toronto?
  const local = torontoNow(now);
  let anchorStr = '2026-05-04';
  try {
    const a = await sb('app_settings?key=eq.anchorDate&select=value');
    if (a && a[0] && a[0].value) anchorStr = a[0].value;
  } catch (e) { /* on garde la valeur par défaut */ }

  const period = periodSentTomorrow(local, anchorStr);
  if (!force) {
    if (!period) return { status: 'skip', reason: 'Demain n\'est pas un jour d\'envoi.' };
    if (local.hour !== 18) return { status: 'skip', reason: `Il est ${local.hour}h à Toronto (envoi à 18h seulement).` };
  }
  if (!period) return { status: 'skip', reason: 'Aucune période à rappeler.' };
  const { index: idx, anchorUTC } = period;

  // 2) Déjà envoyée? Alors rien à rappeler.
  const sent = await sb(`periodes_envoyees?periode_index=eq.${idx}&select=periode_index`);
  if (sent.length > 0 && !force) return { status: 'skip', reason: `Période ${idx + 1} déjà envoyée.` };

  // 3) Courriels connus + saisies de la période (paginées)
  const emails = await sb('employe_emails?select=emp_name,email');
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sb(
      `saisies?periode_index=eq.${idx}&select=emp_name,day_index,seg_index,entree,sortie,dentist,day_status` +
      `&order=emp_name,day_index,seg_index&limit=1000&offset=${offset}`
    );
    rows.push(...page);
    if (page.length < 1000) break;
  }

  // 4) Une journée est complète si statut choisi OU au moins un segment complet
  const doneByEmp = {};
  rows.forEach(r => {
    const ok = (r.seg_index === 99 && r.day_status) || (r.entree && r.sortie && r.dentist);
    if (!ok) return;
    (doneByEmp[r.emp_name] = doneByEmp[r.emp_name] || new Set()).add(r.day_index);
  });

  const start = dayDate(anchorUTC, idx, 0);
  const end = dayDate(anchorUTC, idx, 9);
  const periodStr = `${start.getUTCDate()} ${MONTHS_FR[start.getUTCMonth()]} au ${end.getUTCDate()} ${MONTHS_FR[end.getUTCMonth()]} ${end.getUTCFullYear()}`;

  const messages = [];
  const summary = [];
  emails.forEach(e => {
    if (!e.email || /2e soir/i.test(e.emp_name)) return;
    const done = doneByEmp[e.emp_name] || new Set();
    const missing = [];
    for (let i = 0; i < 10; i++) if (!done.has(i)) missing.push(dayLabel(anchorUTC, idx, i));
    if (!missing.length) return;
    summary.push({ nom: e.emp_name, manquantes: missing.length });
    messages.push({
      from: env.RESEND_FROM || 'Clinique St-Étienne <onboarding@resend.dev>',
      to: [e.email],
      subject: `Rappel — Saisie des heures avant demain 15h (${periodStr})`,
      html: buildHtml(e.emp_name, periodStr, missing)
    });
  });

  if (dry) return { status: 'dry', periode: idx + 1, destinataires: summary };
  if (!messages.length) return { status: 'ok', periode: idx + 1, envoyes: 0, note: 'Tout le monde est complet.' };
  if (!env.RESEND_API_KEY) return { status: 'error', error: 'RESEND_API_KEY manquante.' };

  // 5) Envoi en lot (jusqu'à 100 par appel)
  let envoyes = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const r = await fetchImpl('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk)
    });
    if (!r.ok) return { status: 'error', error: `Resend ${r.status}: ${await r.text()}`, envoyes };
    envoyes += chunk.length;
  }
  return { status: 'ok', periode: idx + 1, envoyes, destinataires: summary };
}

async function sendTest(to, fetchImpl = fetch, env = process.env) {
  if (!env.RESEND_API_KEY) return { status: 'error', error: 'RESEND_API_KEY manquante.' };
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'Clinique St-Étienne <onboarding@resend.dev>',
      to: [to],
      subject: 'Test — rappels Clinique St-Étienne',
      html: buildHtml('Test', 'de démonstration', ['Lundi 1 janv.', 'Mardi 2 janv.'])
    })
  });
  return r.ok ? { status: 'ok', note: `Courriel de test envoyé à ${to}.` }
              : { status: 'error', error: `Resend ${r.status}: ${await r.text()}` };
}

// ── Point d'entrée Vercel ──
module.exports = async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers['authorization'] || '';
    const key = (req.query && req.query.key) || '';
    if (!secret || (auth !== `Bearer ${secret}` && key !== secret)) {
      return res.status(401).json({ error: 'Non autorisé.' });
    }
    const q = req.query || {};
    if (q.test === '1' && q.to) return res.status(200).json(await sendTest(String(q.to)));
    const result = await run({ dry: q.dry === '1', force: q.force === '1' });
    return res.status(result.status === 'error' ? 500 : 200).json(result);
  } catch (e) {
    console.error('send-reminders error:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
};

module.exports.run = run;
module.exports.periodSentTomorrow = periodSentTomorrow;
module.exports.torontoNow = torontoNow;
