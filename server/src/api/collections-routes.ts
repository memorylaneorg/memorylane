import type { FastifyInstance } from 'fastify';
import { paginationQuerySchema } from '@memorylane/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { buildMediaQuery } from '../query/media-query.js';
import { CollectionRepo } from '../collections/collection-repo.js';
import { decorateMedia } from './decorate-media.js';
import { toMediaDto } from './mappers.js';
const numericId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const collectionId = z.union([z.literal('favorites'), numericId]);
const nameBody = z.object({ name: z.string().transform(s => s.normalize('NFKC').trim().replace(/\s+/g, ' ')).pipe(z.string().min(1).max(80).refine(s => !/[\x00-\x1f\x7f]/.test(s))) }).strict();
const idsBody = z.object({ mediaIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(1000) }).strict();
const addBody = z.union([idsBody, z.object({ folderId: z.number().int().positive(), recursive: z.boolean().default(false) }).strict()]);
const duplicate = (error: unknown) => (error as {
    code?: string;
})?.code === 'SQLITE_CONSTRAINT_UNIQUE';
export async function registerCollectionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
    const repo = new CollectionRepo(ctx.db), auth = { preHandler: app.requireAuth };
    app.get('/api/collections', auth, async (request, reply) => {
        const raw = (request.query as { mediaId?: string }).mediaId;
        if (raw === undefined)
            return repo.list();
        const mediaId = numericId.safeParse(raw);
        if (!mediaId.success)
            return reply.code(400).send({ error: 'Invalid media ID' });
        return repo.list(mediaId.data);
    });
    app.post('/api/collections', auth, async (request, reply) => {
        const body = nameBody.safeParse(request.body);
        if (!body.success)
            return reply.code(400).send({ error: 'Invalid collection name' });
        try {
            return reply.code(201).send(repo.create(body.data.name));
        }
        catch (e) {
            if (duplicate(e))
                return reply.code(409).send({ error: 'A collection with that name already exists' });
            throw e;
        }
    });
    app.get('/api/collections/:id/media', auth, async (request, reply) => {
        const id = collectionId.safeParse((request.params as {
            id: string;
        }).id), query = paginationQuerySchema.safeParse(request.query);
        if (!id.success || !query.success)
            return reply.code(400).send({ error: 'Invalid request' });
        if (!repo.exists(id.data))
            return reply.code(404).send({ error: 'Collection not found' });
        const result = repo.media(id.data, query.data.offset, query.data.limit);
        return { ...result, items: decorateMedia(ctx, result.items.map(toMediaDto)) };
    });
    app.patch('/api/collections/:id', auth, async (request, reply) => {
        const id = numericId.safeParse((request.params as {
            id: string;
        }).id), body = nameBody.safeParse(request.body);
        if (!id.success || !body.success)
            return reply.code(400).send({ error: 'Invalid request' });
        if (!repo.exists(id.data))
            return reply.code(404).send({ error: 'Collection not found' });
        try {
            repo.rename(id.data, body.data.name);
            return { ok: true };
        }
        catch (e) {
            if (duplicate(e))
                return reply.code(409).send({ error: 'A collection with that name already exists' });
            throw e;
        }
    });
    app.delete('/api/collections/:id', auth, async (request, reply) => {
        const id = numericId.safeParse((request.params as {
            id: string;
        }).id);
        if (!id.success)
            return reply.code(400).send({ error: 'Invalid request' });
        if (!repo.exists(id.data))
            return reply.code(404).send({ error: 'Collection not found' });
        repo.delete(id.data);
        return { ok: true };
    });
    app.post('/api/collections/:id/members', auth, async (request, reply) => {
        const id = numericId.safeParse((request.params as {
            id: string;
        }).id), body = addBody.safeParse(request.body);
        if (!id.success || !body.success)
            return reply.code(400).send({ error: 'Invalid request' });
        if (!repo.exists(id.data))
            return reply.code(404).send({ error: 'Collection not found' });
        if ('mediaIds' in body.data) {
            const added=repo.add(id.data,{kind:'ids',ids:body.data.mediaIds});
            const apple=body.data.mediaIds.filter(mediaId=>!!ctx.db.prepare("SELECT 1 FROM media JOIN collection_media c ON c.media_id=media.id WHERE media.id=? AND c.collection_id=? AND source_kind='apple-photos'").get(mediaId,id.data));
            ctx.applePreparation?.enqueue(apple);
            return {added};
        }
        if (!ctx.db.prepare("SELECT id FROM folders WHERE id=? AND status='active'").get(body.data.folderId))
            return reply.code(404).send({ error: 'Folder not found' });
        const scope = { kind: 'folder' as const, folderId: body.data.folderId, recursive: body.data.recursive };
        const q = buildMediaQuery({ scope });
        const apple = ctx.db.prepare(`${q.cte} SELECT media.id FROM media ${q.joins} WHERE ${q.where} AND media.source_kind='apple-photos' AND NOT EXISTS(SELECT 1 FROM collection_media cm WHERE cm.media_id=media.id AND cm.collection_id=?)`).all(...q.bindings, id.data) as {id:number}[];
        const added = repo.add(id.data, scope);
        for (let offset=0; offset<apple.length; offset+=1000) ctx.applePreparation?.enqueue(apple.slice(offset,offset+1000).map(row=>row.id));
        return { added };
    });
    app.delete('/api/collections/:id/members', auth, async (request, reply) => {
        const id = numericId.safeParse((request.params as {
            id: string;
        }).id), body = idsBody.safeParse(request.body);
        if (!id.success || !body.success)
            return reply.code(400).send({ error: 'Invalid request' });
        if (!repo.exists(id.data))
            return reply.code(404).send({ error: 'Collection not found' });
        return { removed: repo.remove(id.data, body.data.mediaIds) };
    });
}
