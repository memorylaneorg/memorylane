// TV-only virtual collections. Core still owns all folder/photo authorization.
const title = 'All photos — including subfolders';
const policyKey = revision => { const {updateId, ...policy} = JSON.parse(revision); return JSON.stringify(policy); };
const collection = id => ({id:`all:${id}`,parentId:`f:${id}`,kind:'container',title});
const collator = new Intl.Collator('en', {numeric:true,sensitivity:'base'});
export function createCatalogAdapter(callCore) {
    const cache = new Map();
    const pending = new Map();
    async function config() {
        const value = await callCore('tv.config', {});
        if (!value.enabled) { cache.clear(); throw Error('Sharing disabled'); }
        return JSON.stringify(value);
    }
    async function photos(folder) {
        const revision = await config();
        // Even cache hits re-authorize the containing folder.
        await callCore('tv.browse', {objectId:`f:${folder}`,flag:'BrowseMetadata',start:0,count:1,sort:'+dc:title'});
        const hit = cache.get(folder);
        if (hit && hit.revision === revision && Date.now()-hit.created < 30000) return hit.items;
        const key = `${folder}:${revision}`;
        if (pending.has(key)) return pending.get(key);
        if (pending.size >= 2) throw Error('Photo collection busy');
        const work = (async () => {
            const queue = [`f:${folder}`], visited = new Set(), found = new Map();
            const deadline = Date.now()+8000;
            let pages = 0;
            for (let index=0; index<queue.length; index++) {
                const id = queue[index];
                if (visited.has(id)) continue;
                visited.add(id);
                for (let start=0;;) {
                    if (++pages>2000 || Date.now()>deadline) throw Error('Photo collection too large; select a smaller folder');
                    const page = await callCore('tv.browse', {objectId:id,flag:'BrowseDirectChildren',start,count:100,sort:'+dc:title'});
                    for (const item of page.items) {
                        if (item.kind==='container') queue.push(item.id);
                        else if (item.kind==='photo') found.set(item.id,{...item,id:`all:${folder}:${item.id}`,parentId:`all:${folder}`});
                    }
                    if (found.size>40000 || queue.length>10000) throw Error('Photo collection too large; select a smaller folder');
                    start += page.items.length;
                    if (start>=page.total) break;
                    if (!page.items.length) throw Error('Photo collection changed; retry');
                }
            }
            // Core updateId also advances for unrelated analysis writes. Do not fail a
            // completed traversal for those; still reject any changed sharing policy.
            // The original revision remains on the cache, so later catalog changes
            // invalidate it, and every image is re-authorized by core.
            if (policyKey(await config()) !== policyKey(revision)) throw Error('Sharing policy changed; retry');
            const items = [...found.values()].sort((a,b)=>collator.compare(a.title,b.title)||a.id.localeCompare(b.id));
            if (cache.size>=8) cache.delete(cache.keys().next().value);
            cache.set(folder,{revision,items,created:Date.now()});
            return items;
        })();
        pending.set(key,work);
        try { return await work; } finally { pending.delete(key); }
    }
    async function alias(id) {
        const match = /^all:(\d+):p:(\d+)$/.exec(id);
        if (!match) throw Error('Invalid photo');
        const item = (await photos(match[1])).find(item=>item.id===id);
        if (!item) throw Error('Not shared');
        return {item,original:`p:${match[2]}`};
    }
    return {
        async browse(args) {
            const virtual = /^all:(\d+)$/.exec(args.objectId);
            if (virtual) {
                const items = await photos(virtual[1]);
                const {updateId} = await callCore('tv.config',{});
                if (args.flag==='BrowseMetadata') return {items:[{...collection(virtual[1]),childCount:items.length}],total:1,updateId};
                const sorted = args.sort==='-dc:title' ? [...items].reverse() : items;
                return {items:sorted.slice(args.start,args.start+args.count),total:items.length,updateId};
            }
            if (args.objectId.startsWith('all:')) {
                if (args.flag!=='BrowseMetadata') throw Error('Not a folder');
                const {item} = await alias(args.objectId);
                const {updateId} = await callCore('tv.config',{});
                return {items:[item],total:1,updateId};
            }
            const folder = /^f:(\d+)$/.exec(args.objectId);
            if (!folder || args.flag!=='BrowseDirectChildren') return callCore('tv.browse',args);
            // Place the shortcut first, preserving offsets for all ordinary items.
            const first = args.start===0;
            const result = await callCore('tv.browse',{...args,start:Math.max(0,args.start-1),count:Math.max(1,args.count-(first?1:0))});
            return {...result,total:result.total+1,items:first?[collection(folder[1]),...result.items.slice(0,args.count-1)]:result.items};
        },
        async image(id,profile) {
            const original = id.startsWith('all:') ? (await alias(id)).original : id;
            return callCore('tv.image',{id:original,profile});
        }
    };
}
