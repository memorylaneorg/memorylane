import { createRequire } from 'node:module';
const { DOMParser } = createRequire(import.meta.url)('../vendor/xmldom/lib/index.js');
export const CD = 'urn:schemas-upnp-org:service:ContentDirectory:1';
export const CM = 'urn:schemas-upnp-org:service:ConnectionManager:1';
export const DEVICE = 'urn:schemas-upnp-org:device:MediaServer:1';
export const escapeXML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const children = node => Array.from(node.childNodes).filter(n => n.nodeType === 1);
export function parseAction(xml) {
    if (Buffer.byteLength(xml) > 32768 || /<!DOCTYPE|<!ENTITY/i.test(xml))
        throw new Error('Invalid XML');
    const doc = new DOMParser({ onError() { throw new Error('Invalid XML'); } }).parseFromString(xml, 'application/xml');
    const envelope = doc.documentElement;
    if (envelope?.localName !== 'Envelope' || envelope.namespaceURI !== 'http://schemas.xmlsoap.org/soap/envelope/')
        throw new Error('Invalid envelope');
    const body = children(envelope).filter(n => n.localName === 'Body' && n.namespaceURI === envelope.namespaceURI);
    if (body.length !== 1 || children(body[0]).length !== 1)
        throw new Error('One action required');
    const action = children(body[0])[0], args = {};
    for (const node of children(action)) {
        if (Object.hasOwn(args, node.localName) || children(node).length)
            throw new Error('Invalid argument');
        Object.defineProperty(args, node.localName, { value: node.textContent, enumerable: true });
    }
    return { name: action.localName, service: action.namespaceURI, args };
}
export function soapResponse(service, name, fields) {
    return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${name}Response xmlns:u="${service}">${Object.entries(fields).map(([k, v]) => `<${k}>${escapeXML(v)}</${k}>`).join('')}</u:${name}Response></s:Body></s:Envelope>`;
}
export function fault(code = 501, message = 'Action Failed') {
    return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${escapeXML(message)}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
}
export function didl(items, base) {
    return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${items.map(i => {
        const attrs = `id="${escapeXML(i.id)}" parentID="${escapeXML(i.parentId)}" restricted="1"`;
        const title = `<dc:title>${escapeXML(i.title)}</dc:title>`;
        if (i.kind === 'container')
            return `<container ${attrs} searchable="0"${i.childCount == null ? '' : ` childCount="${i.childCount}"`}>${title}<upnp:class>object.container.storageFolder</upnp:class></container>`;
        const url = `${base}/images/${encodeURIComponent(i.id)}`;
        return `<item ${attrs}>${title}<upnp:class>object.item.imageItem.photo</upnp:class><upnp:albumArtURI>${escapeXML(url + '?profile=thumbnail')}</upnp:albumArtURI><res protocolInfo="http-get:*:image/jpeg:*"${i.width && i.height ? ` resolution="${i.width}x${i.height}"` : ''}>${escapeXML(url)}</res></item>`;
    }).join('')}</DIDL-Lite>`;
}
export function deviceDescription(uuid, name, base) {
    return `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><URLBase>${base}/</URLBase><device><deviceType>${DEVICE}</deviceType><friendlyName>${escapeXML(name)}</friendlyName><manufacturer>MemoryLane</manufacturer><modelName>TV Photo Sharing</modelName><modelNumber>1</modelNumber><UDN>${escapeXML(uuid)}</UDN><serviceList>${[[CD, 'ContentDirectory'], [CM, 'ConnectionManager']].map(([type, id]) => `<service><serviceType>${type}</serviceType><serviceId>urn:upnp-org:serviceId:${id}</serviceId><SCPDURL>/${id}.xml</SCPDURL><controlURL>/${id}/control</controlURL><eventSubURL>/${id}/events</eventSubURL></service>`).join('')}</serviceList></device></root>`;
}
const defs = {
    ContentDirectory: {
        states: { ObjectID: ['string', 'no'], BrowseFlag: ['string', 'no'], Filter: ['string', 'no'], Index: ['ui4', 'no'], Count: ['ui4', 'no'], SortCriteria: ['string', 'no'], Result: ['string', 'no'], SystemUpdateID: ['ui4', 'yes'], SearchCapabilities: ['string', 'no'], SortCapabilities: ['string', 'no'] },
        actions: { Browse: [['ObjectID', 'in', 'ObjectID'], ['BrowseFlag', 'in', 'BrowseFlag'], ['Filter', 'in', 'Filter'], ['StartingIndex', 'in', 'Index'], ['RequestedCount', 'in', 'Count'], ['SortCriteria', 'in', 'SortCriteria'], ['Result', 'out', 'Result'], ['NumberReturned', 'out', 'Count'], ['TotalMatches', 'out', 'Count'], ['UpdateID', 'out', 'SystemUpdateID']], GetSearchCapabilities: [['SearchCaps', 'out', 'SearchCapabilities']], GetSortCapabilities: [['SortCaps', 'out', 'SortCapabilities']], GetSystemUpdateID: [['Id', 'out', 'SystemUpdateID']] }
    },
    ConnectionManager: {
        states: { SourceProtocolInfo: ['string', 'yes'], SinkProtocolInfo: ['string', 'yes'], CurrentConnectionIDs: ['string', 'yes'], ConnectionID: ['i4', 'no'], RcsID: ['i4', 'no'], AVTransportID: ['i4', 'no'], ProtocolInfo: ['string', 'no'], PeerConnectionManager: ['string', 'no'], PeerConnectionID: ['i4', 'no'], Direction: ['string', 'no'], Status: ['string', 'no'] },
        actions: { GetProtocolInfo: [['Source', 'out', 'SourceProtocolInfo'], ['Sink', 'out', 'SinkProtocolInfo']], GetCurrentConnectionIDs: [['ConnectionIDs', 'out', 'CurrentConnectionIDs']], GetCurrentConnectionInfo: [['ConnectionID', 'in', 'ConnectionID'], ...['RcsID', 'AVTransportID', 'ProtocolInfo', 'PeerConnectionManager', 'PeerConnectionID', 'Direction', 'Status'].map(k => [k, 'out', k])] }
    }
};
export function serviceDescription(name) {
    const d = defs[name];
    if (!d)
        throw new Error('Unknown service');
    return `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>${Object.entries(d.actions).map(([name, args]) => `<action><name>${name}</name><argumentList>${args.map(([n, dir, state]) => `<argument><name>${n}</name><direction>${dir}</direction><relatedStateVariable>${state}</relatedStateVariable></argument>`).join('')}</argumentList></action>`).join('')}</actionList><serviceStateTable>${Object.entries(d.states).map(([name, [type, event]]) => `<stateVariable sendEvents="${event}"><name>${name}</name><dataType>${type}</dataType></stateVariable>`).join('')}</serviceStateTable></scpd>`;
}
