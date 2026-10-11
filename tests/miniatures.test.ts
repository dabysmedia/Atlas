import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Miniatures } from '../client/src/map3d/miniatures';
import type { Token } from '../client/src/types';

const token=(id:string):Token=>({id,worldId:'world',mapId:'map',hexId:id,kind:'unit',name:id,factionId:null,campaignId:null,settlementId:null,color:null,icon:null,visibleToPlayers:true,data:{},mainParty:false,modelId:'model',trail:[]});
function fixture(){
  const mini=new Miniatures(),geometry=new THREE.BoxGeometry(1,1,1),material=new THREE.MeshStandardMaterial({color:'#794a32',emissive:'#123456',emissiveIntensity:.3}),asset=new THREE.Group();asset.add(new THREE.Mesh(geometry,material));
  (mini as unknown as {assets:Map<string,THREE.Object3D>}).assets.set('world/model',asset);
  const update=(tokens:Token[],hovered:string|null=null)=>mini.update(tokens,t=>({x:t.id==='a'?0:100,y:0}),()=>0,()=>{}, {now:1000,hovered,selected:null,dragging:null,still:false});
  return {mini,geometry,material,update};
}
describe('miniature interaction',()=>{
  it('highlights only the silhouette without mutating the original material',()=>{
    const {mini,material,update}=fixture();const original={color:material.color.getHex(),emissive:material.emissive.getHex(),intensity:material.emissiveIntensity};
    update([token('a')]);expect(mini.group.children[0].children[1].visible).toBe(false);
    update([token('a')],'a');expect(mini.group.children[0].children[1].visible).toBe(true);
    expect({color:material.color.getHex(),emissive:material.emissive.getHex(),intensity:material.emissiveIntensity}).toEqual(original);
    update([token('a')]);expect(mini.group.children[0].children[1].visible).toBe(false);mini.dispose();
  });
  it('picks model volumes without raycasting triangles, including scaled interior scenes',()=>{
    const {mini,update}=fixture();update([token('a'),token('b')]);
    const ray=(mini as unknown as {ray:THREE.Raycaster}).ray,triangles=vi.spyOn(ray,'intersectObjects');
    for(const scale of [1,.065]){
      mini.group.scale.setScalar(scale);const e=mini.extent('a')!,camera=new THREE.OrthographicCamera(-100*scale,100*scale,100*scale,-100*scale,.01,1000);
      const center=new THREE.Vector3(e.x*scale,(e.foot+e.height/2)*scale,e.y*scale);camera.position.copy(center).add(new THREE.Vector3(0,0,200*scale));camera.lookAt(center);camera.updateMatrixWorld();
      expect(mini.hit(500,500,1000,1000,camera)).toBe('a');
    }
    expect(triangles).not.toHaveBeenCalled();mini.group.visible=false;expect(mini.hit(500,500,1000,1000,new THREE.Camera())).toBeUndefined();mini.dispose();
  });
  it('retains shared model resources when one token disappears and releases them on teardown',()=>{
    const {mini,geometry,material,update}=fixture(),disposeGeometry=vi.spyOn(geometry,'dispose'),disposeMaterial=vi.spyOn(material,'dispose');
    update([token('a'),token('b')]);update([token('b')]);expect(disposeGeometry).not.toHaveBeenCalled();expect(disposeMaterial).not.toHaveBeenCalled();
    mini.dispose();expect(disposeGeometry).toHaveBeenCalledTimes(1);expect(disposeMaterial).toHaveBeenCalledTimes(1);
  });
});
