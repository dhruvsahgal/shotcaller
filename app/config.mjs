import { resolve } from 'node:path';
export function configuration(env = process.env) {
  const config = { dataDir: resolve(env.DATA_DIR || '.runtime'), leagueId: env.YAHOO_LEAGUE_ID || '12345', expectedTeams: Number(env.EXPECTED_TEAMS || 10), maxPages: Number(env.MAX_PAGES || 40), cdpUrl: env.BROWSER_CDP_URL || '', token: env.APP_TOKEN || '', model: env.LLM_MODEL || '', apiKey: env.LLM_API_KEY || '', endpoint: env.LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions', promptPath: resolve('prompts/shotcaller-system.md'), host: env.HOST || '127.0.0.1', port: Number(env.PORT || 3030) };
  for (const [key, min, max] of [['expectedTeams', 2, 30], ['maxPages', 1, 200], ['port', 1, 65535]]) if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key} configuration`);
  if (!/^\d+$/.test(config.leagueId)) throw new Error('Invalid league ID');
  return config;
}
