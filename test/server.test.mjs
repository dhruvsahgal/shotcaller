import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app/server.mjs';
import { configuration } from '../app/config.mjs';
test('API protects private evidence and handles a failed refresh without fake success', async () => {
  const config = { ...configuration(), expectedTeams: 2, dataDir: await mkdtemp(join(tmpdir(), 'shotcaller-api-')), token: 'test-access-token-at-least-24-characters' };
  Object.assign(config,{approvalToken:'test-approval-token-at-least-24-characters',executorToken:'test-executor-token-at-least-24-characters',collectorToken:'test-collector-token-at-least-24-characters',actionSigningKey:'test-signing-key-with-at-least-32-characters',actionMode:'shadow',actionGatesVerified:false,actionEnabledClasses:[]});
  const app = await createApp(config, { collect: async () => { throw new Error('Yahoo login required. Run npm run login'); } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { Authorization: `Bearer ${config.token}` };
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const initial = await (await fetch(`${base}/api/state`, { headers })).json();
    assert.equal(initial.prompt.ready, true);
    assert.equal(initial.latest_id, null);
    assert.equal(initial.overview.matchup, null);
    const imported = await fetch(`${base}/api/import`, {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({snapshot_id:'manual-matchup',league_id:config.leagueId,kind:'matchup_weekly_category_totals',week:2,observed_date:'2026-10-30',source:{type:'synthetic'},teams:[{name:'A',stats:{pts:100}},{name:'B',stats:{pts:90}}]})});
    assert.equal(imported.status,201);
    const importedRecord = await imported.json();
    const updated = await (await fetch(`${base}/api/state`,{headers})).json();
    assert.equal(updated.overview.matchup.teams[0].stats.pts,100);
    assert.equal(updated.overview.matchup.meta.observed_at,'2026-10-30');
    assert.equal(updated.latest_id,null);
    const forecastInput = {
      schema_version:1,kind:'forecast_input',league_id:config.leagueId,season:'2026',week:4,as_of:'2026-11-14T00:00:00Z',
      scoring_timezone:'America/Los_Angeles',period:{start_date:'2026-11-09',end_date:'2026-11-15'},expected_teams:2,source_snapshot_ids:[importedRecord.id],roster_slots:['PG'],
      matchups:[{id:'m1',team_ids:['a','b']}],teams:[
        {id:'a',name:'A',actual:{stats:{fgm:0,fga:0,ftm:0,fta:0,three_pm:0,pts:0,oreb:0,reb:0,ast:0,stl:0,blk:0},source_ids:[importedRecord.id]},players:[{id:'a1',name:'A1',eligible_positions:['PG'],availability:{status:'available',observed_at:'2026-11-14T00:00:00Z',source_ids:[importedRecord.id]},games:[{starts_at:'2026-11-15T03:00:00Z',source_ids:[importedRecord.id]}],baseline:{fgm:5,fga:10,ftm:2,fta:2,three_pm:2,pts:14,oreb:1,reb:5,ast:4,stl:1,blk:1}}]},
        {id:'b',name:'B',actual:{stats:{fgm:0,fga:0,ftm:0,fta:0,three_pm:0,pts:0,oreb:0,reb:0,ast:0,stl:0,blk:0},source_ids:[importedRecord.id]},players:[{id:'b1',name:'B1',eligible_positions:['PG'],availability:{status:'available',observed_at:'2026-11-14T00:00:00Z',source_ids:[importedRecord.id]},games:[{starts_at:'2026-11-15T03:00:00Z',source_ids:[importedRecord.id]}],baseline:{fgm:4,fga:10,ftm:2,fta:2,three_pm:1,pts:11,oreb:1,reb:4,ast:3,stl:1,blk:0}}]}
      ]
    };
    assert.equal((await fetch(`${base}/api/forecasts`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(forecastInput)})).status,401);
    const forecastResponse = await fetch(`${base}/api/forecasts`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(forecastInput)});
    assert.equal(forecastResponse.status,201);
    const forecastRecord = await forecastResponse.json();
    const withForecast = await (await fetch(`${base}/api/state`,{headers})).json();
    assert.equal(withForecast.forecast.id,forecastRecord.id);
    assert.equal(withForecast.forecast.matchups[0].projected_leader,'a');
    assert.equal(withForecast.forecast.input,undefined);
    const frozen = await (await fetch(`${base}/api/forecasts/${forecastRecord.id}`,{headers})).json();
    assert.deepEqual(frozen.forecast.input,forecastInput);
    const outcomeStats={fgm:6,fga:12,ftm:2,fta:2,three_pm:2,pts:16,oreb:1,reb:6,ast:5,stl:1,blk:1};
    const evaluationResponse=await fetch(`${base}/api/evaluations`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({forecast_id:forecastRecord.id,outcome:{id:'outcome-1',status:'final',expected_matchups:1,finalized_at:'2026-11-16T08:00:00Z',source_snapshot_ids:[importedRecord.id],matchups:[{id:'m1',status:'final',teams:[{id:'a',stats:outcomeStats,usable_starts:1},{id:'b',stats:{...outcomeStats,pts:12},usable_starts:1}]}]}})});
    assert.equal(evaluationResponse.status,201);
    const evaluationRecord=await evaluationResponse.json();
    assert.deepEqual(evaluationRecord.evaluation.source_snapshot_ids,[importedRecord.id]);
    const reportResponse=await fetch(`${base}/api/reports`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({league_id:config.leagueId,season:'2026',week:4,expected_matchups:1,matchups:[{id:'m1',status:'final',source_snapshot_ids:[importedRecord.id],teams:[{id:'a',name:'A',stats:outcomeStats},{id:'b',name:'B',stats:{...outcomeStats,pts:12}}]}],evaluations:[evaluationRecord],decisions:[],actions:[],lineup_days:[]})});
    assert.equal(reportResponse.status,201);
    const withIntelligence=await (await fetch(`${base}/api/state`,{headers})).json();
    assert.deepEqual(withIntelligence.intelligence.evaluation.source_snapshot_ids,[importedRecord.id]);
    assert.deepEqual(withIntelligence.intelligence.report.source_snapshot_ids,[importedRecord.id]);
    assert.equal(withIntelligence.intelligence.evaluation_summary.independent_validation_weeks,1);
    const proposalResponse=await fetch(`${base}/api/actions`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({version:1,action_class:'lineup_move',league_id:config.leagueId,scoring_date:'2026-11-14',expires_at:'2099-11-15T00:00:00Z',operation:{player_id:'p1',from_slot:'BN',to_slot:'PG'},preconditions:{roster_version:'v1'},source_snapshot_ids:[importedRecord.id]})});
    assert.equal(proposalResponse.status,201);
    const actionIntent=await proposalResponse.json();
    const collectorHeaders={Authorization:`Bearer ${config.collectorToken}`,'Content-Type':'application/json'};
    const authorizationBody=JSON.stringify({expires_at:'2099-11-14T23:00:00Z',approved_by:'manager',nonce:'42345678-1234-1234-1234-123456789012'});
    assert.equal((await fetch(`${base}/api/actions/${actionIntent.id}/authorize`,{method:'POST',headers:collectorHeaders,body:authorizationBody})).status,401);
    assert.equal((await fetch(`${base}/api/actions/${actionIntent.id}/authorize`,{method:'POST',headers:{Authorization:`Bearer ${config.approvalToken}`,'Content-Type':'application/json'},body:authorizationBody})).status,201);
    assert.equal((await fetch(`${base}/api/executor/actions/${actionIntent.id}`,{headers:{Authorization:`Bearer ${config.collectorToken}`}})).status,401);
    assert.equal((await fetch(`${base}/api/executor/actions/${actionIntent.id}`,{headers:{Authorization:`Bearer ${config.executorToken}`}})).status,200);
    assert.equal((await fetch(`${base}/api/forecasts/forecast-missing`,{headers})).status,404);
    const importPayload=payload=>fetch(`${base}/api/import`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const foreignResponse = await importPayload({snapshot_id:'foreign',league_id:'999',source:{type:'test'},kind:'collected_documents',documents:[]});
    const foreignRecord = await foreignResponse.json();
    const foreignInput = JSON.parse(JSON.stringify(forecastInput).replaceAll(importedRecord.id, foreignRecord.id));
    assert.equal((await fetch(`${base}/api/forecasts`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(foreignInput)})).status,400);
    assert.equal((await (await fetch(`${base}/api/state`,{headers})).json()).forecast.id,forecastRecord.id);
    assert.equal((await importPayload({snapshot_id:'bad-documents',source:{type:'test'},kind:'collected_documents',documents:{wrong:true}})).status,400);
    assert.equal((await importPayload({snapshot_id:'large-archive',source:{type:'test'},note:'x'.repeat(600000)})).status,201);
    assert.equal((await importPayload({snapshot_id:'oversized',source:{type:'test'},note:'x'.repeat(1048576)})).status,400);
    assert.equal((await (await fetch(`${base}/api/state`,{headers})).json()).snapshots.length,2);
    assert.equal(JSON.stringify(initial).includes(config.token), false);
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers })).status, 202);
    let final;
    for (let i = 0; i < 20; i++) { final = await (await fetch(`${base}/api/state`, { headers })).json(); if (final.refresh.status === 'failed') break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(final.refresh.status, 'failed');
    assert.equal(final.latest_id, null);
    assert.equal((await fetch(`${base}/api/snapshots/%2e%2e%2fsecret`, { headers })).status, 400);
  } finally { await new Promise(resolve => app.close(resolve)); }
});
