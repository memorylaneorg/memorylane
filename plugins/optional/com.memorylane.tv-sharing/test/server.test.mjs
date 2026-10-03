import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../module/server.mjs';
const body = (n = '1') => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><StartingIndex>0</StartingIndex><RequestedCount>${n}</RequestedCount><Filter>*</Filter><SortCriteria/></u:Browse></s:Body></s:Envelope>`;
test('browse, photo, HEAD, revocation and invalid requests', async () => {
    let allowed = true;
    const server = await startServer({ address: '127.0.0.1', port: 0, uuid: 'uuid:test', name: 'Test', admitPeer: () => true, adapter: { async browse() { return { items: [{ id: 'p1', parentId: '0', kind: 'photo', title: 'Hello' }], total: 1, updateId: 1 }; }, async image() { if (!allowed)
                throw Error('denied'); return { bytes: Buffer.from('jpeg'), contentType: 'image/jpeg' }; } } });
    const base = `http://127.0.0.1:${server.port}`;
    try {
        const res = await fetch(base + '/ContentDirectory/control', { method: 'POST', body: body() });
        assert.equal(res.status, 200);
        assert.match(await res.text(), /TotalMatches>1/);
        assert.equal((await fetch(base + '/images/p1')).status, 200);
        assert.equal((await fetch(base + '/images/p1', { method: 'HEAD' })).headers.get('content-length'), '4');
        allowed = false;
        assert.equal((await fetch(base + '/images/p1')).status, 404);
        assert.equal((await fetch(base + '/ContentDirectory/control', { method: 'POST', body: body('-1') })).status, 500);
        assert.equal((await fetch(base + '/ContentDirectory/events', { method: 'SUBSCRIBE', headers: { CALLBACK: '<http://8.8.8.8/x>', NT: 'upnp:event' } })).status, 412);
    }
    finally {
        await server.stop();
    }
    await assert.rejects(fetch(base + '/description.xml'));
});
test('peer admission protects descriptions as well as photos', async () => {
    const server = await startServer({ address: '127.0.0.1', port: 0, uuid: 'uuid:test', name: 'Test', admitPeer: () => false, adapter: {} });
    try {
        assert.equal((await fetch(`http://127.0.0.1:${server.port}/description.xml`)).status, 403);
    }
    finally {
        await server.stop();
    }
});
