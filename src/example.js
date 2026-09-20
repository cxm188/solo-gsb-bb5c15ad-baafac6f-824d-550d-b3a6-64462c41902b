/**
 * Canned example payload, also mirrored in examples/merge-request.json.
 * Demonstrates: scalar replace, same-gap array insertions (A before B),
 * element removal with index drift, identical-op deduplication.
 */
export const EXAMPLE_REQUEST = {
  base: {
    app: 'payment-service',
    replicas: 2,
    servers: [
      { host: 'a.internal', port: 8080 },
      { host: 'b.internal', port: 8080 },
    ],
    features: { cache: true, tracing: false },
    tags: ['stable'],
  },
  patchA: [
    { op: 'replace', path: '/replicas', value: 3 },
    { op: 'add', path: '/servers/1', value: { host: 'a2.internal', port: 8080 } },
    { op: 'replace', path: '/features/tracing', value: true },
  ],
  patchB: [
    { op: 'remove', path: '/servers/0' },
    { op: 'add', path: '/servers/1', value: { host: 'b2.internal', port: 9090 } },
    { op: 'add', path: '/features/retries', value: 3 },
    { op: 'replace', path: '/features/tracing', value: true },
  ],
};

export const EXAMPLE_CONFLICT_REQUEST = {
  base: {
    database: { host: 'db1.internal', port: 5432 },
    mode: 'ha',
  },
  patchA: [
    { op: 'remove', path: '/database' },
    { op: 'replace', path: '/mode', value: 'single' },
  ],
  patchB: [
    { op: 'replace', path: '/database/host', value: 'db2.internal' },
    { op: 'replace', path: '/mode', value: 'readonly' },
  ],
};
