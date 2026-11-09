import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'http';
import { ServerStartResult, setOnReleaseCallback, rejectReason } from './server.js';

// Tests for v0.2.1 server module additions

describe('ServerStartResult interface', () => {
  it('has correct shape for new server (owning)', () => {
    const result: ServerStartResult = {
      port: 49777,
      isExistingServer: false
    };

    expect(result.port).toBe(49777);
    expect(result.isExistingServer).toBe(false);
  });

  it('has correct shape for existing server (deferred)', () => {
    const result: ServerStartResult = {
      port: 49777,
      isExistingServer: true
    };

    expect(result.port).toBe(49777);
    expect(result.isExistingServer).toBe(true);
  });

  it('port can be any valid port number', () => {
    const result: ServerStartResult = {
      port: 3000,
      isExistingServer: false
    };

    expect(result.port).toBe(3000);
  });
});

describe('setOnReleaseCallback', () => {
  it('should be a function', () => {
    expect(typeof setOnReleaseCallback).toBe('function');
  });

  it('accepts a callback function', () => {
    // Should not throw when called with a function
    expect(() => {
      setOnReleaseCallback(() => {});
    }).not.toThrow();
  });
});

// Note: isServerRunning and requestServerRelease make real HTTP requests
// and are better tested via integration tests or by mocking the http module.
// The E2E tests in test/e2e/notebook.e2e.test.ts cover these functions
// in a real VS Code environment.

describe('rejectReason (request gate)', () => {
  const token = 'a'.repeat(64);
  const req = (headers: Record<string, string>) => ({ headers } as unknown as IncomingMessage);
  const ok = { host: '127.0.0.1:49777', authorization: `Bearer ${token}` };

  it('accepts loopback host with the right token', () => {
    expect(rejectReason(req(ok), 49777, token)).toBeUndefined();
    expect(rejectReason(req({ ...ok, host: 'localhost:49777' }), 49777, token)).toBeUndefined();
  });

  it('refuses any browser request, even with the token', () => {
    expect(rejectReason(req({ ...ok, origin: 'https://evil.example' }), 49777, token)).toBe('browser requests are not allowed');
    expect(rejectReason(req({ ...ok, origin: 'null' }), 49777, token)).toBe('browser requests are not allowed');
  });

  it('refuses a non-loopback host (DNS rebinding)', () => {
    expect(rejectReason(req({ ...ok, host: 'evil.example:49777' }), 49777, token)).toBe('bad host');
    expect(rejectReason(req({ ...ok, host: '127.0.0.1:1234' }), 49777, token)).toBe('bad host');
    expect(rejectReason(req({ authorization: ok.authorization }), 49777, token)).toBe('bad host');
  });

  it('refuses a missing, wrong, or wrong-length token', () => {
    expect(rejectReason(req({ host: ok.host }), 49777, token)).toBe('unauthorized');
    expect(rejectReason(req({ ...ok, authorization: `Bearer ${'b'.repeat(64)}` }), 49777, token)).toBe('unauthorized');
    expect(rejectReason(req({ ...ok, authorization: 'Bearer short' }), 49777, token)).toBe('unauthorized');
    expect(rejectReason(req({ ...ok, authorization: token }), 49777, token)).toBe('unauthorized');
  });
});
