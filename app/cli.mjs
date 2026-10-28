import { readFile } from 'node:fs/promises';
import { configuration } from './config.mjs';
import { Store } from './store.mjs';
import { analyze } from './analysis.mjs';
import { makeDecision } from './decisions.mjs';
import { refreshYahoo } from './yahoo.mjs';

const config = configuration(), store = new Store(config.dataDir);
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'import') {
    if (!args.length) throw new Error('Supply historical JSON file paths');
    for (const file of args) { const saved = await store.importHistorical(JSON.parse(await readFile(file, 'utf8'))); console.log(`${saved.id} · historical · original metadata preserved`); }
  } else if (command === 'capture') {
    const result = await refreshYahoo(config, store, text => console.log(text));
    console.log(`${result.id} · ${result.status}`);
    for (const warning of result.warnings) console.log(warning);
    if (result.status !== 'complete') process.exitCode = 2;
  } else if (command === 'list') {
    console.log(JSON.stringify((await store.list()).map(({ id, kind, status, observed_at }) => ({ id, kind, status, observed_at })), null, 2));
  } else if (command === 'analysis') console.log(JSON.stringify(analyze(await store.list()), null, 2));
  else if (command === 'decide') {
    if (args.length !== 1) throw new Error('Supply a decision request JSON file');
    const decision = await makeDecision(JSON.parse(await readFile(args[0], 'utf8')), config, store);
    console.log(`${decision.id}\n${decision.answer}`);
  } else console.log('ShotCaller\n  import <historical JSON files>\n  list\n  capture\n  analysis\n  decide <request.json>\n\nUse the authenticated HTTP API when the server is already running.');
} catch (error) {
  const safe = /^(Invalid|Unsupported|Select|A question|Follow-up|Previous decision|Configure|Model |Evidence |ShotCaller |Yahoo login|Supply|Expected)/.test(error.message);
  console.error(safe ? error.message : 'Operation failed. Check input files, browser login and service configuration.'); process.exitCode = 1;
}
