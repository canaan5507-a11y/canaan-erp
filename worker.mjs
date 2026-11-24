// 가나안ERP v007 · 이름 + 숫자 4자리 로그인 서버 (Cloudflare Worker)
// 웹 파일(public/)은 그대로 보여주고, /api/* 만 여기서 처리합니다.
//
// Cloudflare 대시보드 > canaan-erp > Settings > Variables and Secrets 에 넣을 Secret 3개:
//   SUPABASE_SERVICE_KEY : Supabase 새 DB의 secret 키 (sb_secret_...)  ※ 절대 저장소·채팅에 올리지 않기
//   PIN_SECRET           : 아무 긴 글자 (40자 이상 권장). 바꾸면 모든 PIN을 다시 정해야 함
//   SETUP_CODE           : 첫 관리자 만들 때 한 번 입력하는 암호 (아무 단어)
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
  if (!me || !me.active || me.role !== '관리자') throw new ApiError('관리자만 할 수 있습니다.', 403);
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
  if (!acc.active) throw new ApiError('사용 중지된 계정입니다. 관리자에게 문의하세요.', 403);
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
  if (path === '/api/check' && req.method === 'GET') {
    // 설정 점검용 (키 값은 절대 보여주지 않음, 앞 글자 종류만)
    const k = String(env.SUPABASE_SERVICE_KEY || '');
    const kind = k.startsWith('sb_secret_') ? 'sb_secret (정상)' : k.startsWith('sb_publishable_') ? 'sb_publishable (잘못 넣음! secret 키를 넣어야 함)' : k.startsWith('eyJ') ? '예전 service_role 키' : '알 수 없음';
    const a = await sb(env, '/auth/v1/admin/users?page=1&per_page=1');
    const r = await sb(env, '/rest/v1/erp_accounts?select=id&limit=1');
    return json({ 서비스키_종류: kind, 서비스키_길이: k.length, 관리자API: a.status + (upMsg(a.data) ? ' ' + upMsg(a.data) : ''), 계정표: r.status + (upMsg(r.data) ? ' ' + upMsg(r.data) : ''), PIN_SECRET_길이: String(env.PIN_SECRET || '').length, SETUP_CODE_있음: !!env.SETUP_CODE, 주소: env.SUPABASE_URL });
  }
  if (req.method !== 'POST' && !(path === '/api/accounts' && req.method === 'GET')) throw new ApiError('지원하지 않는 요청입니다.', 405);

  if (path === '/api/login') return json(await login(env, await readJson(req)));

  if (path === '/api/setup') {
    const b = await readJson(req);
    if (!env.SETUP_CODE) throw new ApiError('Cloudflare에 SETUP_CODE가 없습니다.', 503);
    if (typeof b.setup_code !== 'string' || b.setup_code !== env.SETUP_CODE) throw new ApiError('설치 암호가 맞지 않습니다.', 403);
    if ((await countAccounts(env)) !== 0) throw new ApiError('이미 관리자 계정이 있습니다.', 409);
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
    if (!active && acc.role === '관리자' && (await otherAdmins()) === 0) throw new ApiError('마지막 관리자는 사용 중지할 수 없습니다.');
    await must(sb(env, '/auth/v1/admin/users/' + acc.id, { method: 'PUT', body: { ban_duration: active ? 'none' : '876000h' } }), '상태 변경 실패');
    await must(sb(env, '/rest/v1/erp_accounts?id=eq.' + q(acc.id), { method: 'PATCH', body: { active, fail_count: 0, locked_until: null } }), '상태 변경 실패');
    return json({ ok: true });
  }
  if (path === '/api/accounts/role') {
    if (!ROLES.includes(b.role)) throw new ApiError('권한 값이 잘못되었습니다.');
    if (b.role !== '관리자' && acc.role === '관리자' && (await otherAdmins()) === 0) throw new ApiError('마지막 관리자의 권한은 바꿀 수 없습니다.');
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
  }
};
