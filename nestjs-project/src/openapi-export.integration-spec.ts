import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  describe('videos paths (phase-03-videos)', () => {
    let paths: Record<string, Record<string, Record<string, unknown>>>;

    beforeAll(() => {
      paths = document.paths as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
    });

    function responseCodes(operation: Record<string, unknown>): string[] {
      return Object.keys(operation.responses as Record<string, unknown>);
    }

    function hasErrorEnvelopeRef(
      operation: Record<string, unknown>,
      status: string,
    ): boolean {
      const responses = operation.responses as Record<
        string,
        Record<string, unknown>
      >;
      const response = responses[status];
      const content = response?.content as
        | Record<string, Record<string, unknown>>
        | undefined;
      const schema = content?.['application/json']?.schema as
        | Record<string, unknown>
        | undefined;
      return schema?.['$ref'] === '#/components/schemas/ApiErrorEnvelope';
    }

    const videoPaths = [
      { path: '/videos', method: 'post' },
      { path: '/videos/{id}/complete-upload', method: 'post' },
      { path: '/videos/{id}/abort-upload', method: 'post' },
      { path: '/videos/{id}', method: 'get' },
      { path: '/videos/{id}/stream', method: 'get' },
      { path: '/videos/{id}/download', method: 'get' },
    ];

    it('exports all 6 video paths', () => {
      for (const { path, method } of videoPaths) {
        expect(paths[path]?.[method]).toBeDefined();
      }
    });

    it('every video operation has a non-empty summary and at least one success + one error response', () => {
      const successCodes = new Set(['200', '201', '204', '302']);

      for (const { path, method } of videoPaths) {
        const operation = paths[path][method];
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);

        const codes = responseCodes(operation);
        expect(codes.some((c) => successCodes.has(c))).toBe(true);
        expect(codes.some((c) => !successCodes.has(c))).toBe(true);
      }
    });

    it('every video error response references ApiErrorEnvelope', () => {
      const successCodes = new Set(['200', '201', '204', '302']);

      for (const { path, method } of videoPaths) {
        const operation = paths[path][method];
        const errorCodes = responseCodes(operation).filter(
          (c) => !successCodes.has(c),
        );
        expect(errorCodes.length).toBeGreaterThan(0);
        for (const code of errorCodes) {
          expect(hasErrorEnvelopeRef(operation, code)).toBe(true);
        }
      }
    });

    it('POST /videos, complete-upload and abort-upload require access-token security', () => {
      const securedPaths = [
        { path: '/videos', method: 'post' },
        { path: '/videos/{id}/complete-upload', method: 'post' },
        { path: '/videos/{id}/abort-upload', method: 'post' },
      ];

      for (const { path, method } of securedPaths) {
        const operation = paths[path][method];
        const security = operation.security as
          | Array<Record<string, unknown>>
          | undefined;
        expect(security).toBeDefined();
        expect(security?.some((req) => 'access-token' in req)).toBe(true);
      }
    });

    it('GET /videos/:id, /stream and /download do not require security (Visibility rule)', () => {
      const publicPaths = [
        { path: '/videos/{id}', method: 'get' },
        { path: '/videos/{id}/stream', method: 'get' },
        { path: '/videos/{id}/download', method: 'get' },
      ];

      for (const { path, method } of publicPaths) {
        const operation = paths[path][method];
        expect(operation.security).toBeUndefined();
      }
    });
  });
});
