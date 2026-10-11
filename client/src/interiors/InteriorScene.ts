import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { HeightField, rasterizeMesh } from '../map3d/heightfield';
import { Miniatures } from '../map3d/miniatures';
import type { Interior } from '../../../shared/interiors';
import type { Token } from '../types';
export class InteriorScene {
  readonly scene=new THREE.Scene(); readonly camera=new THREE.OrthographicCamera(); readonly renderer:THREE.WebGLRenderer;
  readonly controls:OrbitControls; readonly miniatures=new Miniatures();
  private field:HeightField; private ray=new THREE.Raycaster(); private ndc=new THREE.Vector2(); private disposed=false;
  private draco=new DRACOLoader().setDecoderPath('/codecs/draco/');private ktx:KTX2Loader;private grid:THREE.LineSegments|null=null;
  private model:THREE.Object3D|null=null; private width=1;private height=1;
  constructor(private canvas:HTMLCanvasElement,hud:HTMLCanvasElement,readonly interior:Interior) {
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.renderer.setClearColor('#0b151b');this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.ktx=new KTX2Loader().setTranscoderPath('/codecs/basis/').detectSupport(this.renderer);
    this.camera.near=.1;this.camera.far=10000;this.controls=new OrbitControls(this.camera,hud);this.controls.enableDamping=true;this.controls.mouseButtons.LEFT=null;this.controls.mouseButtons.RIGHT=THREE.MOUSE.ROTATE;this.controls.mouseButtons.MIDDLE=THREE.MOUSE.PAN;this.controls.minPolarAngle=.05;this.controls.maxPolarAngle=Math.PI/2-.08;this.controls.minZoom=.3;this.controls.maxZoom=8;
    this.scene.add(new THREE.HemisphereLight('#f5efdb','#33404d',2));const sun=new THREE.DirectionalLight('#fff6df',2.5);sun.position.set(-40,100,30);this.scene.add(sun);
    const plane=new THREE.Mesh(new THREE.PlaneGeometry(interior.cols*5,interior.rows*5),new THREE.MeshStandardMaterial({color:'#25313a',roughness:1}));plane.rotation.x=-Math.PI/2;plane.position.set(interior.cols*2.5,-.03,interior.rows*2.5);this.scene.add(plane);
    this.field=HeightField.empty(0,0,interior.cols*5,interior.rows*5,Math.min(401,interior.cols*4+1),Math.min(401,interior.rows*4+1));this.field.data.fill(0);this.makeGrid();
    this.miniatures.configure(this.renderer);this.miniatures.group.scale.setScalar(.065);this.scene.add(this.miniatures.group);this.reset();
  }
  private release(object:THREE.Object3D){object.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh&&!((o as THREE.LineSegments).isLineSegments))return;m.geometry.dispose();for(const material of [m.material].flat()){for(const value of Object.values(material))if(value instanceof THREE.Texture)value.dispose();material.dispose();}});}
  async load(){
    if(!this.interior.asset)return;
    const loader=new GLTFLoader().setDRACOLoader(this.draco).setKTX2Loader(this.ktx).setMeshoptDecoder(MeshoptDecoder);
    const gltf=await loader.loadAsync(`/api/worlds/${this.interior.worldId}/interiors/${this.interior.id}/asset?v=${this.interior.asset.version}`);
    if(this.disposed){this.release(gltf.scene);return;}
    const model=gltf.scene,box=new THREE.Box3().setFromObject(model),size=box.getSize(new THREE.Vector3());
    if(box.isEmpty()||!Number.isFinite(size.length())||size.x<.001||size.z<.001){this.release(model);throw Error('This GLB needs a visible map surface with width and depth.');}
    const scale=Math.min(this.interior.cols*5/size.x,this.interior.rows*5/size.z);model.scale.multiplyScalar(scale);model.position.multiplyScalar(scale);
    model.position.add(new THREE.Vector3(this.interior.cols*2.5-(box.min.x+box.max.x)*scale/2,-box.min.y*scale,this.interior.rows*2.5-(box.min.z+box.max.z)*scale/2));
    model.updateMatrixWorld(true);this.field.data.fill(0);model.traverse(o=>{const mesh=o as THREE.Mesh;if(mesh.isMesh)rasterizeMesh(mesh.geometry,mesh.matrixWorld,this.field);});this.field.updateRange();this.model=model;this.scene.add(model);this.makeGrid();this.reset();
  }
  private makeGrid(){
    if(this.grid){this.scene.remove(this.grid);this.release(this.grid);}
    const points:number[]=[],w=this.interior.cols*5,h=this.interior.rows*5;
    const line=(x0:number,y0:number,x1:number,y1:number,steps:number)=>{for(let i=0;i<steps;i++){const a=i/steps,b=(i+1)/steps;for(const t of [a,b]){const x=x0+(x1-x0)*t,y=y0+(y1-y0)*t;points.push(x,this.ground(x,y)+.05,y);}}};
    for(let x=0;x<=this.interior.cols;x++)line(x*5,0,x*5,h,Math.min(400,this.interior.rows*2));for(let y=0;y<=this.interior.rows;y++)line(0,y*5,w,y*5,Math.min(400,this.interior.cols*2));
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3));this.grid=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:'#bcb99e',transparent:true,opacity:.34}));this.scene.add(this.grid);
  }
  ground(x:number,y:number){return Math.max(0,this.field.at(x,y));}
  reset(){const w=this.interior.cols*5,h=this.interior.rows*5,size=Math.max(w,h);this.camera.zoom=1;this.camera.position.set(w/2,h*.1+size*.9,h/2+size*.7);this.controls.target.set(w/2,this.field.maxH*.2,h/2);this.resize(this.width,this.height);this.controls.update();}
  resize(w:number,h:number){this.width=w;this.height=h;this.renderer.setSize(w,h,false);const span=Math.max(this.interior.cols*5/(w/h),this.interior.rows*5)*.65;this.camera.left=-span*w/h;this.camera.right=span*w/h;this.camera.top=span;this.camera.bottom=-span;this.camera.updateProjectionMatrix();}
  project(x:number,y:number,lift=0){const p=new THREE.Vector3(x,this.ground(x,y)+lift,y).project(this.camera);return{x:(p.x+1)*this.width/2,y:(1-p.y)*this.height/2};}
  cell(x:number,y:number){this.ndc.set(x/this.width*2-1,1-y/this.height*2);this.ray.setFromCamera(this.ndc,this.camera);const p=this.field.raycast(this.ray.ray.origin,this.ray.ray.direction,0);return p?{x:Math.floor(p.x/5),y:Math.floor(p.z/5)}:null;}
  frame(now:number,parties:{token:Token;x:number;y:number}[]){this.controls.update();this.miniatures.update(parties.map(p=>p.token),t=>{const p=parties.find(p=>p.token.id===t.id)!;return{x:(p.x*5+2.5)/.065,y:(p.y*5+2.5)/.065};},(x,y)=>this.ground(x*.065,y*.065)/.065,()=>{}, {now,hovered:null,selected:null,dragging:null,still:false});this.renderer.render(this.scene,this.camera);}
  dispose(){this.disposed=true;this.controls.dispose();this.miniatures.dispose();this.scene.remove(this.miniatures.group);this.scene.traverse(o=>{if((o as THREE.Mesh).isMesh||(o as THREE.LineSegments).isLineSegments){const mesh=o as THREE.Mesh;mesh.geometry.dispose();for(const m of [mesh.material].flat()){for(const value of Object.values(m))if(value instanceof THREE.Texture)value.dispose();m.dispose();}}});this.draco.dispose();this.ktx.dispose();this.renderer.dispose();}
}
