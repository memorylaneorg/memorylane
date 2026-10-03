import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateIPv4, sameSubnet } from '../module/network.mjs';
import { parseAction, didl, deviceDescription } from '../module/protocol.mjs';
const soap = body => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">${body}</u:Browse></s:Body></s:Envelope>`;
test('admit only the selected private IPv4 subnet', () => {
    assert.equal(privateIPv4('192.168.1.2'), true);
    assert.equal(privateIPv4('8.8.8.8'), false);
    assert.equal(privateIPv4('127.0.0.1'), false);
    assert.equal(sameSubnet('::ffff:192.168.1.5', { address: '192.168.1.2', netmask: '255.255.255.0' }), true);
    assert.equal(sameSubnet('192.168.2.5', { address: '192.168.1.2', netmask: '255.255.255.0' }), false);
});
test('parse a namespaced Browse action, decoding XML entities', () => {
    const a = parseAction(soap('<ObjectID>f&amp;1</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><StartingIndex>0</StartingIndex><RequestedCount>10</RequestedCount><Filter>*</Filter><SortCriteria></SortCriteria>'));
    assert.equal(a.name, 'Browse');
    assert.equal(a.args.ObjectID, 'f&1');
});
test('reject malformed XML, DTD, and more than one action', () => {
    for (const xml of ['<!DOCTYPE x><x/>', '<broken>', soap('<x>'), '<!ENTITY x "test">' + soap('')])
        assert.throws(() => parseAction(xml));
});
test('escape titles and produce photo class and JPEG resources', () => {
    const xml = didl([{ id: 'p:1', parentId: 'f:1', title: 'A < B & C', kind: 'photo', width: 1920, height: 1080 }], 'http://192.168.1.2:4283');
    assert.match(xml, /A &lt; B &amp; C/);
    assert.match(xml, /object.item.imageItem.photo/);
    assert.match(xml, /image\/jpeg/);
    assert.match(xml, /1920x1080/);
    assert.match(deviceDescription('uuid:test', 'Family & Photos', 'http://192.168.1.2:4283'), /Family &amp; Photos/);
});
