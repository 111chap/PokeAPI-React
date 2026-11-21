import { randomInt } from 'node:crypto';
import { httpError } from './security.js';
const cache = new Map(), pending = new Map();
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!response.ok) throw httpError(502, 'Pokémon service is unavailable. Try again later.');
  return response.json();
}
export async function getPokemon(id) {
  if (!Number.isInteger(id) || id < 1 || id > 151) throw httpError(400, 'Invalid Pokémon.');
  if (cache.has(id)) return structuredClone(cache.get(id));
  if (!pending.has(id)) pending.set(id, (async () => {
    const data = await json(`https://pokeapi.co/api/v2/pokemon/${id}`);
    const moves = (await Promise.all(data.moves.slice(0, 6).map(async ({ move }) => {
      if (!/^[a-z0-9-]+$/.test(move.name)) return null;
      try {
        const details = await json(`https://pokeapi.co/api/v2/move/${move.name}`);
        return details.power && details.damage_class.name !== 'status'
          ? { name: details.name, power: Math.min(details.power, 250), type: details.type.name, accuracy: details.accuracy ?? 100 } : null;
      } catch { return null; }
    }))).filter(Boolean).slice(0, 4);
    const defaults = ['tackle', 'quick-attack', 'body-slam', 'take-down'];
    while (moves.length < 4) moves.push({ name: defaults[moves.length], power: 40, type: 'normal', accuracy: 100 });
    const pokemon = { id: data.id, name: data.name, sprites: data.sprites, types: data.types.map(t => t.type.name), moves };
    cache.set(id, pokemon); return pokemon;
  })().finally(() => pending.delete(id)));
  return structuredClone(await pending.get(id));
}
export function expForLevel(level) { return Math.floor(100 * Math.pow(1.2, level - 1)); }
export function battlePokemon(pokemon, level, opponent = false) {
  const maxHp = 100 + level * (opponent ? 8 : 5);
  return { ...pokemon, level, maxHp, currentHp: maxHp, experience: 0, expForNextLevel: expForLevel(level) };
}
export function attack(attacker, defender, move, random = () => randomInt(0, 1000000) / 1000000) {
  if (random() * 100 >= move.accuracy) return 0;
  let damage = Math.floor(move.power * (0.8 + random() * 0.4) * attacker.level / 50);
  if (attacker.types.includes(move.type)) damage = Math.floor(damage * 1.5);
  if (random() < 0.1) damage = Math.floor(damage * 1.5);
  damage = Math.max(1, damage); defender.currentHp = Math.max(0, defender.currentHp - damage);
  return damage;
}
