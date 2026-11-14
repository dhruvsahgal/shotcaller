import { categoryKeys } from './schema.mjs';

const ratio = (stats, made, attempted) => {
  if (!Number.isFinite(stats?.[made]) || !Number.isFinite(stats?.[attempted]) || stats[attempted] <= 0) return null;
  return stats[made] / stats[attempted];
};

export function categoryValue(stats, category) {
  if (!stats) return null;
  if (category === 'fg_pct') return ratio(stats, 'fgm', 'fga');
  if (category === 'ft_pct') return ratio(stats, 'ftm', 'fta');
  const value = category === 'stl' ? stats.stl ?? stats.st : stats[category];
  return Number.isFinite(value) ? value : null;
}

export function missingCategories(stats) {
  return categoryKeys.filter(category => !Number.isFinite(categoryValue(stats, category)));
}

