import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCatalogAdapter} from '../module/catalog.mjs';
const request=(objectId,start=0,count=100)=>({objectId,flag:'BrowseDirectChildren',start,count,sort:'+dc:title'});
function fixture(){
 let enabled=true,revision=1;
 const folders={'f:1':[{id:'f:2',kind:'container',title:'Child',parentId:'f:1'},{id:'p:1',kind:'photo',title:'Zulu',parentId:'f:1'}], 'f:2':Array.from({length:105},(_,i)=>({id:`p:${i+2}`,kind:'photo',title:`Photo ${String(i).padStart(3,'0')}`,parentId:'f:2'}))};
 const calls=[];
 const callCore=async(method,args)=>{
  calls.push([method,args]);
  if(method==='tv.config')return {enabled,updateId:revision};
  if(!enabled)throw Error('Sharing disabled');
  if(method==='tv.image')return {bytes:args.id};
  if(args.flag==='BrowseMetadata'){
   if(!folders[args.objectId])throw Error('Not shared');
   return {items:[{id:args.objectId,kind:'container',title:'Folder',parentId:'0'}],total:1,updateId:revision};
  }
  const items=folders[args.objectId];if(!items)throw Error('Not shared');
  return {items:items.slice(args.start,args.start+args.count),total:items.length,updateId:revision};
 };
 return {adapter:createCatalogAdapter(callCore),calls,revoke(){enabled=false;revision++;},folders,change(){revision++;}};
}
test('injects a virtual collection without skipping ordinary folder entries',async()=>{
 const {adapter}=fixture();
 assert.equal((await adapter.browse(request('f:1',0,1))).items[0].id,'all:1');
 assert.equal((await adapter.browse(request('f:1',1,1))).items[0].id,'f:2');
 assert.equal((await adapter.browse(request('f:1',2,1))).items[0].id,'p:1');
 assert.equal((await adapter.browse(request('f:1'))).total,3);
});
test('flattens nested pages and serves scoped photo aliases',async()=>{
 const {adapter}=fixture();
 const first=await adapter.browse(request('all:1',0,100));
 const last=await adapter.browse(request('all:1',100,100));
 assert.equal(first.total,106);assert.equal(first.items.length,100);assert.equal(last.items.length,6);
 assert.equal(new Set([...first.items,...last.items].map(i=>i.id)).size,106);
 assert.ok(first.items.every(i=>i.kind==='photo'&&i.parentId==='all:1'));
 assert.deepEqual(await adapter.image('all:1:p:1','display'),{bytes:'p:1'});
 await assert.rejects(adapter.image('all:2:p:1','display'));
 const meta=await adapter.browse({...request(first.items[0].id),flag:'BrowseMetadata'});
 assert.equal(meta.items[0].parentId,'all:1');
});
test('invalidates cached collections after policy changes and rejects revoked aliases',async()=>{
 const f=fixture();await f.adapter.browse(request('all:1'));
 f.folders['f:1']=f.folders['f:1'].filter(i=>i.id!=='f:2');f.change();
 assert.equal((await f.adapter.browse(request('all:1'))).total,1);
 await assert.rejects(f.adapter.image('all:1:p:2','display'));
 f.revoke();await assert.rejects(f.adapter.browse(request('all:1')));
 await assert.rejects(f.adapter.image('all:1:p:1','display'));
});

test('background database revisions do not abort an otherwise authorized traversal',async()=>{
 let revision=0;
 const adapter=createCatalogAdapter(async(method,args)=>{
  if(method==='tv.config')return {enabled:true,updateId:++revision,folders:[{id:1,recursive:true}]};
  if(args.flag==='BrowseMetadata')return {items:[{id:'f:1',kind:'container'}],total:1,updateId:revision};
  return {items:[{id:'p:1',kind:'photo',title:'One',parentId:'f:1'}],total:1,updateId:revision};
 });
 assert.equal((await adapter.browse(request('all:1'))).total,1);
});
test('a policy change during traversal still rejects the collection',async()=>{
 let calls=0;
 const adapter=createCatalogAdapter(async(method,args)=>{
  if(method==='tv.config')return {enabled:true,updateId:1,folders:[{id:++calls,recursive:true}]};
  return {items:args.flag==='BrowseMetadata'?[{id:'f:1',kind:'container'}]:[],total:args.flag==='BrowseMetadata'?1:0,updateId:1};
 });
 await assert.rejects(adapter.browse(request('all:1')),/policy changed/);
});
