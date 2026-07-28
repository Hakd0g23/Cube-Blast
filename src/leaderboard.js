// Supabase REST client for the online leaderboard. DOM-free (same layering
// convention as core.js) -- main.js owns all UI wiring. Every call is
// wrapped so a network failure or missing config never crashes the game;
// offline play must keep working.
//
// config.js is imported dynamically (not as a static top-level import) so a
// missing or broken file degrades to "leaderboard unavailable" instead of a
// module-resolution error that would take down the whole game -- main.js
// imports this module statically, and a failed static import anywhere in
// that chain throws before any game code runs at all.

let configPromise = null;
function loadConfig() {
  if (!configPromise) {
    configPromise = import('./config.js').catch(() => ({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' }));
  }
  return configPromise;
}

function headers(cfg) {
  return {
    apikey: cfg.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

function configured(cfg) {
  return Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
}

export async function fetchTopScores(limit = 10) {
  const cfg = await loadConfig();
  if (!configured(cfg)) return null;
  try {
    const res = await fetch(
      `${cfg.SUPABASE_URL}/rest/v1/scores?select=name,score&order=score.desc&limit=${limit}`,
      { headers: headers(cfg) },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function submitScore(name, score) {
  const cfg = await loadConfig();
  if (!configured(cfg)) return false;
  try {
    const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/scores`, {
      method: 'POST',
      headers: { ...headers(cfg), Prefer: 'return=minimal' },
      body: JSON.stringify({ name, score }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
