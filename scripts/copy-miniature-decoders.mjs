import { mkdir, copyFile } from 'node:fs/promises';
for (const [kind, files] of Object.entries({ draco: ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'], basis: ['basis_transcoder.js', 'basis_transcoder.wasm'] })) {
  const source = `node_modules/three/examples/jsm/libs/${kind}${kind === 'draco' ? '/gltf' : ''}`;
  const dest = `client/public/codecs/${kind}`;
  await mkdir(dest, { recursive: true });
  for (const file of files) await copyFile(`${source}/${file}`, `${dest}/${file}`);
}
await copyFile('node_modules/three/LICENSE', 'client/public/codecs/THREE-LICENSE.txt');
