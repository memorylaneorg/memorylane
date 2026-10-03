import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { TV_PLUGIN_ID, TvSettingsSchema, TvSharingBroker } from './broker.js';
export async function registerTvSharingRoutes(app: FastifyInstance, ctx: AppContext) {
    const manager = ctx.pluginManager;
    const broker = new TvSharingBroker(ctx.db, ctx.paths, () => !!manager?.isEnabled(TV_PLUGIN_ID));
    manager?.moduleHost?.setCoreHandler?.((id, method, payload) => broker.call(id, method, payload));
    const interfaces = () => Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => /^(utun|tun|tap|wg|tailscale|docker|veth|bridge)/i.test(name) ? [] : (entries ?? []).filter(i => !i.internal && i.family === 'IPv4' && TvSettingsSchema.shape.address.safeParse(i.address).success).map(i => ({ name, address: i.address })));
    app.get('/api/tv-sharing', { preHandler: app.requireAuth }, async () => {
        const enabled = !!manager?.isEnabled(TV_PLUGIN_ID);
        let runtime: unknown = null;
        if (enabled)
            try {
                runtime = await manager!.moduleHost.call(TV_PLUGIN_ID, 'status', {});
            }
            catch {
                runtime = { sharing: false, error: 'Plugin unavailable' };
            }
        return { installed: enabled, settings: broker.settings(), interfaces: interfaces(), runtime, diagnostics: await broker.diagnostics() };
    });
    app.put('/api/tv-sharing', { preHandler: app.requireAuth }, async (req, reply) => {
        if (!manager?.isEnabled(TV_PLUGIN_ID))
            return reply.code(409).send({ error: 'Enable the TV Photo Sharing plugin first' });
        try {
            const parsed = TvSettingsSchema.partial().parse(req.body), next = { ...broker.settings(), ...parsed };
            if (next.enabled && !interfaces().some(i => i.address === next.address))
                return reply.code(400).send({ error: 'Select an available private LAN interface' });
            const settings = broker.save(parsed);
            await manager.moduleHost.call(TV_PLUGIN_ID, 'refresh', {});
            const runtime = await manager.moduleHost.call(TV_PLUGIN_ID, 'status', {});
            return { settings, runtime };
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid settings' });
        }
    });
    app.get('/api/tv-sharing/folders', { preHandler: app.requireAuth }, async (req, reply) => {
        const input = (req.query as {
            parentId?: string;
        }).parentId;
        if (input !== undefined && !/^\d+$/.test(input))
            return reply.code(400).send({ error: 'Invalid folder' });
        return ctx.db.prepare(`SELECT f.id,f.name,f.parent_id AS parentId, EXISTS(SELECT 1 FROM folders c WHERE c.parent_id=f.id AND c.status='active') AS hasChildren FROM folders f JOIN scan_roots r ON r.id=f.scan_root_id WHERE f.status='active' AND r.enabled=1 AND r.kind='folder' AND ${input === undefined ? 'f.parent_id IS NULL' : 'f.parent_id=?'} ORDER BY f.name COLLATE NOCASE LIMIT 1000`).all(...(input === undefined ? [] : [Number(input)]));
    });
}
