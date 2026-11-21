import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomInt, randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { configuration, credentials, cookieToken, httpError, rateLimiter } from './security.js';
import { getPokemon, battlePokemon, expForLevel, attack } from './pokemon.js';

const TTL = 60 * 60, ISSUER = 'pokeko-api', AUDIENCE = 'pokeko-web';
const asyncRoute = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function createApp({ db, config = configuration(), pokemon = getPokemon, random } = {}) {
  if (!db) throw new Error('Database required.');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if ((origin && !config.origins.includes(origin)) || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('sec-fetch-site') === 'cross-site')) return res.status(403).json({ error: 'Origin not allowed.' });
    next();
  });
  app.use(cors({ origin: config.origins, credentials: true }));
  app.use('/api', rateLimiter({ limit: 120, windowMs: 60000 }));
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'Use application/json.' });
    next();
  });
  const authLimit = rateLimiter({ limit: 20, windowMs: 15 * 60000 });
  const gameLimit = rateLimiter({ limit: 60, windowMs: 60000 });
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/api' };
  const session = (res, user) => {
    const now = Date.now(), id = randomUUID();
    db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
    db.run('INSERT INTO sessions(id,user_id,expires_at) VALUES (?,?,?)', id, user.id, now + TTL * 1000);
    db.run('DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY expires_at DESC LIMIT 10)', user.id, user.id);
    const token = jwt.sign({ userId: user.id }, config.secret, { algorithm: 'HS256', expiresIn: TTL, issuer: ISSUER, audience: AUDIENCE, jwtid: id });
    res.cookie('poke_session', token, { ...cookieOptions, maxAge: TTL * 1000 });
  };
  const authenticate = (req, res, next) => {
    try {
      const token = cookieToken(req);
      if (!token || token.length > 4096) throw new Error();
      const payload = jwt.verify(token, config.secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, maxAge: TTL });
      if (!Number.isSafeInteger(payload.userId) || typeof payload.jti !== 'string' || !Number.isInteger(payload.exp)) throw new Error();
      const user = db.get('SELECT u.id,u.username,u.email FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=? AND u.id=? AND s.expires_at>?', payload.jti, payload.userId, Date.now());
      if (!user) throw new Error();
      req.user = user; req.sessionId = payload.jti; next();
    } catch { res.status(401).json({ error: 'Please sign in again.' }); }
  };
  app.post('/api/register', authLimit, asyncRoute(async (req, res) => {
    const { username, email, password } = credentials(req.body, true);
    const hashed = await bcrypt.hash(password, 12);
    let id;
    try { id = Number(db.run('INSERT INTO users(username,email,password) VALUES (?,?,?)', username, email, hashed).lastInsertRowid); }
    catch (error) { if (error.message.includes('UNIQUE')) throw httpError(409, 'Username or email is unavailable.'); throw error; }
    const user = { id, username, email }; session(res, user); res.status(201).json({ message: 'User created successfully', user });
  }));
  const dummyHash = bcrypt.hashSync(randomUUID(), 12);
  app.post('/api/login', authLimit, asyncRoute(async (req, res) => {
    const { username, password } = credentials(req.body);
    const user = db.get('SELECT * FROM users WHERE username=?', username);
    const valid = await bcrypt.compare(password, user?.password || dummyHash);
    if (!user || !valid) throw httpError(401, 'Invalid credentials.');
    session(res, user);
    res.json({ message: 'Login successful', user: { id: user.id, username: user.username, email: user.email, hasChosenStarter: Boolean(db.get('SELECT id FROM user_pokemon WHERE user_id=? AND is_starter=1', user.id)) } });
  }));
  app.post('/api/logout', authenticate, (req, res) => {
    db.run('DELETE FROM sessions WHERE id=?', req.sessionId);
    res.clearCookie('poke_session', cookieOptions); res.json({ message: 'Signed out.' });
  });
  app.use('/api', authenticate, gameLimit);
  const starter = id => {
    const row = db.get('SELECT * FROM user_pokemon WHERE user_id=? AND is_starter=1', id);
    if (!row) throw httpError(404, 'Choose a starter Pokémon first.');
    return row;
  };
  app.get('/api/random-pokemon', asyncRoute(async (req, res) => {
    if (db.get('SELECT id FROM user_pokemon WHERE user_id=? AND is_starter=1', req.user.id)) throw httpError(409, 'Starter already chosen.');
    const drawn = await pokemon(randomInt(1, 152));
    db.run('INSERT INTO starter_draws(user_id,pokemon_id,expires_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET pokemon_id=excluded.pokemon_id,expires_at=excluded.expires_at', req.user.id, drawn.id, Date.now() + 10 * 60000);
    res.json(drawn);
  }));
  app.post('/api/choose-starter', asyncRoute(async (req, res) => {
    const id = req.body?.pokemon?.id;
    if (!Number.isInteger(id) || id < 1 || id > 151) throw httpError(400, 'Invalid Pokémon.');
    const canonical = await pokemon(id);
    db.transaction(() => {
      const draw = db.get('SELECT * FROM starter_draws WHERE user_id=?', req.user.id);
      if (!draw || draw.pokemon_id !== id || draw.expires_at <= Date.now()) throw httpError(400, 'Draw a starter before selecting it.');
      if (db.get('SELECT id FROM user_pokemon WHERE user_id=? AND is_starter=1', req.user.id)) throw httpError(409, 'Starter already chosen.');
      db.run('INSERT INTO user_pokemon(user_id,pokemon_id,pokemon_name,pokemon_data,is_starter) VALUES (?,?,?,?,1)', req.user.id, id, canonical.name, JSON.stringify(canonical));
      db.run('UPDATE users SET chosen_pokemon_id=? WHERE id=?', id, req.user.id);
      db.run('DELETE FROM starter_draws WHERE user_id=?', req.user.id);
    });
    res.json({ message: 'Starter chosen.', pokemon: canonical });
  }));
  app.get('/api/dashboard', (req, res) => {
    const user = db.get('SELECT username,trophies,coins FROM users WHERE id=?', req.user.id);
    const row = db.get('SELECT * FROM user_pokemon WHERE user_id=? AND is_starter=1', req.user.id);
    res.json({ user, starterPokemon: row ? { ...JSON.parse(row.pokemon_data), level: row.level, experience: row.experience, expForNextLevel: expForLevel(row.level) } : null });
  });
  app.get('/api/user-starter', asyncRoute(async (req, res) => {
    const row = starter(req.user.id);
    res.json({ ...battlePokemon(await pokemon(row.pokemon_id), row.level), experience: row.experience });
  }));
  app.post('/api/roll-paid-gacha', asyncRoute(async (req, res) => {
    if (db.get('SELECT coins FROM users WHERE id=?', req.user.id).coins < 150) throw httpError(400, 'Not enough coins.');
    const drawn = await pokemon(randomInt(1, 152));
    const newCoins = db.transaction(() => {
      const debit = db.run('UPDATE users SET coins=coins-150 WHERE id=? AND coins>=150', req.user.id);
      if (!debit.changes) throw httpError(400, 'Not enough coins.');
      db.run('INSERT INTO user_pokemon(user_id,pokemon_id,pokemon_name,pokemon_data,is_starter) VALUES (?,?,?,?,0)', req.user.id, drawn.id, drawn.name, JSON.stringify(drawn));
      return db.get('SELECT coins FROM users WHERE id=?', req.user.id).coins;
    });
    res.json({ message: 'Roll successful!', pokemon: drawn, newCoins });
  }));
  app.post('/api/battle/start', asyncRoute(async (req, res) => {
    const row = starter(req.user.id);
    const [own, enemy] = await Promise.all([pokemon(row.pokemon_id), pokemon(randomInt(1, 152))]);
    const level = Math.min(100, Math.max(1, row.level + randomInt(-2, 3)));
    const ownState = { ...battlePokemon(own, row.level), experience: row.experience };
    const enemyState = battlePokemon(enemy, level, true), id = randomUUID();
    db.transaction(() => {
      db.run('DELETE FROM battles WHERE user_id=? OR created_at<?', req.user.id, Date.now() - 30 * 60000);
      db.run('INSERT INTO battles(id,user_id,user_pokemon,opponent,created_at) VALUES (?,?,?,?,?)', id, req.user.id, JSON.stringify(ownState), JSON.stringify(enemyState), Date.now());
    });
    res.json({ ...enemyState, battleId: id, userPokemon: ownState, turns: 0 });
  }));
  const activeBattle = req => {
    if (typeof req.body?.battleId !== 'string' || !/^[a-f0-9-]{36}$/.test(req.body.battleId)) throw httpError(400, 'Invalid battle.');
    const battle = db.get('SELECT * FROM battles WHERE id=? AND user_id=?', req.body.battleId, req.user.id);
    if (!battle || battle.state !== 'active' || battle.created_at < Date.now() - 30 * 60000) throw httpError(409, 'Battle expired or already finished.');
    return battle;
  };
  app.post('/api/battle/turn', (req, res, next) => {
    try {
      const { moveIndex, turn } = req.body || {};
      if (!Number.isInteger(moveIndex) || moveIndex < 0 || moveIndex > 3 || !Number.isInteger(turn) || turn < 0) throw httpError(400, 'Invalid move or turn.');
      const response = db.transaction(() => {
        const battle = activeBattle(req);
        if (battle.turns !== turn) throw httpError(409, 'Turn already processed.');
        if (battle.turns >= 500) throw httpError(409, 'Battle turn limit reached. Start a new battle.');
        const own = JSON.parse(battle.user_pokemon), enemy = JSON.parse(battle.opponent), move = own.moves[moveIndex];
        if (!move) throw httpError(400, 'Invalid move.');
        const dealt = attack(own, enemy, move, random);
        const log = [{ message: `${own.name} used ${move.name}: ${dealt} damage.`, type: 'user' }];
        let taken = 0;
        if (enemy.currentHp > 0) {
          const enemyMove = enemy.moves[randomInt(0, enemy.moves.length)];
          taken = attack(enemy, own, enemyMove, random);
          log.push({ message: `${enemy.name} used ${enemyMove.name}: ${taken} damage.`, type: 'opponent' });
        }
        const turns = turn + 1, damageTaken = battle.damage_taken + taken, damageDealt = battle.damage_dealt + dealt;
        const result = enemy.currentHp <= 0 ? 'win' : own.currentHp <= 0 ? 'lost' : 'active';
        let rewards = null;
        if (result !== 'active') {
          const row = starter(req.user.id);
          const bonus = result === 'win' ? (damageTaken < 30 && turns < 3 ? 2 : damageTaken < 50 && turns < 5 ? 1.5 : 1) * Math.max(1, enemy.level / 5) : 1;
          const trophiesEarned = result === 'win' ? Math.floor(10 * bonus) : 0, coinsEarned = result === 'win' ? Math.floor(50 * bonus) : 10;
          const expGained = result === 'win' ? Math.floor(enemy.level * 20 * bonus * (1 + Math.max(0, enemy.level - row.level) * .1)) : 0;
          let newLevel = row.level, newExperience = row.experience + expGained;
          while (newLevel < 100 && newExperience >= expForLevel(newLevel)) { newExperience -= expForLevel(newLevel); newLevel++; }
          if (newLevel === 100) newExperience = Math.min(newExperience, expForLevel(100));
          db.run('UPDATE users SET trophies=trophies+?,coins=coins+? WHERE id=?', trophiesEarned, coinsEarned, req.user.id);
          db.run('UPDATE user_pokemon SET level=?,experience=? WHERE id=?', newLevel, newExperience, row.id);
          db.run('INSERT INTO user_battles(user_id,opponent_pokemon_data,result,trophies_earned,coins_earned) VALUES (?,?,?,?,?)', req.user.id, battle.opponent, result, trophiesEarned, coinsEarned);
          const updated = db.get('SELECT trophies,coins FROM users WHERE id=?', req.user.id);
          rewards = { trophiesEarned, coinsEarned, expGained, levelsGained: newLevel - row.level, newLevel, newExperience, expForNextLevel: expForLevel(newLevel), bonusMultiplier: bonus.toFixed(1), newTrophies: updated.trophies, newCoins: updated.coins };
        }
        db.run('UPDATE battles SET user_pokemon=?,opponent=?,turns=?,damage_taken=?,damage_dealt=?,state=? WHERE id=?', JSON.stringify(own), JSON.stringify(enemy), turns, damageTaken, damageDealt, result, battle.id);
        return { userPokemon: own, opponentPokemon: enemy, turns, battleStats: { turns, damageTaken, damageDealt }, result, log, rewards };
      });
      res.json(response);
    } catch (error) { next(error); }
  });
  app.post('/api/battle/run', (req, res, next) => {
    try { const battle = activeBattle(req); db.run("UPDATE battles SET state='ran' WHERE id=?", battle.id); res.json({ result: 'ran' }); }
    catch (error) { next(error); }
  });
  app.post('/api/battle-result', (req, res) => res.status(410).json({ error: 'Rewards are now calculated by the server during battle turns.' }));
  app.get('/api/random-opponent', (req, res) => res.status(410).json({ error: 'Use POST /api/battle/start.' }));
  app.get('/api/user-stats', (req, res) => {
    const stats = db.get('SELECT trophies,coins FROM users WHERE id=?', req.user.id);
    const battles = db.get("SELECT COUNT(*) AS totalBattles,COALESCE(SUM(result='win'),0) AS wins FROM user_battles WHERE user_id=?", req.user.id);
    res.json({ ...stats, ...battles });
  });
  app.get('/api/leaderboards', (req, res) => res.json(db.all("SELECT username,trophies,coins,(SELECT COUNT(*) FROM user_battles WHERE user_id=u.id) AS totalBattles,(SELECT COUNT(*) FROM user_battles WHERE user_id=u.id AND result='win') AS wins FROM users u WHERE trophies>0 ORDER BY trophies DESC,wins DESC LIMIT 50")));
  app.get('/api/battle-history', (req, res) => res.json(db.all('SELECT * FROM user_battles WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id).map(b => ({ id: b.id, result: b.result, trophiesEarned: b.trophies_earned, coinsEarned: b.coins_earned, date: b.battle_date, opponent: JSON.parse(b.opponent_pokemon_data) }))));
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, req, res, next) => {
    const status = error.status >= 400 && error.status < 500 ? error.status : error.type === 'entity.too.large' ? 413 : 500;
    res.status(status).json({ error: status === 500 ? 'Server error. Please try again.' : error.message });
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { loadEnvFile(fileURLToPath(new URL('.env', import.meta.url))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = configuration();
  const db = openDatabase(process.env.DB_PATH || fileURLToPath(new URL('data/pokemon.db', import.meta.url)));
  const port = Number(process.env.PORT || 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  createApp({ db, config }).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`API listening on port ${port}`));
}
