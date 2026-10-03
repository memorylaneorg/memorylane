import { it, expect } from 'vitest';
import { createTestApp } from '../helpers/app.js';
it('keeps administration authenticated and refuses activation without the plugin', async () => {
    const t = await createTestApp();
    try {
        expect((await t.app.inject({ url: '/api/tv-sharing' })).statusCode).toBe(401);
        const state = await t.app.inject({ url: '/api/tv-sharing', headers: { cookie: t.cookie } });
        expect(state.json()).toMatchObject({ installed: false, settings: { enabled: false, folders: [] }, runtime: null });
        expect((await t.app.inject({ method: 'PUT', url: '/api/tv-sharing', headers: { cookie: t.cookie }, payload: { enabled: true } })).statusCode).toBe(409);
    }
    finally {
        await t.close();
    }
});
