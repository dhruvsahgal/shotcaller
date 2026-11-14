import { canonicalDigest } from './store.mjs';

export const rosterHeaders = Object.freeze(['Slot', 'Player', 'NBA Team', 'Eligibility', 'Injury']);

const playerPath = /^\/nba\/players\/([A-Za-z0-9._-]+)\/?$/;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const unique = values => [...new Set(values)];

function sourceInventory(capture) {
  return [{
    url: capture.url,
    checkpoint: structuredClone(capture.checkpoint ?? null),
    evidence_refs: structuredClone(capture.evidence_refs ?? []),
    source_hash: canonicalDigest(capture)
  }];
}

function sourceBase(capture, request) {
  return {
    contract_version: 1,
    collector_mode: 'observation_only',
    decision_output: false,
    league: structuredClone(request.league),
    team: structuredClone(request.team),
    scoring_period: structuredClone(request.scoring_period),
    scope: { dataset: 'team_roster', league_id: request.league.id, team_id: request.team.id },
    allowed_pages: structuredClone(request.allowed_pages),
    source: {
      url: capture.url,
      observed_at: capture.observed_at,
      evidence_refs: structuredClone(capture.evidence_refs ?? [])
    }
  };
}

function loginChallenge(capture) {
  const pageKind = capture.checkpoint?.kind;
  if (['login', 'passkey', 'consent', 'challenge'].includes(pageKind)) return pageKind;
  if (pageKind === 'team_roster') return null;
  const material = `${capture.title ?? ''}\n${capture.text ?? ''}`;
  if (/\bconsent\b/i.test(material)) return 'consent';
  if (/\bpasskey\b/i.test(material)) return 'passkey';
  if (/sign[ -]?in|log[ -]?in|authentication challenge/i.test(material)) return 'login';
  return null;
}

function findRosterTable(capture) {
  const tables = Array.isArray(capture.tables) ? capture.tables : [];
  return tables.find(table => Array.isArray(table.headers) && table.headers.some(header => header === 'Player')) ?? tables[0] ?? null;
}

function slot(label) {
  const value = clean(label);
  if (!value) return null;
  if (/^BN$/i.test(value)) return { group: 'bench', label: value };
  if (/^IL(?:\+)?$/i.test(value)) return { group: 'il', label: value };
  return { group: 'active', label: value };
}

function identity(row) {
  const link = Array.isArray(row.links) ? row.links.find(candidate => {
    try { return playerPath.test(new URL(candidate.href).pathname); } catch { return false; }
  }) : null;
  if (!link) return { player_id: null, player_url: null };
  const url = new URL(link.href);
  return { player_id: url.pathname.match(playerPath)?.[1] ?? null, player_url: `${url.origin}${url.pathname}` };
}

function partialReason(warnings, missingFields, missingRows) {
  if (warnings.length) return warnings.join(' ');
  if (missingRows) return `${missingRows} visible roster row(s) could not be extracted.`;
  if (missingFields.length) return 'Some visible roster fields were unavailable and remain null.';
  return 'Roster coverage could not be verified.';
}

