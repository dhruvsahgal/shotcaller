export const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : isPlainObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
