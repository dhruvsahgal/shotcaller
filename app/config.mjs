import { resolve } from 'node:path';
export function configuration(env = process.env) {
  const config = { dataDir: resolve(env.DATA_DIR || '.runtime'), leagueId: env.YAHOO_LEAGUE_ID || '12345', expectedTeams: Number(env.EXPECTED_TEAMS || 10), maxPages: Number(env.MAX_PAGES || 40), cdpUrl: env.BROWSER_CDP_URL || '', token: env.APP_TOKEN || '', model: env.LLM_MODEL || '', apiKey: env.LLM_API_KEY || '', endpoint: env.LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions', promptPath: resolve('prompts/shotcaller-system.md'), host: env.HOST || '127.0.0.1', port: Number(env.PORT || 3030) };
  for (const [key, min, max] of [['expectedTeams', 2, 30], ['maxPages', 1, 200], ['port', 1, 65535]]) if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key} configuration`);
  if (!/^\d+$/.test(config.leagueId)) throw new Error('Invalid league ID');
  Object.assign(config, { collectorToken: env.COLLECTOR_TOKEN || '', collectorGatesVerified: env.COLLECTOR_GATES_VERIFIED === 'true', boxesRunUrl: env.BOXES_RUN_URL || '', boxesSecret: env.BOXES_AUTOMATION_SECRET || '', boxesThreadId: env.BOXES_COLLECTOR_THREAD_ID || '', boxesAutomationId: env.BOXES_AUTOMATION_ID || '' });
  if (config.collectorToken && (config.collectorToken.length < 24 || config.collectorToken === config.token)) throw new Error('Invalid collector broker token: use a distinct token of at least 24 characters');
  if (config.boxesRunUrl) {
    const url = new URL(config.boxesRunUrl);
    if (url.protocol !== 'https:' || !/(^|\.)boxes\.dev$/.test(url.hostname) || url.username || url.password || url.hash || url.search) throw new Error('Invalid boxes.dev Run endpoint');
  }
  Object.assign(config, {
    approvalToken: env.APPROVAL_TOKEN || '', executorToken: env.EXECUTOR_TOKEN || '', actionSigningKey: env.ACTION_SIGNING_KEY || '',
    actionMode: env.ACTION_MODE === 'live' ? 'live' : 'shadow', actionGatesVerified: env.ACTION_GATES_VERIFIED === 'true',
    actionEnabledClasses: (env.ACTION_ENABLED_CLASSES || '').split(',').map(value => value.trim()).filter(Boolean), boxesExecutorThreadId: env.BOXES_EXECUTOR_THREAD_ID || ''
  });
  const credentials = [config.token, config.collectorToken, config.approvalToken, config.executorToken].filter(Boolean);
  if ((config.approvalToken && config.approvalToken.length < 24) || (config.executorToken && config.executorToken.length < 24) || new Set(credentials).size !== credentials.length) throw new Error('Invalid action credentials: use distinct tokens of at least 24 characters');
  if (config.actionSigningKey && config.actionSigningKey.length < 32) throw new Error('Invalid action signing key');
  if (config.actionEnabledClasses.some(value => !['lineup_move', 'il_move', 'add_drop', 'trade_response'].includes(value))) throw new Error('Invalid enabled action class');
  if (config.actionMode === 'live' && (!config.actionGatesVerified || !config.actionSigningKey || !config.approvalToken || !config.executorToken || !config.boxesExecutorThreadId)) throw new Error('Invalid live action configuration: verified gates and isolated credentials are required');
  return config;
}
