// 가나안ERP v024 · 이름 + 숫자 4자리 로그인 서버 + 가나안요청 연동 (Cloudflare Worker)
// 웹 파일(public/)은 그대로 보여주고, /api/* 만 여기서 처리합니다.
//
// Cloudflare 대시보드 > canaan-erp > Settings > Variables and Secrets 에 넣을 Secret 3개:
//   SUPABASE_SERVICE_KEY : Supabase 새 DB의 secret 키 (sb_secret_...)  ※ 절대 저장소·채팅에 올리지 않기
//   PIN_SECRET           : 아무 긴 글자 (40자 이상 권장). 바꾸면 모든 PIN을 다시 정해야 함
//   SETUP_CODE           : 첫 관리자 만들 때 한 번 입력하는 암호 (아무 단어)
//   REQ_SUPABASE_KEY     : (v024) 가나안요청 Supabase의 secret 키. 가나안요청은 읽기만 합니다.
// SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY 는 wrangler.jsonc 의 vars 에 있습니다 (공개용).

const LOCK_TRIES = 5;          // 연속으로 틀리면 잠김
const LOCK_MINUTES = 10;       // 잠김 시간
const ROLES = ['관리자', '사용자'];
const SITES = ['세원', '대한전선'];
const enc = new TextEncoder();

class ApiError extends Error { constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; } }
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

