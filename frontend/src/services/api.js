import axios from 'axios';

const API_BASE = '/api';

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
});

// Authentication is carried in an HttpOnly cookie, never JavaScript storage.

export const authAPI = {
  logout: () => api.post('/logout', {}).then(res => res.data),
  login: (username, password) => 
    api.post('/login', { username, password }).then(res => res.data),
  
  register: (username, email, password) => 
    api.post('/register', { username, email, password }).then(res => res.data),
  
  verifyToken: () => 
    api.get('/dashboard').then(res => res.data.user),
};

export const pokemonAPI = {
  getRandomPokemon: () => 
    api.get('/random-pokemon').then(res => res.data),

  rollPaidGacha: () =>
    api.post('/roll-paid-gacha', {}).then(res => res.data),
  
  chooseStarter: (pokemon) => 
    api.post('/choose-starter', { pokemon }).then(res => res.data),
  
  getDashboardData: () => 
    api.get('/dashboard').then(res => res.data),
  
  getRandomOpponent: () => api.post('/battle/start', {}).then(res => res.data),

  battleTurn: (battleId, moveIndex, turn) =>
    api.post('/battle/turn', { battleId, moveIndex, turn }).then(res => res.data),

  runFromBattle: (battleId) => api.post('/battle/run', { battleId }).then(res => res.data),
  
  getUserStarter: () => 
    api.get('/user-starter').then(res => res.data),
  
  
  getUserStats: () => 
    api.get('/user-stats').then(res => res.data),
  
  getLeaderboards: () => 
    api.get('/leaderboards').then(res => res.data),
  
  getBattleHistory: () => 
    api.get('/battle-history').then(res => res.data),
};
