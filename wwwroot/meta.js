// Auto-generated meta breaker data
// Type effectiveness, Pokemon types, move database, and movesets

const TYPE_CHART = (() => {
  // SE=1.6, NVE=0.625, IMMUNE=0.390625, neutral=1.0
  const c = {};
  c['normal'] = {'rock':0.625, 'steel':0.625, 'ghost':0.390625};
  c['fire'] = {'grass':1.6, 'ice':1.6, 'bug':1.6, 'steel':1.6, 'fire':0.625, 'water':0.625, 'rock':0.625, 'dragon':0.625};
  c['water'] = {'fire':1.6, 'ground':1.6, 'rock':1.6, 'water':0.625, 'grass':0.625, 'dragon':0.625};
  c['electric'] = {'water':1.6, 'flying':1.6, 'electric':0.625, 'grass':0.625, 'dragon':0.625, 'ground':0.390625};
  c['grass'] = {'water':1.6, 'ground':1.6, 'rock':1.6, 'fire':0.625, 'grass':0.625, 'poison':0.625, 'flying':0.625, 'bug':0.625, 'dragon':0.625, 'steel':0.625};
  c['ice'] = {'grass':1.6, 'ground':1.6, 'flying':1.6, 'dragon':1.6, 'fire':0.625, 'water':0.625, 'ice':0.625, 'steel':0.625};
  c['fighting'] = {'normal':1.6, 'ice':1.6, 'rock':1.6, 'dark':1.6, 'steel':1.6, 'poison':0.625, 'flying':0.625, 'psychic':0.625, 'bug':0.625, 'fairy':0.625, 'ghost':0.390625};
  c['poison'] = {'grass':1.6, 'fairy':1.6, 'poison':0.625, 'ground':0.625, 'rock':0.625, 'ghost':0.625, 'steel':0.390625};
  c['ground'] = {'fire':1.6, 'electric':1.6, 'poison':1.6, 'rock':1.6, 'steel':1.6, 'grass':0.625, 'bug':0.625, 'flying':0.390625};
  c['flying'] = {'grass':1.6, 'fighting':1.6, 'bug':1.6, 'electric':0.625, 'rock':0.625, 'steel':0.625};
  c['psychic'] = {'fighting':1.6, 'poison':1.6, 'psychic':0.625, 'steel':0.625, 'dark':0.390625};
  c['bug'] = {'grass':1.6, 'psychic':1.6, 'dark':1.6, 'fire':0.625, 'fighting':0.625, 'poison':0.625, 'flying':0.625, 'ghost':0.625, 'steel':0.625, 'fairy':0.625};
  c['rock'] = {'fire':1.6, 'ice':1.6, 'flying':1.6, 'bug':1.6, 'fighting':0.625, 'ground':0.625, 'steel':0.625};
  c['ghost'] = {'psychic':1.6, 'ghost':1.6, 'dark':0.625, 'normal':0.390625, 'fighting':0.390625};
  c['dragon'] = {'dragon':1.6, 'fairy':0.390625};
  c['dark'] = {'psychic':1.6, 'ghost':1.6, 'fighting':0.625, 'dark':0.625, 'fairy':0.625};
  c['steel'] = {'ice':1.6, 'rock':1.6, 'fairy':1.6, 'fire':0.625, 'water':0.625, 'electric':0.625, 'steel':0.625};
  c['fairy'] = {'fighting':1.6, 'dragon':1.6, 'dark':1.6, 'fire':0.625, 'poison':0.625, 'steel':0.625};
  return c;
})();

function typeEffectiveness(atkType, defType1, defType2) {
  const m1 = (TYPE_CHART[atkType] || {})[defType1] || 1.0;
  const m2 = defType2 ? ((TYPE_CHART[atkType] || {})[defType2] || 1.0) : 1.0;
  return m1 * m2;
}

const POKEMON_TYPES = {};
// Populated at runtime by loadPokemon() from wwwroot/data/pokemon.json (PvPoke gamemaster).
const FAST_MOVES = {};
// Populated at runtime by loadMoves() from wwwroot/data/moves.json (PvPoke gamemaster).

const CHARGED_MOVES = {};
// Populated at runtime by loadMoves() from wwwroot/data/moves.json (PvPoke gamemaster).

// Charged moves with special PvP effects (stat buffs/debuffs)
// buff: [atkStages, defStages] applied to SELF; debuff: [atkStages, defStages] applied to OPPONENT
// chance: probability of effect (1.0 = guaranteed). Only moves where this matters in PvP are listed.
const MOVE_EFFECTS = {};
// Populated at runtime by loadMoves() from wwwroot/data/moves.json (PvPoke gamemaster).

// v2 format: {fast:[moveIds], charged:[moveIds], elite:[moveIds]}
// elite array lists moves that require an Elite TM (legacy / Community Day exclusive)
const POKEMON_MOVESETS = {};
// Populated at runtime by loadPokemon() from wwwroot/data/pokemon.json (PvPoke gamemaster).
