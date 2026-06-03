// tests/auth.test.js — Auth + Security tests for HCI
const { test, expect } = require('@playwright/test');

const BASE = process.env.HCI_TEST_URL || 'https://agent2.panji.me';
const PASSWORD = process.env.HCI_TEST_PASSWORD || 'pxnji2727';

test.describe('Auth & Security', () => {

  test('GET /api/health returns ok', async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('GET /api/session without auth returns ok (auth check endpoint)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/session`);
    expect(res.status()).toBe(200);
  });

  test('Protected endpoints return 401 without auth', async ({ request }) => {
    const endpoints = [
      '/api/gateway/default/status',
      '/api/profiles',
      '/api/office/kanban',
      '/api/office/agent-states',
      '/api/office/events',
      '/api/office/summary',
      '/api/system',
      '/api/monitoring',
    ];
    for (const ep of endpoints) {
      const res = await request.get(`${BASE}${ep}`);
      expect(res.status(), `${ep} should require auth`).toBe(401);
    }
  });

  test('Admin-only endpoints return 401 without auth (POST)', async ({ request }) => {
    const endpoints = [
      '/api/gateway/default/restart',
      '/api/avatar',
      '/api/layout',
      '/api/agent/state',
    ];
    for (const ep of endpoints) {
      const res = await request.post(`${BASE}${ep}`, { data: {} });
      expect(res.status(), `${ep} should require auth`).toBe(401);
    }
  });

  test('CSRF required for POST endpoints', async ({ request }) => {
    // Login to get auth cookie
    const login = await request.post(`${BASE}/api/auth/login`, {
      data: { username: 'bayendor', password: PASSWORD },
    });
    expect(login.status()).toBe(200);
    const cookies = login.headers()['set-cookie'];

    // Try POST without CSRF → should fail
    const res = await request.post(`${BASE}/api/gateway/default/status`, {
      headers: { cookie: cookies },
      data: {},
    });
    expect(res.status(), 'POST without CSRF should fail').toBeGreaterThanOrEqual(400);
  });

  test('Login with wrong password fails', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { username: 'bayendor', password: 'wrongpassword' },
    });
    expect(res.status()).toBe(401);
  });

  test('Login with correct credentials succeeds', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { username: 'bayendor', password: PASSWORD },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.role).toBe('admin');
  });

});

test.describe('Rate Limiting', () => {

  test('Login rate limited after 6 attempts', async ({ request }) => {
    for (let i = 0; i < 6; i++) {
      const res = await request.post(`${BASE}/api/auth/login`, {
        data: { username: 'test', password: 'wrong' },
      });
      if (i >= 5) {
        expect(res.status()).toBe(429);
      }
    }
  });

});