export function cleanName(v) {
  if (typeof v !== 'string') return null;
  const n = v.normalize('NFC').trim().replace(/\s+/g, ' ');
  return !n || n.length > 30 || /[\u0000-\u001f\u007f@<>]/.test(n) ? null : n;
}
export const validPin = p => typeof p === 'string' && /^\d{4}$/.test(p);
export async function loginEmail(name) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode('canaan-erp-id-v1:' + name.toLowerCase()))).slice(0, 40) + '@login.canaan-erp.invalid';
}
export async function pinPassword(env, name, pin) {
  if (!env.PIN_SECRET || env.PIN_SECRET.length < 16) throw new ApiError('로그인 서버 설정(PIN_SECRET)을 확인해주세요.', 503);
  const key = await crypto.subtle.importKey('raw', enc.encode(env.PIN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // Supabase 비밀번호 최대 72글자 → 'Ep!' + 64 = 67글자
  return 'Ep!' + hex(await crypto.subtle.sign('HMAC', key, enc.encode('canaan-erp-pin-v1:' + name.toLowerCase() + ':' + pin)));
}

function configured(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_SERVICE_KEY) throw new ApiError('로그인 서버 설정(Supabase 키)을 확인해주세요.', 503);
}
async function sb(env, path, { method = 'GET', body, service = true, token, headers = {} } = {}) {
  const key = service ? env.SUPABASE_SERVICE_KEY : env.SUPABASE_PUBLISHABLE_KEY;
  const h = { apikey: key, 'content-type': 'application/json', ...headers };
  // supabase-js 와 같은 방식: 사용자 토큰이 없으면 Authorization 에도 apikey 와 똑같은 키를 넣음
  // (Auth 관리자 API는 Authorization 이 없으면 'requires a valid Bearer token' 으로 거절함)
  h.authorization = 'Bearer ' + (token || key);
  const r = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; const text = await r.text(); try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}
const upMsg = d => d && typeof d === 'object' ? String(d.msg || d.message || d.error_description || d.error || '').slice(0, 120) : '';
async function must(p, msg) { const r = await p; if (!r.ok) throw new ApiError(msg + ' (' + r.status + ')', r.status >= 500 ? 502 : 500, { detail: r.data }); return r.data; }
async function readJson(req) {
  if ((req.headers.get('content-length') | 0) > 16384) throw new ApiError('요청이 너무 큽니다.', 413);
  try { const b = await req.json(); if (b && typeof b === 'object' && !Array.isArray(b)) return b; } catch {}
  throw new ApiError('요청 형식이 잘못되었습니다.');
}
const q = v => encodeURIComponent(v);
async function accountByName(env, name) {
  const rows = await must(sb(env, '/rest/v1/erp_accounts?select=*&name=eq.' + q(name)), '계정 조회 실패');
  return rows[0] || null;
}
async function countAccounts(env) {
  const r = await sb(env, '/rest/v1/erp_accounts?select=id', { headers: { prefer: 'count=exact', range: '0-0' } });
  if (!r.ok) throw new ApiError('계정 표(erp_accounts)가 없습니다. v007 SQL을 먼저 실행하세요.', 503);
  return r.data.length; // 0이면 비어 있음
}

// 로그인한 사람(요청의 토큰)이 관리자인지 확인
async function requireAdmin(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new ApiError('로그인이 필요합니다.', 401);
  const u = await sb(env, '/auth/v1/user', { service: false, token });
  if (!u.ok || !u.data?.id) throw new ApiError('로그인이 만료되었습니다. 다시 로그인해주세요.', 401);
  const rows = await must(sb(env, '/rest/v1/erp_accounts?select=*&id=eq.' + q(u.data.id)), '계정 조회 실패');
  const me = rows[0];
  if (!me || !me.active || me.role !== '관리자') throw new ApiError('admin만 할 수 있습니다.', 403);
  return me;
}

async function setSite(env, userId, site) {
  await must(sb(env, '/rest/v1/erp_user_access?user_id=eq.' + q(userId), { method: 'DELETE' }), '회사 설정 실패');
  if (site) await must(sb(env, '/rest/v1/erp_user_access', { method: 'POST', body: { user_id: userId, allowed_site: site } }), '회사 설정 실패');
}

async function createAccount(env, { name, pin, role, site, createdBy }) {
  name = cleanName(name);
  if (!name) throw new ApiError('이름을 확인해주세요. (30자 이내)');
  if (!validPin(pin)) throw new ApiError('비밀번호는 숫자 4자리입니다.');
  if (!ROLES.includes(role)) role = '사용자';
  if (site && !SITES.includes(site)) throw new ApiError('회사 값이 잘못되었습니다.');
  if (await accountByName(env, name)) throw new ApiError('같은 이름의 계정이 이미 있습니다. 이름 뒤에 숫자 등을 붙여주세요.', 409);
  const created = await sb(env, '/auth/v1/admin/users', { method: 'POST', body: { email: await loginEmail(name), password: await pinPassword(env, name, pin), email_confirm: true, user_metadata: { name } } });
  if (!created.ok || !created.data?.id) throw new ApiError('계정을 만들지 못했습니다. (' + created.status + (upMsg(created.data) ? ' · ' + upMsg(created.data) : '') + ')', 502);
  const id = created.data.id;
  const ins = await sb(env, '/rest/v1/erp_accounts', { method: 'POST', body: { id, name, role, created_by: createdBy || null } });
  if (!ins.ok) { await sb(env, '/auth/v1/admin/users/' + id, { method: 'DELETE' }); throw new ApiError('계정 저장 실패 (' + ins.status + ')', 502, { detail: ins.data }); }
  if (site) await setSite(env, id, site);
  return { id, name, role, site: site || null };
}

async function login(env, body) {
  const name = cleanName(body.name), pin = body.pin;
  if (!name || !validPin(pin)) throw new ApiError('이름과 숫자 4자리를 확인해주세요.');
  const acc = await accountByName(env, name);
  const fail = () => new ApiError('이름 또는 비밀번호가 맞지 않습니다.', 401);
  if (!acc) throw fail();
  if (!acc.active) throw new ApiError('사용 중지된 계정입니다. admin에게 문의하세요.', 403);
  const now = Date.now();
  if (acc.locked_until && Date.parse(acc.locked_until) > now) {
    const min = Math.ceil((Date.parse(acc.locked_until) - now) / 60000);
    throw new ApiError(`${LOCK_TRIES}번 틀려서 잠겼습니다. ${min}분 뒤에 다시 해주세요.`, 423);
  }
  const t = await sb(env, '/auth/v1/token?grant_type=password', { method: 'POST', service: false, body: { email: await loginEmail(name), password: await pinPassword(env, name, pin) } });
  if (!t.ok || !t.data?.access_token) {
    if (t.status === 429) throw new ApiError('요청이 많습니다. 잠시 후 다시 해주세요.', 429);
    if (t.status >= 500) throw new ApiError('로그인 서버 연결이 늦습니다. 잠시 후 다시 해주세요.', 502);
    const tries = (acc.fail_count || 0) + 1;
    const patch = tries >= LOCK_TRIES ? { fail_count: 0, locked_until: new Date(now + LOCK_MINUTES * 60000).toISOString() } : { fail_count: tries };
    await sb(env, '/rest/v1/erp_accounts?id=eq.' + q(acc.id), { method: 'PATCH', body: patch });
    if (tries >= LOCK_TRIES) throw new ApiError(`${LOCK_TRIES}번 틀려서 ${LOCK_MINUTES}분 동안 잠겼습니다.`, 423);
    throw new ApiError(`이름 또는 비밀번호가 맞지 않습니다. (${LOCK_TRIES - tries}번 남음)`, 401);
  }
  await sb(env, '/rest/v1/erp_accounts?id=eq.' + q(acc.id), { method: 'PATCH', body: { fail_count: 0, locked_until: null, last_login_at: new Date(now).toISOString() } });
  return { access_token: t.data.access_token, refresh_token: t.data.refresh_token, name: acc.name, role: acc.role };
}

export async function handleApi(req, env, path) {
  configured(env);
  if (path === '/api/status' && req.method === 'GET') return json({ needs_setup: (await countAccounts(env)) === 0, setup_ready: !!env.SETUP_CODE });
  if (req.method !== 'POST' && !(path === '/api/accounts' && req.method === 'GET')) throw new ApiError('지원하지 않는 요청입니다.', 405);

  if (path === '/api/login') return json(await login(env, await readJson(req)));

  if (path === '/api/setup') {
    const b = await readJson(req);
    if (!env.SETUP_CODE) throw new ApiError('Cloudflare에 SETUP_CODE가 없습니다.', 503);
    if (typeof b.setup_code !== 'string' || b.setup_code !== env.SETUP_CODE) throw new ApiError('설치 암호가 맞지 않습니다.', 403);
    if ((await countAccounts(env)) !== 0) throw new ApiError('이미 admin 계정이 있습니다.', 409);
    return json(await createAccount(env, { name: b.name, pin: b.pin, role: '관리자', site: null }));
  }

  const me = await requireAdmin(req, env);
  if (path === '/api/accounts' && req.method === 'GET') {
    const accs = await must(sb(env, '/rest/v1/erp_accounts?select=id,name,role,active,locked_until,last_login_at,created_at&order=created_at'), '계정 목록 실패');
    const sites = await must(sb(env, '/rest/v1/erp_user_access?select=user_id,allowed_site'), '회사 설정 조회 실패');
    const m = new Map(sites.map(s => [s.user_id, s.allowed_site]));
    return json(accs.map(a => ({ ...a, site: m.get(a.id) || null, me: a.id === me.id })));
  }
  const b = await readJson(req);
  if (path.startsWith('/api/link/')) return json(await handleLink(env, path, b));
  if (path === '/api/accounts') return json(await createAccount(env, { name: b.name, pin: b.pin, role: b.role, site: b.site || null, createdBy: me.id }));

  const rows = await must(sb(env, '/rest/v1/erp_accounts?select=*&id=eq.' + q(String(b.id || ''))), '계정 조회 실패');
  const acc = rows[0]; if (!acc) throw new ApiError('계정을 찾을 수 없습니다.', 404);
  const otherAdmins = async () => (await must(sb(env, '/rest/v1/erp_accounts?select=id&role=eq.' + q('관리자') + '&active=eq.true&id=neq.' + q(acc.id)), '조회 실패')).length;

  if (path === '/api/accounts/pin') {
    if (!validPin(b.pin)) throw new ApiError('비밀번호는 숫자 4자리입니다.');
    await must(sb(env, '/auth/v1/admin/users/' + acc.id, { method: 'PUT', body: { password: await pinPassword(env, acc.name, b.pin) } }), 'PIN 변경 실패');
    await sb(env, '/rest/v1/erp_accounts?id=eq.' + q(acc.id), { method: 'PATCH', body: { fail_count: 0, locked_until: null } });
    return json({ ok: true });
  }
  if (path === '/api/accounts/active') {
    const active = !!b.active;
    if (!active && acc.role === '관리자' && (await otherAdmins()) === 0) throw new ApiError('마지막 admin은 사용 중지할 수 없습니다.');
    await must(sb(env, '/auth/v1/admin/users/' + acc.id, { method: 'PUT', body: { ban_duration: active ? 'none' : '876000h' } }), '상태 변경 실패');
    await must(sb(env, '/rest/v1/erp_accounts?id=eq.' + q(acc.id), { method: 'PATCH', body: { active, fail_count: 0, locked_until: null } }), '상태 변경 실패');
    return json({ ok: true });
  }
  if (path === '/api/accounts/role') {
    if (!ROLES.includes(b.role)) throw new ApiError('권한 값이 잘못되었습니다.');
    if (b.role !== '관리자' && acc.role === '관리자' && (await otherAdmins()) === 0) throw new ApiError('마지막 admin의 권한은 바꿀 수 없습니다.');
    await must(sb(env, '/rest/v1/erp_accounts?id=eq.' + q(acc.id), { method: 'PATCH', body: { role: b.role } }), '권한 변경 실패');
    return json({ ok: true });
  }
  if (path === '/api/accounts/site') {
    if (b.site && !SITES.includes(b.site)) throw new ApiError('회사 값이 잘못되었습니다.');
    await setSite(env, acc.id, b.site || null);
    return json({ ok: true });
  }
  throw new ApiError('없는 요청입니다.', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        const origin = req.headers.get('origin');
        if (req.method !== 'GET' && origin && origin !== url.origin) throw new ApiError('허용되지 않은 요청 출처입니다.', 403);
        return await handleApi(req, env, url.pathname);
      } catch (e) {
        if (e instanceof ApiError) return json({ message: e.message }, e.status);
        console.error(e);
        return json({ message: '서버 오류가 났습니다. 잠시 후 다시 해주세요.' }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
  // v024: 10분마다 가나안요청 기록 가져오기 (wrangler.jsonc triggers.crons)
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { try { configured(env); if (env.REQ_SUPABASE_KEY) await runLink(env, '자동'); } catch (e) { console.error('가나안요청 연동 실패', e && e.message); } })());
  }
};