export function extractRosterObservation(capture, request) {
  if (!plainObject(capture) || !plainObject(request) || !plainObject(request.league) || !plainObject(request.team)) throw new Error('Invalid roster extraction input');
  const base = sourceBase(capture, request);
  const challenge = loginChallenge(capture);
  const inventory = sourceInventory(capture);
  if (challenge) {
    return {
      ...base,
      status: 'needs_login',
      scoring_period: { kind: null, key: null, timezone: null },
      coverage: {
        visible_rows: null,
        extracted_rows: 0,
        missing_rows: null,
        missing_fields: ['scoring_period'],
        row_reconciled: false,
        note: `Yahoo showed a ${challenge} challenge before the roster was visible.`
      },
      roster: [],
      login: { required: true, challenge },
      warnings: ['Human login is required in the shared Browser.'],
      extraction: {
        method: 'structured_text', headers: [], displayed_total: null, source_visible_rows: null,
        row_locators: [], source_hash: canonicalDigest(capture), page_inventory: inventory
      }
    };
  }

  const warnings = [];
  const missingFields = [];
  const table = findRosterTable(capture);
  const headers = Array.isArray(table?.headers) ? table.headers.map(value => clean(value)) : [];
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const locators = rows.map(row => clean(row.locator)).filter(Boolean);
  const displayedTotal = Number.isSafeInteger(table?.visible_total) ? table.visible_total : null;
  const exactHeaders = headers.length === rosterHeaders.length && headers.every((header, index) => header === rosterHeaders[index]);
  const evidence = Array.isArray(capture.evidence_refs) ? capture.evidence_refs : [];
  const hasTextEvidence = evidence.some(ref => /\.txt(?:#|$)/i.test(ref));
  const hasImageEvidence = evidence.some(ref => /\.(?:png|jpe?g|webp)(?:#|$)/i.test(ref));

  if (!table) warnings.push('No roster table was visible.');
  if (!exactHeaders) warnings.push('Roster headers were missing or changed.');
  if (locators.length !== rows.length || new Set(locators).size !== locators.length) warnings.push('Every visible roster row requires a unique source locator.');
  if (displayedTotal === null || displayedTotal !== rows.length) warnings.push('Displayed roster total did not reconcile with visible source rows.');
  if (!hasTextEvidence || !hasImageEvidence) warnings.push('Both source text and screenshot evidence are required.');

  const roster = [];
  if (exactHeaders) {
    for (const [index, row] of rows.entries()) {
      const cells = Array.isArray(row.cells) ? row.cells : [];
      const values = Object.fromEntries(rosterHeaders.map((header, cellIndex) => [header, cells[cellIndex] ?? null]));
      const playerIdentity = identity(row);
      const entry = {
        ...playerIdentity,
        name: clean(values.Player),
        nba_team: clean(values['NBA Team']),
        eligibility: clean(values.Eligibility)?.split(',').map(value => value.trim()).filter(Boolean) ?? null,
        slot: slot(values.Slot),
        injury: clean(values.Injury),
        evidence_refs: Array.isArray(row.evidence_refs) ? structuredClone(row.evidence_refs) : [],
        source_locator: clean(row.locator)
      };
      const rowEvidence = entry.evidence_refs;
      if (!rowEvidence.some(ref => /\.txt(?:#|$)/i.test(ref)) || !rowEvidence.some(ref => /\.(?:png|jpe?g|webp)(?:#|$)/i.test(ref))) {
        warnings.push(`Roster row ${index + 1} requires text and screenshot evidence.`);
      }
      if (entry.player_id === null && entry.player_url === null) missingFields.push(`roster[${index}].identity`);
      for (const field of ['name', 'nba_team', 'eligibility', 'slot']) {
        if (entry[field] === null) missingFields.push(`roster[${index}].${field}`);
      }
      if (!entry.source_locator) warnings.push(`Roster row ${index + 1} has no source locator.`);
      roster.push(entry);
    }
  }

  const duplicateIdentities = roster.map(row => row.player_id ?? row.player_url).filter(Boolean);
  if (new Set(duplicateIdentities).size !== duplicateIdentities.length) warnings.push('Duplicate roster identities were present in visible rows.');
  if (missingFields.length > 0) warnings.push('Unavailable roster fields were preserved as null.');
  if (rows.length === 0) warnings.push('An empty team roster cannot establish complete league evidence.');

  const missingRows = rows.length - roster.length;
  const complete = exactHeaders && warnings.length === 0 && missingFields.length === 0 && missingRows === 0;
  return {
    ...base,
    status: complete ? 'complete' : 'partial',
    coverage: {
      visible_rows: rows.length,
      extracted_rows: roster.length,
      missing_rows: missingRows,
      missing_fields: unique(missingFields),
      row_reconciled: true,
      note: complete ? null : partialReason(warnings, missingFields, missingRows)
    },
    roster,
    login: { required: false, challenge: null },
    warnings: unique(warnings),
    extraction: {
      method: 'structured_text',
      headers,
      displayed_total: displayedTotal,
      source_visible_rows: rows.length,
      row_locators: locators,
      source_hash: canonicalDigest(capture),
      page_inventory: inventory
    }
  };
}

export function forcePartialReceipt(output, warning, pageInventory = output.extraction.page_inventory) {
  if (output.status === 'needs_login') return { ...output, extraction: { ...output.extraction, page_inventory: structuredClone(pageInventory) } };
  const warnings = unique([...output.warnings, warning]);
  return {
    ...output,
    status: 'partial',
    coverage: { ...output.coverage, note: warning },
    warnings,
    extraction: { ...output.extraction, page_inventory: structuredClone(pageInventory) }
  };
}
