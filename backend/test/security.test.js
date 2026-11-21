import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';
import { createApp } from '../server.js';
import { openDatabase } from '../database.js';
import { configuration, rateLimiter } from '../security.js';

const config = configuration({ JWT_SECRET: 'test-only-randomized-signing-key-not-for-deployment-839123', ALLOWED_ORIGINS: 'http://localhost:3000' });
const fakePokemon = async id => ({ id, name: `pokemon-${id}`, sprites: {}, types: ['normal'], moves: Array.from({ length: 4 }, (_, index) => ({ name: `move-${index}`, power: 40, accuracy: 100, type: 'normal' })) });

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config, pokemon: fakePokemon, random: () => .5 });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const response = await fetch(url + '/api' + route, { method, headers: { Origin: 'http://localhost:3000', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], rawCookie: response.headers.get('set-cookie') };
  };
  const register = async (username = 'trainer') => {
    const response = await request('/register', { method: 'POST', body: { username, email: username + '@example.invalid', password: 'test-password-934!' } });
    assert.equal(response.status, 201); return response;
  };
  const choose = async cookie => {
    const draw = await request('/random-pokemon', { cookie }); assert.equal(draw.status, 200);
    const selected = await request('/choose-starter', { method: 'POST', cookie, body: { pokemon: { ...draw.data, name: 'tampered', moves: [{ power: 999999 }] } } });
    assert.equal(selected.status, 200); assert.notEqual(selected.data.pokemon.name, 'tampered');
  };
  return { db, request, register, choose };
}