// ───────────────────────── v024 · 가나안요청 연동 ─────────────────────────
// 가나안요청(별도 Supabase)의 물품 지급·연차 승인을 읽어서 ERP 피복 현황·달력(연차)에 넣습니다.
// 가나안요청 DB는 읽기(GET)만 합니다. 아무것도 바꾸지 않습니다.
// Cloudflare 에 넣을 것: vars REQ_SUPABASE_URL (wrangler.jsonc), Secret REQ_SUPABASE_KEY (가나안요청 sb_secret 키)
const LINK_SOURCE = '가나안요청';
// 가나안요청 품목 묶음(item_group) → ERP 피복 14품목. 띄어쓰기는 무시하고 비교합니다.
export const LINK_ITEM_MAP = {
  '상의(여름반팔)': '여름상의', '하의(여름바지)': '여름하의', '하의(춘추복)': '춘추하의', '하의(겨울바지)': '겨울하의',
  '상의(조끼)': '조끼', '상의(바람막이)': '바람막이', '겨울후리스': '후리스', '후리스': '후리스', '상의(패딩)': '패딩',
  '안전화': '안전화', '안전장화': '안전장화', '장화': '장화', '안전방화': '안전방화', '안전모': '안전모', '우비': '우비'
};
const LEAVE_TYPES = ['연차', '오전 반차', '오후 반차'];
export const nameKey = v => String(v || '').normalize('NFC').replace(/\s+/g, '');
export const linkItem = g => LINK_ITEM_MAP[nameKey(g)] || null;
const ymd = d => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10); // 한국 날짜
const mmdd = s => s ? s.slice(5) : '';
export function leaveDays(a) {
  if (a.application_type !== '연차') return 0.5;
  const n = Number(a.leave_days);
  if (n > 0) return Math.min(n, 31);
  const s = Date.parse(a.start_date), e = Date.parse(a.end_date || a.start_date);
  return Math.min(31, Math.max(1, Math.round((e - s) / 864e5) + 1));
}

