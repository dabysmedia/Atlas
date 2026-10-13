import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import sharp from 'sharp';

const {jobs}=JSON.parse(readFileSync('docs/settlement-art-prompts.json','utf8'));
assert.equal(jobs.length,42);
const hashes=new Set();let bytes=0;
for(const {key} of jobs){
  const file=`client/public/settlements/${key}.webp`,buffer=readFileSync(file),metadata=await sharp(buffer).metadata();
  assert.equal(metadata.width,512,file);assert.equal(metadata.height,512,file);assert.equal(metadata.hasAlpha,true,file);
  const {data,info}=await sharp(buffer).raw().toBuffer({resolveWithObject:true});
  let transparent=0,opaque=0;for(let n=3;n<data.length;n+=info.channels){if(data[n]===0)transparent++;if(data[n]>=240)opaque++;}
  assert(transparent>info.width*info.height*.05,`${file} has transparent surroundings`);
  assert(opaque>info.width*info.height*.3,`${file} has visible settlement art`);
  hashes.add(createHash('sha256').update(buffer).digest('hex'));bytes+=buffer.length;
}
assert.equal(hashes.size,42,'Every faction/type has its own image');
assert(!existsSync('client/public/settlements/canopy')||readdirSync('client/public/settlements/canopy').length===0,'Canopy uses existing trees');
console.log(JSON.stringify({assets:jobs.length,unique:hashes.size,width:512,height:512,transparent:true,bytes,canopyExcluded:true}));
