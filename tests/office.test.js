// tests/office.test.js — Office Kanban + Quick Actions tests
const { test, expect } = require('@playwright/test');

const BASE = process.env.HCI_TEST_URL || 'https://agent2.panji.me';

let authCookies = null;

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${BASE}/api/auth/login`, {
    data: { username: 'bayendor', password: 'pxnji2727' },
  });
  authCookies = login.headers()['set-cookie'];
});

test.describe('Office API', () => {

  test('GET /api/office/kanban returns tasks', async ({ request }) => {
    const res = await request.get(`${BASE}/api/office/kanban`, {
      headers: { cookie: authCookies },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks.length).toBeGreaterThan(0);
    expect(Array.isArray(body.links)).toBe(true);
  });

  test('GET /api/office/agent-states returns agent list', async ({ request }) => {
    const res = await request.get(`${BASE}/api/office/agent-states`, {
      headers: { cookie: authCookies },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.agents)).toBe(true);
  });

  test('GET /api/office/summary returns overview', async ({ request }) => {
    const res = await request.get(`${BASE}/api/office/summary`, {
      headers: { cookie: authCookies },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.overview).toBeDefined();
    expect(body.overview.total).toBeGreaterThan(0);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(Array.isArray(body.recommendations)).toBe(true);
  });

  test('GET /api/office/events returns feed', async ({ request }) => {
    const res = await request.get(`${BASE}/api/office/events`, {
      headers: { cookie: authCookies },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
  });

});