async function req(env, path) {
  if (!env.REQ_SUPABASE_URL || !env.REQ_SUPABASE_KEY) throw new ApiError('가나안요청 연결 설정(REQ_SUPABASE_KEY)이 아직 없습니다. 넣는 순서 3번을 해주세요.', 503);
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(env.REQ_SUPABASE_URL.replace(/\/$/, '') + path, { headers: { apikey: env.REQ_SUPABASE_KEY, authorization: 'Bearer ' + env.REQ_SUPABASE_KEY, range: `${from}-${from + 999}` } });
    if (!r.ok) throw new ApiError('가나안요청 읽기 실패 (' + r.status + ')', 502);
    const rows = await r.json(); out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// 이름 → ERP 직원 짝짓기. 관리자가 고른 짝이 먼저, 그다음 재직 중 같은 이름이 한 명일 때만.
export function matchPerson(name, emps, nameMap, onDate) {
  const k = nameKey(name);
  if (!k) return { reason: '이름 없음' };
  if (nameMap.has(k)) return { emp: emps.find(e => e.id === nameMap.get(k)) || null, reason: nameMap.get(k) && !emps.find(e => e.id === nameMap.get(k)) ? '고른 직원이 없어짐' : '' };
  const same = emps.filter(e => nameKey(e.name) === k);
  const day = onDate || ymd(new Date());
  const working = same.filter(e => e.employment_status !== '퇴사' && (!e.termination_date || e.termination_date >= day));
  const pick = working.length ? working : same;
  if (pick.length === 1) return { emp: pick[0], reason: '' };
  if (!pick.length) return { reason: 'ERP에 없음' };
  return { reason: `같은 이름 ${pick.length}명` };
}

// Cloudflare 무료 요금제는 한 번에 외부 호출 50번까지라서, 미리 한 번에 읽고 → 메모리에서 정하고 → 한 번에 씁니다.
const REC_KEYS = ['kind', 'source_id', 'source_date', 'person', 'content', 'item', 'size', 'leave_type', 'start_date', 'end_date', 'leave_days', 'employee_id', 'result', 'reason', 'erp_event_id'];
const uKeyOf = (e, i) => e + '|' + i;
const cKeyOf = (e, d) => e + '|' + d;

// 작업 묶음: 피복 칸 저장, 달력 새로 만들기, 연동 기록 저장
function newPlan(uni, cal) { return { uni, cal, uniPut: new Map(), calAdd: [], recs: [] }; }

// 피복: 더 최근 지급 기록이 이미 있으면 그대로 둠
function decideUniform(plan, rec, emp) {
  const k = uKeyOf(emp.id, rec.item), cur = plan.uni.get(k);
  if (cur && cur.status === '지급' && cur.issued_on && cur.issued_on > rec.source_date) return { result: '이미있음', reason: `ERP에 더 최근 지급(${cur.issued_on})이 있음` };
  if (cur && cur.status === '지급' && cur.issued_on === rec.source_date && (!rec.size || cur.size === rec.size)) return { result: '이미있음', reason: 'ERP에 같은 날 지급이 이미 있음' };
  const row = { employee_id: emp.id, item: rec.item, status: '지급', issued_on: rec.source_date, size: rec.size || cur?.size || null, source: LINK_SOURCE, note: `${LINK_SOURCE} ${mmdd(rec.source_date)} 지급` };
  const reason = cur && cur.status !== '지급' ? `${cur.status}→지급` : '';
  plan.uni.set(k, row); plan.uniPut.set(k, row);
  return { result: '반영', reason };
}
// 연차: 같은 사람·같은 시작일 연차가 이미 있으면 새로 안 만들고 짝만 지음
function decideLeave(plan, rec, emp) {
  const k = cKeyOf(emp.id, rec.start_date), ex = plan.cal.get(k);
  if (ex) return { result: '이미있음', reason: ex.id ? 'ERP 달력에 같은 날 연차가 이미 있음' : '같은 날 다른 가나안요청 연차와 겹침', erp_event_id: ex.id || null };
  const row = { site: emp.site || '세원', event_type: '연차', title: `${emp.name} ${rec.leave_type}`, start_date: rec.start_date, end_date: rec.end_date && rec.end_date !== rec.start_date ? rec.end_date : null, employee_id: emp.id, leave_days: rec.leave_days, memo: `${LINK_SOURCE} 승인 #${rec.source_id}` };
  plan.cal.set(k, { id: null }); plan.calAdd.push({ row, rec });
  return { result: '반영', reason: '', erp_event_id: null };
}
const decide = (plan, rec, emp) => rec.kind === '피복' ? decideUniform(plan, rec, emp) : decideLeave(plan, rec, emp);

async function loadPlan(env, empId) {
  const f = empId ? '&employee_id=eq.' + q(empId) : '';
  const [u, c] = await Promise.all([
    must(sb(env, '/rest/v1/erp_uniform_items?select=employee_id,item,status,size,issued_on' + f), '피복 조회 실패'),
    must(sb(env, '/rest/v1/sewon_calendar_events?select=id,employee_id,start_date&event_type=eq.' + q('연차') + '&employee_id=not.is.null' + f), '달력 조회 실패')
  ]);
  return newPlan(new Map(u.map(r => [uKeyOf(r.employee_id, r.item), r])), new Map(c.map(r => [cKeyOf(r.employee_id, r.start_date), r])));
}
async function commitPlan(env, plan) {
  if (plan.uniPut.size) await must(sb(env, '/rest/v1/erp_uniform_items?on_conflict=employee_id,item', { method: 'POST', body: [...plan.uniPut.values()], headers: { prefer: 'resolution=merge-duplicates,return=minimal' } }), '피복 저장 실패');
  if (plan.calAdd.length) {
    const made = await must(sb(env, '/rest/v1/sewon_calendar_events', { method: 'POST', body: plan.calAdd.map(x => x.row), headers: { prefer: 'return=representation' } }), '달력 저장 실패');
    plan.calAdd.forEach((x, i) => { x.rec.erp_event_id = made[i]?.id || null; });
  }
  if (plan.recs.length) {
    const now = new Date().toISOString();
    const body = plan.recs.map(r => { const o = { source: LINK_SOURCE, updated_at: now }; REC_KEYS.forEach(k => { o[k] = r[k] ?? null; }); return o; });
    await must(sb(env, '/rest/v1/erp_link_records?on_conflict=source,kind,source_id', { method: 'POST', body, headers: { prefer: 'resolution=merge-duplicates,return=minimal' } }), '연동 기록 저장 실패');
  }
}

export async function runLink(env, who = '자동') {
  const st = (await must(sb(env, '/rest/v1/erp_link_state?select=*&id=eq.1'), '연동 표가 없습니다. v024 SQL을 먼저 실행하세요.'))[0];
  if (!st) throw new ApiError('연동 표가 없습니다. v024 SQL을 먼저 실행하세요.', 503);
  if (st.running_until && Date.parse(st.running_until) > Date.now()) return { skipped: true, message: '다른 가져오기가 진행 중입니다. 잠시 후 다시 눌러주세요.' };
  await sb(env, '/rest/v1/erp_link_state?id=eq.1', { method: 'PATCH', body: { running_until: new Date(Date.now() + 120e3).toISOString() } });
  const sum = { 새기록: 0, 반영: 0, 확인필요: 0, 이미있음: 0, 넘김: 0, 취소됨: 0 };
  try {
    const [items, moves, apps] = await Promise.all([
      req(env, '/rest/v1/supply_items?select=id,name,item_group,size&order=id'),
      req(env, '/rest/v1/supply_moves?select=id,item_id,quantity,person,moved_on,deleted_at&move_type=eq.' + q('지급') + '&order=id'),
      req(env, '/rest/v1/work_applications?select=id,worker_name,application_type,start_date,end_date,leave_days,status,is_deleted&application_type=in.(' + LEAVE_TYPES.map(t => '"' + t + '"').join(',') + ')&order=id')
    ]);
    const [emps, maps, existing] = await Promise.all([
      must(sb(env, '/rest/v1/sewon_employees?select=id,name,site,department,employment_status,termination_date'), '직원 조회 실패'),
      must(sb(env, '/rest/v1/erp_link_name_map?select=source_name,employee_id&source=eq.' + q(LINK_SOURCE)), '이름 짝 조회 실패'),
      must(sb(env, '/rest/v1/erp_link_records?select=*&source=eq.' + q(LINK_SOURCE)), '연동 기록 조회 실패')
    ]);
    const nameMap = new Map(maps.map(m => [nameKey(m.source_name), m.employee_id]));
    const plan = await loadPlan(env);
    const have = new Map(existing.map(r => [r.kind + ':' + r.source_id, r]));
    const itemById = new Map(items.map(i => [i.id, i]));

    const handle = async (rec, cancelled, cancelWhy) => {
      const old = have.get(rec.kind + ':' + rec.source_id);
      if (old) {
        if (cancelled) {
          if (['반영', '이미있음'].includes(old.result)) { plan.recs.push({ ...old, result: '취소됨', reason: cancelWhy + ' · ERP 기록은 그대로 두었으니 직접 확인해주세요' }); sum.취소됨++; }
          else if (old.result === '확인필요') { plan.recs.push({ ...old, result: '넘김', reason: cancelWhy }); sum.넘김++; }
          return;
        }
        if (old.result !== '확인필요') return; // 이미 처리된 건은 다시 건드리지 않음
        rec = { ...old, ...rec, id: old.id };
      } else {
        if (cancelled) return; // 처리 전에 취소된 건은 기록하지 않음
        sum.새기록++;
      }
      if (rec.kind === '피복' && !rec.item) { rec.result = '넘김'; rec.reason = '피복 품목 아님'; plan.recs.push(rec); sum.넘김++; return; }
      const m = matchPerson(rec.person, emps, nameMap, rec.source_date);
      if (!m.emp) { if (old && old.reason === m.reason) return; rec.result = '확인필요'; rec.reason = m.reason; rec.employee_id = null; plan.recs.push(rec); if (!old) sum.확인필요++; return; }
      rec.employee_id = m.emp.id;
      const r = decide(plan, rec, m.emp);
      Object.assign(rec, r); plan.recs.push(rec); sum[r.result]++;
    };

    for (const mv of moves) {
      const it = itemById.get(mv.item_id) || {};
      const label = [it.item_group || it.name || '품목#' + mv.item_id, it.size].filter(Boolean).join(' ');
      await handle({ kind: '피복', source_id: mv.id, source_date: mv.moved_on, person: mv.person, content: `${label} × ${mv.quantity}`, item: linkItem(it.item_group || it.name), size: it.size || null }, !!mv.deleted_at, '가나안요청에서 지급 기록이 지워짐');
    }
    for (const a of apps) {
      const ok = a.status === '승인' && !a.is_deleted;
      const days = leaveDays(a);
      const range = a.end_date && a.end_date !== a.start_date ? `${mmdd(a.start_date)}~${mmdd(a.end_date)}` : mmdd(a.start_date);
      const rec = { kind: '연차', source_id: a.id, source_date: a.start_date, person: a.worker_name, content: `${a.application_type}${a.application_type === '연차' ? ' ' + days + '일' : ''} (${range})`, leave_type: a.application_type, start_date: a.start_date, end_date: a.end_date || a.start_date, leave_days: days };
      if (!ok && !have.has('연차:' + a.id)) continue; // 승인 전이면 기다림
      await handle(rec, !ok, a.is_deleted ? '가나안요청에서 신청이 지워짐' : `가나안요청에서 '${a.status}'로 바뀜`);
    }
    await commitPlan(env, plan);
    const msg = Object.entries(sum).filter(([, v]) => v).map(([k, v]) => k + ' ' + v).join(', ') || '새 기록 없음';
    await sb(env, '/rest/v1/erp_link_state?id=eq.1', { method: 'PATCH', body: { last_run_at: new Date().toISOString(), last_ok: true, last_message: `${who} · ${msg}`, running_until: null } });
    return { ok: true, summary: sum, message: msg };
  } catch (e) {
    await sb(env, '/rest/v1/erp_link_state?id=eq.1', { method: 'PATCH', body: { last_run_at: new Date().toISOString(), last_ok: false, last_message: `${who} · ${e.message}`.slice(0, 300), running_until: null } });
    throw e;
  }
}

export async function handleLink(env, path, b) {
  if (path === '/api/link/run') return runLink(env, '버튼');
  if (path === '/api/link/status') {
    const since = ymd(new Date(Date.now() - 62 * 864e5));
    const [st, open, recent] = await Promise.all([
      must(sb(env, '/rest/v1/erp_link_state?select=last_run_at,last_ok,last_message&id=eq.1'), '연동 표가 없습니다. v024 SQL을 먼저 실행하세요.'),
      must(sb(env, '/rest/v1/erp_link_records?select=*&result=in.(확인필요,취소됨)&order=source_date.desc&limit=300'), '연동 기록 조회 실패'),
      must(sb(env, `/rest/v1/erp_link_records?select=*&source_date=gte.${since}&order=source_date.desc,id.desc&limit=500`), '연동 기록 조회 실패')
    ]);
    return { state: st[0] || null, configured: !!(env.REQ_SUPABASE_URL && env.REQ_SUPABASE_KEY), open, recent };
  }
  const id = Number(b.id);
  const rec = Number.isInteger(id) ? (await must(sb(env, '/rest/v1/erp_link_records?select=*&id=eq.' + id), '연동 기록 조회 실패'))[0] : null;
  if (!rec) throw new ApiError('기록을 찾을 수 없습니다.', 404);
  if (path === '/api/link/resolve') {
    if (rec.result !== '확인필요') throw new ApiError('이미 처리된 기록입니다.', 409);
    const emp = (await must(sb(env, '/rest/v1/sewon_employees?select=id,name,site&id=eq.' + q(String(b.employee_id || ''))), '직원 조회 실패'))[0];
    if (!emp) throw new ApiError('직원을 골라주세요.');
    if (b.remember !== false && nameKey(rec.person)) await must(sb(env, '/rest/v1/erp_link_name_map?on_conflict=source,source_name', { method: 'POST', body: { source: LINK_SOURCE, source_name: nameKey(rec.person), employee_id: emp.id }, headers: { prefer: 'resolution=merge-duplicates,return=minimal' } }), '이름 짝 저장 실패');
    const plan = await loadPlan(env, emp.id);
    const r = decide(plan, rec, emp);
    plan.recs.push({ ...rec, employee_id: emp.id, ...r });
    await commitPlan(env, plan);
    return { ok: true, result: r.result, reason: r.reason };
  }
  if (path === '/api/link/skip') {
    if (rec.result !== '확인필요') throw new ApiError('이미 처리된 기록입니다.', 409);
    await commitPlan(env, { ...newPlan(new Map(), new Map()), recs: [{ ...rec, result: '넘김', reason: '관리자가 넘김' }] });
    return { ok: true };
  }
  if (path === '/api/link/ack') {
    if (rec.result !== '취소됨') throw new ApiError('확인할 기록이 아닙니다.', 409);
    await commitPlan(env, { ...newPlan(new Map(), new Map()), recs: [{ ...rec, result: '취소확인', reason: (rec.reason || '').split(' · ')[0] + ' · 관리자 확인함' }] });
    return { ok: true };
  }
  throw new ApiError('없는 요청입니다.', 404);
}
