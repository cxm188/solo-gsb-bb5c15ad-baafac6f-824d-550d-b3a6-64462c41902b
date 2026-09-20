import { STATUS_CODES } from 'node:http';
import Fastify from 'fastify';
import { mergePatches, PatchError } from './merge.js';
import { auditOrdering } from './audit.js';
import { MergeStore } from './store.js';
import { previewResolution, ResolutionError } from './resolution.js';
import { EXAMPLE_REQUEST, EXAMPLE_CONFLICT_REQUEST } from './example.js';

export const VERSION = '1.0.0';

const operationSchema = {
  type: 'object',
  required: ['op', 'path'],
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['add', 'remove', 'replace'] },
    path: { type: 'string' },
    value: true,
  },
};

const mergeBodySchema = {
  type: 'object',
  required: ['base', 'patchA', 'patchB'],
  additionalProperties: false,
  properties: {
    base: true,
    patchA: { type: 'array', items: operationSchema },
    patchB: { type: 'array', items: operationSchema },
  },
};

const resolutionBodySchema = {
  type: 'object',
  required: ['resolutions'],
  additionalProperties: false,
  properties: {
    resolutions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['conflict', 'winner'],
        additionalProperties: false,
        properties: {
          conflict: { type: 'integer', minimum: 0 },
          winner: { type: 'string', enum: ['A', 'B'] },
        },
      },
    },
  },
};

function publicRecord(record) {
  const { id, status, merged, conflicts, stats, createdAt } = record;
  return { id, status, merged, conflicts, stats, createdAt };
}

export function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? { level: options.logLevel || 'info' },
  });
  const store = new MergeStore({ max: options.storeMax ?? 1000 });
  // Audit results are deterministic; cache per stored record so repeated
  // queries serialize byte-for-byte without re-running the replays.
  const audits = new WeakMap();
  const startedAt = Date.now();

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `route ${req.method} ${req.url} not found`,
    });
  });

  app.setErrorHandler((err, req, reply) => {
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) req.log.error(err);
    reply.code(statusCode).send({
      statusCode,
      error: err.error || STATUS_CODES[statusCode] || 'Error',
      message: statusCode >= 500 ? 'unexpected server error' : err.message,
    });
  });

  app.get('/health', async () => ({
    status: 'ok',
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
    store: { size: store.size(), max: store.max },
  }));

  app.get('/', async () => ({
    name: 'config-merge-rehearsal-api',
    version: VERSION,
    description:
      'Dry-run rehearsal for concurrent config changes: merges a base JSON document ' +
      'with two RFC 6902 patches (add/remove/replace) and reports deterministic ' +
      'results or structured conflicts.',
    endpoints: {
      'GET /health': 'liveness/readiness probe',
      'GET /api/v1/example': 'example merge request payload',
      'POST /api/v1/merges': 'rehearse a merge of { base, patchA, patchB }',
      'GET /api/v1/merges': 'list stored rehearsals',
      'GET /api/v1/merges/:id': 'fetch one rehearsal (inputs + outcome)',
      'GET /api/v1/merges/:id/order-audit':
        'replay saved patches A→B and B→A under strict RFC 6902 ordering (commutative / divergent / failed)',
      'POST /api/v1/merges/:id/resolution-preview':
        'preview a conflict resolution by choosing winner A or B per conflict ordinal (no stored changes)',
      'DELETE /api/v1/merges/:id': 'delete one rehearsal',
    },
  }));

  app.get('/api/v1/example', async () => ({
    description: 'POST the body below to /api/v1/merges',
    mergeRequest: EXAMPLE_REQUEST,
    conflictRequest: EXAMPLE_CONFLICT_REQUEST,
  }));

  app.post('/api/v1/merges', { schema: { body: mergeBodySchema } }, async (req, reply) => {
    const { base, patchA, patchB } = req.body;
    let result;
    try {
      result = mergePatches(base, patchA, patchB);
    } catch (err) {
      if (err instanceof PatchError) {
        return reply.code(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: err.code,
          message: err.message,
          details: err.details,
        });
      }
      throw err;
    }
    const record = store.save({ base, patchA, patchB, ...result });
    return reply.code(result.status === 'clean' ? 200 : 409).send(publicRecord(record));
  });

  app.get('/api/v1/merges', async () => ({
    total: store.size(),
    items: store.list(),
  }));

  app.get('/api/v1/merges/:id', async (req, reply) => {
    const record = store.get(req.params.id);
    if (!record) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `no rehearsal stored with id ${req.params.id}`,
      });
    }
    return record;
  });

  app.get('/api/v1/merges/:id/order-audit', async (req, reply) => {
    const record = store.get(req.params.id);
    if (!record) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `no rehearsal stored with id ${req.params.id}`,
      });
    }
    let result = audits.get(record);
    if (!result) {
      result = auditOrdering({
        base: record.base,
        patchA: record.patchA,
        patchB: record.patchB,
      });
      audits.set(record, result);
    }
    return {
      id: record.id,
      createdAt: record.createdAt,
      ...result,
    };
  });

  app.post(
    '/api/v1/merges/:id/resolution-preview',
    { schema: { body: resolutionBodySchema } },
    async (req, reply) => {
      const record = store.get(req.params.id);
      if (!record) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `no rehearsal stored with id ${req.params.id}`,
        });
      }
      try {
        const result = previewResolution(record, req.body.resolutions);
        return reply
          .code(result.status === 'clean' ? 200 : 409)
          .send({
            id: record.id,
            createdAt: record.createdAt,
            resolutions: req.body.resolutions,
            ...result,
          });
      } catch (err) {
        if (err instanceof ResolutionError) {
          return reply.code(err.statusCode).send({
            statusCode: err.statusCode,
            error: STATUS_CODES[err.statusCode],
            code: err.code,
            message: err.message,
            details: err.details,
          });
        }
        throw err;
      }
    },
  );

  app.delete('/api/v1/merges/:id', async (req, reply) => {
    if (!store.delete(req.params.id)) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `no rehearsal stored with id ${req.params.id}`,
      });
    }
    return reply.code(204).send();
  });

  return app;
}
