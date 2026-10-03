import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import pino from 'pino';
const mock=vi.hoisted(()=>({extract:vi.fn()}));
vi.mock('exiftool-vendored',()=>({ExifTool:class {version=async()=> 'test'; extractBinaryTagToBuffer=mock.extract;}}));
import {checkExifToolAvailable,extractLargestEmbeddedPreview} from '../../src/media/exiftool-client.js';
it('chooses pixel area rather than the first embedded tag or compressed byte size',async()=>{
 const small=await sharp({create:{width:160,height:120,channels:3,background:'red'}}).jpeg().toBuffer();
 const large=await sharp({create:{width:2000,height:1500,channels:3,background:'blue'}}).jpeg().toBuffer();
 mock.extract.mockImplementation(async(tag:string)=>tag==='JpgFromRaw2'?small:tag==='PreviewImage'?large:null);
 await checkExifToolAvailable(pino({level:'silent'}));
 expect(await extractLargestEmbeddedPreview('/fixture.nef')).toEqual(large);
 expect(mock.extract).toHaveBeenCalledTimes(5);
});