test('production rejects missing/default keys and wildcard origins', () => {
  assert.throws(() => configuration({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://example.com' }));
  assert.throws(() => configuration({ JWT_SECRET: 'your-secret-key-change-in-production', ALLOWED_ORIGINS: 'http://localhost:3000' }));
  assert.throws(() => configuration({ JWT_SECRET: config.secret, ALLOWED_ORIGINS: '*' }));
  assert.throws(() => configuration({ NODE_ENV: 'production', JWT_SECRET: config.secret, ALLOWED_ORIGINS: 'http://example.com' }));
});

test('registration/login use revocable HttpOnly sessions and reject malformed credentials', async t => {
  const { request, register } = await fixture(t);
  assert.equal((await request('/register', { method: 'POST', body: { username: {}, password: [] } })).status, 400);
  assert.equal((await request('/register', { method: 'POST', body: { username: 'trainer', password: 'short', email: 'bad' } })).status, 400);
  const account = await register();
  assert.match(account.rawCookie, /HttpOnly/i); assert.match(account.rawCookie, /SameSite=Strict/i);
  assert.equal(account.data.token, undefined);
  assert.equal((await request('/dashboard', { cookie: account.cookie })).status, 200);
  assert.equal((await request('/login', { method: 'POST', body: { username: 'trainer', password: {} } })).status, 400);
  assert.equal((await request('/login', { method: 'POST', body: { username: 'trainer', password: 'incorrect' } })).status, 401);
  const login = await request('/login', { method: 'POST', body: { username: 'trainer', password: 'test-password-934!' } });
  assert.equal(login.status, 200);
  assert.equal((await request('/logout', { method: 'POST', body: {}, cookie: login.cookie })).status, 200);
  assert.equal((await request('/dashboard', { cookie: login.cookie })).status, 401);
});

test('forged, missing and expired sessions cannot access accounts', async t => {
  const { db, request, register } = await fixture(t);
  const account = await register();
  assert.equal((await request('/dashboard')).status, 401);
  const forged = jwt.sign({ userId: account.data.user.id }, config.secret, { expiresIn: '1h', issuer: 'pokeko-api', audience: 'pokeko-web', jwtid: 'not-a-real-session' });
  assert.equal((await request('/dashboard', { cookie: 'poke_session=' + forged })).status, 401);
  db.run('UPDATE sessions SET expires_at=0');
  assert.equal((await request('/dashboard', { cookie: account.cookie })).status, 401);
});

test('cross-origin writes, non-JSON, oversized input and reset route are blocked', async t => {
  const { request, register } = await fixture(t);
  assert.equal((await request('/register', { method: 'POST', body: {}, headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await request('/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/register', { method: 'POST', body: { padding: 'x'.repeat(17000) } })).status, 413);
  const { cookie } = await register();
  assert.equal((await request('/reset-data', { method: 'POST', body: {}, cookie })).status, 404);
});

test('starter selection requires a server draw and ignores injected stats', async t => {
  const { db, request, register, choose } = await fixture(t);
  const { cookie } = await register();
  assert.equal((await request('/choose-starter', { method: 'POST', cookie, body: { pokemon: { id: 999999 } } })).status, 400);
  assert.equal((await request('/choose-starter', { method: 'POST', cookie, body: { pokemon: { id: 1 } } })).status, 400);
  await choose(cookie);
  const stored = db.get('SELECT pokemon_data FROM user_pokemon');
  assert.equal(JSON.parse(stored.pokemon_data).moves[0].power, 40);
  assert.equal((await request('/random-pokemon', { cookie })).status, 409);
});

test('concurrent gacha cannot overspend and failures roll back the debit', async t => {
  const { db, request, register } = await fixture(t);
  const { cookie } = await register(); db.run('UPDATE users SET coins=150');
  const results = await Promise.all([request('/roll-paid-gacha', { method: 'POST', body: {}, cookie }), request('/roll-paid-gacha', { method: 'POST', body: {}, cookie })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  assert.equal(db.get('SELECT coins FROM users').coins, 0);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM user_pokemon').count, 1);
  db.run('UPDATE users SET coins=150');
  db.run("CREATE TRIGGER fail_collection BEFORE INSERT ON user_pokemon BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
  assert.equal((await request('/roll-paid-gacha', { method: 'POST', body: {}, cookie })).status, 500);
  assert.equal(db.get('SELECT coins FROM users').coins, 150);
  assert.throws(() => db.transaction(() => { db.run('UPDATE users SET coins=999'); throw Error('rollback'); }));
  assert.equal(db.get('SELECT coins FROM users').coins, 150);
});

test('server battle turns reject forged results, other accounts and replay; pay once', async t => {
  const { db, request, register, choose } = await fixture(t);
  const first = await register('trainer1'), second = await register('trainer2');
  await choose(first.cookie); await choose(second.cookie);
  assert.equal((await request('/battle-result', { method: 'POST', cookie: first.cookie, body: { result: 'win', opponentLevel: 1000000 } })).status, 410);
  const started = await request('/battle/start', { method: 'POST', body: { level: 9999 }, cookie: first.cookie });
  assert.equal(started.status, 200); assert(started.data.level <= 7);
  const battleId = started.data.battleId;
  assert.equal((await request('/battle/turn', { method: 'POST', cookie: second.cookie, body: { battleId, turn: 0, moveIndex: 0 } })).status, 409);
  assert.equal((await request('/battle/turn', { method: 'POST', cookie: first.cookie, body: { battleId, turn: 0, moveIndex: 9 } })).status, 400);
  const turn = await request('/battle/turn', { method: 'POST', cookie: first.cookie, body: { battleId, turn: 0, moveIndex: 0, damage: 999999 } });
  assert.equal(turn.status, 200); assert.equal(turn.data.result, 'active');
  assert.equal((await request('/battle/turn', { method: 'POST', cookie: first.cookie, body: { battleId, turn: 0, moveIndex: 0 } })).status, 409);
  // Put this synthetic test battle one hit from completion; never alter a live database.
  const row = db.get('SELECT opponent FROM battles WHERE id=?', battleId);
  const opponent = JSON.parse(row.opponent); opponent.currentHp = 1;
  db.run('UPDATE battles SET opponent=? WHERE id=?', JSON.stringify(opponent), battleId);
  const finished = await request('/battle/turn', { method: 'POST', cookie: first.cookie, body: { battleId, turn: 1, moveIndex: 0 } });
  assert.equal(finished.data.result, 'win'); assert(finished.data.rewards.coinsEarned > 0);
  const balance = db.get('SELECT coins FROM users WHERE id=?', first.data.user.id).coins;
  assert.equal((await request('/battle/turn', { method: 'POST', cookie: first.cookie, body: { battleId, turn: 2, moveIndex: 0 } })).status, 409);
  assert.equal(db.get('SELECT coins FROM users WHERE id=?', first.data.user.id).coins, balance);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM user_battles').count, 1);
});

test('run abandons battles without rewards and expiry is enforced', async t => {
  const { db, request, register, choose } = await fixture(t);
  const { cookie } = await register(); await choose(cookie);
  let battle = await request('/battle/start', { method: 'POST', body: {}, cookie });
  assert.equal((await request('/battle/run', { method: 'POST', body: { battleId: battle.data.battleId }, cookie })).status, 200);
  assert.equal(db.get('SELECT coins FROM users').coins, 100);
  battle = await request('/battle/start', { method: 'POST', body: {}, cookie }); db.run('UPDATE battles SET created_at=0');
  assert.equal((await request('/battle/turn', { method: 'POST', body: { battleId: battle.data.battleId, turn: 0, moveIndex: 0 }, cookie })).status, 409);
});

test('rate limiting rejects excess requests', () => {
  const limit = rateLimiter({ limit: 2, windowMs: 60000 });
  let accepted = 0, rejected = 0;
  const req = { ip: '127.0.0.1' }, res = { setHeader() {}, status(code) { assert.equal(code, 429); rejected++; return this; }, json() {} };
  for (let n = 0; n < 3; n++) limit(req, res, () => accepted++);
  assert.equal(accepted, 2); assert.equal(rejected, 1);
});
