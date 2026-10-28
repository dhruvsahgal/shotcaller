export const countKeys = ['gp', 'fgm', 'fga', 'ftm', 'fta', 'three_pm', 'pts', 'oreb', 'reb', 'ast', 'stl', 'blk'];
export const categoryKeys = ['fg_pct', 'ft_pct', 'three_pm', 'pts', 'oreb', 'reb', 'ast', 'stl', 'blk'];
export function numeric(value) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).replaceAll(',', '').trim();
  return /^-?(?:\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null;
}
export function validateStats(stats) {
  for (const [key, n] of Object.entries(stats)) {
    if (n !== null && (!Number.isFinite(n) || n < 0)) throw new Error(`Invalid statistic: ${key}`);
    if (key.endsWith('_pct') && n > 1) throw new Error('Invalid percentage');
  }
  for (const [made, attempts] of [['fgm', 'fga'], ['ftm', 'fta']]) {
    if (stats[made] != null && stats[attempts] != null && stats[made] > stats[attempts]) throw new Error('Shooting makes exceed attempts');
  }
  if (stats.oreb != null && stats.reb != null && stats.oreb > stats.reb) throw new Error('Offensive rebounds exceed rebounds');
  return stats;
}
export function sumStats(rows) {
  const stats = Object.fromEntries(countKeys.map(key => [key, rows.length && rows.every(r => r[key] != null) ? rows.reduce((s, r) => s + r[key], 0) : null]));
  stats.fg_pct = stats.fga > 0 && stats.fgm != null ? stats.fgm / stats.fga : null;
  stats.ft_pct = stats.fta > 0 && stats.ftm != null ? stats.ftm / stats.fta : null;
  return validateStats(stats);
}
