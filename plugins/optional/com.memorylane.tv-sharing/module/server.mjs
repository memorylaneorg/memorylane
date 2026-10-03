import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { normalizeIP } from './network.mjs';
import { CD, CM, parseAction, soapResponse, fault, didl, deviceDescription, serviceDescription, escapeXML } from './protocol.mjs';
const number = value => { if (!/^\d{1,10}$/.test(value ?? ''))
    throw Error('Invalid number'); const n = Number(value); if (n > 0xffffffff)
    throw Error('Invalid number'); return n; };
export async function startServer({ address, port, uuid, name, admitPeer, adapter }) {
    let base, closed = false, active = 0, updateId = 0;
    const subscribers = new Map();
    const xml = (res, text, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(text) }); res.end(text); };
    const properties = service => service === 'ContentDirectory' ? { SystemUpdateID: updateId } : { SourceProtocolInfo: 'http-get:*:image/jpeg:*', SinkProtocolInfo: '', CurrentConnectionIDs: '0' };
    function notify(sub) {
        if (closed)
            return;
        const body = `<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">${Object.entries(properties(sub.service)).map(([k, v]) => `<e:property><${k}>${escapeXML(v)}</${k}></e:property>`).join('')}</e:propertyset>`;
        const req = http.request(sub.callback, { method: 'NOTIFY', timeout: 2000, headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(body), NT: 'upnp:event', NTS: 'upnp:propchange', SID: sub.sid, SEQ: sub.seq++ } }, res => res.resume());
        req.on('timeout', () => req.destroy());
        req.on('error', () => { });
        req.end(body);
    }
    const server = http.createServer(async (req, res) => {
        if (closed || !admitPeer(req.socket.remoteAddress)) {
            res.writeHead(403).end();
            return;
        }
        if (active >= 16) {
            res.writeHead(503).end();
            return;
        }
        active++;
        try {
            const url = new URL(req.url, 'http://localhost');
            const service = /^\/(ContentDirectory|ConnectionManager)\/(control|events)$/.exec(url.pathname);
            if (req.method === 'GET' && url.pathname === '/description.xml')
                return xml(res, deviceDescription(uuid, name, base));
            const scpd = /^\/(ContentDirectory|ConnectionManager)\.xml$/.exec(url.pathname);
            if (req.method === 'GET' && scpd)
                return xml(res, serviceDescription(scpd[1]));
            if (service?.[2] === 'events') {
                const peer = normalizeIP(req.socket.remoteAddress), sid = req.headers.sid;
                if (req.method === 'UNSUBSCRIBE') {
                    const sub = subscribers.get(sid);
                    if (!sub || sub.peer !== peer || sub.service !== service[1]) {
                        res.writeHead(412).end();
                        return;
                    }
                    subscribers.delete(sid);
                    res.writeHead(200).end();
                    return;
                }
                if (req.method !== 'SUBSCRIBE') {
                    res.writeHead(405).end();
                    return;
                }
                let sub = subscribers.get(sid);
                if (sid) {
                    if (!sub || sub.peer !== peer || sub.service !== service[1] || req.headers.callback || req.headers.nt) {
                        res.writeHead(412).end();
                        return;
                    }
                }
                else {
                    if (req.headers.nt !== 'upnp:event' || subscribers.size >= 32) {
                        res.writeHead(412).end();
                        return;
                    }
                    const match = /^<([^<>]+)>$/.exec(req.headers.callback ?? '');
                    let callback;
                    try {
                        callback = new URL(match?.[1]);
                    }
                    catch {
                        res.writeHead(412).end();
                        return;
                    }
                    if (callback.protocol !== 'http:' || callback.username || callback.password || callback.hash || callback.hostname !== peer || !admitPeer(callback.hostname)) {
                        res.writeHead(412).end();
                        return;
                    }
                    sub = { sid: `uuid:${randomUUID()}`, peer, callback, service: service[1], seq: 0 };
                    subscribers.set(sub.sid, sub);
                }
                sub.expires = Date.now() + 1800000;
                res.writeHead(200, { SID: sub.sid, TIMEOUT: 'Second-1800' }).end();
                setImmediate(() => notify(sub));
                return;
            }
            if (service?.[2] === 'control' && req.method === 'POST') {
                let size = 0;
                const chunks = [];
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 32768) {
                        res.writeHead(413).end();
                        return;
                    }
                    chunks.push(chunk);
                }
                let action;
                try {
                    action = parseAction(Buffer.concat(chunks).toString('utf8'));
                }
                catch {
                    return xml(res, fault(402, 'Invalid Args'), 500);
                }
                const expected = service[1] === 'ContentDirectory' ? CD : CM;
                if (action.service !== expected || (req.headers.soapaction && req.headers.soapaction !== `"${expected}#${action.name}"`))
                    return xml(res, fault(401, 'Invalid Action'), 500);
                const { name: method, args } = action;
                let fields;
                if (expected === CD) {
                    if (method === 'Browse') {
                        let start, count;
                        try {
                            start = number(args.StartingIndex);
                            count = number(args.RequestedCount);
                            if (!['BrowseMetadata', 'BrowseDirectChildren'].includes(args.BrowseFlag) || typeof args.ObjectID !== 'string' || args.ObjectID.length > 256)
                                throw Error();
                        }
                        catch {
                            return xml(res, fault(402, 'Invalid Args'), 500);
                        }
                        if (args.SortCriteria && !['+dc:title', '-dc:title'].includes(args.SortCriteria))
                            return xml(res, fault(709, 'Unsupported sort criteria'), 500);
                        const data = await adapter.browse({ objectId: args.ObjectID, flag: args.BrowseFlag, start, count: Math.min(count || 100, 100), sort: args.SortCriteria || '+dc:title' });
                        updateId = data.updateId >>> 0;
                        fields = { Result: didl(data.items, base), NumberReturned: data.items.length, TotalMatches: data.total, UpdateID: updateId };
                    }
                    else if (method === 'GetSearchCapabilities')
                        fields = { SearchCaps: '' };
                    else if (method === 'GetSortCapabilities')
                        fields = { SortCaps: 'dc:title' };
                    else if (method === 'GetSystemUpdateID')
                        fields = { Id: updateId };
                }
                else {
                    if (method === 'GetProtocolInfo')
                        fields = { Source: 'http-get:*:image/jpeg:*', Sink: '' };
                    else if (method === 'GetCurrentConnectionIDs')
                        fields = { ConnectionIDs: '0' };
                    else if (method === 'GetCurrentConnectionInfo' && args.ConnectionID === '0')
                        fields = { RcsID: -1, AVTransportID: -1, ProtocolInfo: 'http-get:*:image/jpeg:*', PeerConnectionManager: '', PeerConnectionID: -1, Direction: 'Output', Status: 'OK' };
                }
                return fields ? xml(res, soapResponse(expected, method, fields)) : xml(res, fault(401, 'Invalid Action'), 500);
            }
            const photo = /^\/images\/([^/]+)$/.exec(url.pathname);
            if (photo && ['GET', 'HEAD'].includes(req.method)) {
                const profile = url.searchParams.get('profile') ?? 'display';
                if (!['display', 'thumbnail'].includes(profile)) {
                    res.writeHead(400).end();
                    return;
                }
                const image = await adapter.image(decodeURIComponent(photo[1]), profile);
                const bytes = Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes, 'base64');
                if (bytes.length > 16 * 1024 * 1024 || image.contentType !== 'image/jpeg')
                    throw Error('Invalid image');
                res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=1', 'transferMode.dlna.org': 'Interactive' });
                res.end(req.method === 'HEAD' ? undefined : bytes);
                return;
            }
            res.writeHead(404).end();
        }
        catch {
            if (!res.headersSent)
                res.writeHead(404);
            res.end();
        }
        finally {
            active--;
        }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 5000;
    server.maxHeadersCount = 32;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, address, resolve); });
    base = `http://${address}:${server.address().port}`;
    const timer = setInterval(() => { for (const [id, s] of subscribers)
        if (s.expires < Date.now())
            subscribers.delete(id); }, 30000);
    timer.unref();
    return { port: server.address().port, base, update(id) { if (id !== updateId) {
            updateId = id >>> 0;
            for (const s of subscribers.values())
                if (s.service === 'ContentDirectory')
                    notify(s);
        } }, async stop() { closed = true; clearInterval(timer); subscribers.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
