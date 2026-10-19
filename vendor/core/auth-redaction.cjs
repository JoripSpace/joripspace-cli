'use strict';

function redactAuthError(value, secrets = []) {
  const values = [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret))].sort(
    (left, right) => right.length - left.length,
  );
  function redact(item) {
    if (typeof item === 'string') {
      for (const secret of values) item = item.split(secret).join('[REDACTED]');
      return item;
    }
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [redact(key), redact(entry)]));
    }
    return item;
  }
  return redact(value);
}

module.exports = { redactAuthError };
