async function b(a,t,e,o){o({stage:"runtime",detail:"loading the Python runtime (Pyodide)",pct:2});const l=await(await import(a+"pyodide.mjs")).loadPyodide({indexURL:a});o({stage:"packages",detail:`loading ${e.join(", ")}`,pct:8}),await l.loadPackage(e,{messageCallback:()=>{}});const i=await fetch(t);if(!i.ok)throw new Error(`could not fetch ${t}: ${i.status}`);return l.unpackArchive(await i.arrayBuffer(),"zip",{extractDir:"/home/pyodide"}),l.runPython(`import sys
for p in ('/home/pyodide', '/home/pyodide/models'):
    p in sys.path or sys.path.insert(0, p)`),l}let s=null,r=null,d="",y={t:0,playing:!1},m=!1,_=0;const u=new Map;let c=[],w=0;const p=a=>self.postMessage(a);function k(a,t,e){const o=++_;return new Promise(n=>{var f;const l=setTimeout(()=>{u.delete(o),n({ok:!1,status:"down",error:"no answer from the data server"})},3e4);u.set(o,g=>{clearTimeout(l),n(g)});const i=t!=null&&t.toJs?t.toJs({dict_converter:Object.fromEntries,create_pyproxies:!1}):t;(f=t==null?void 0:t.destroy)==null||f.call(t),r.postMessage({id:o,op:a,args:i,quiet:e})})}function P(a,t,e,o,n){n||c.push({id:`${d}-${++w}`,t:y.t,src:a,dst:t,letter:"I",summary:e,content:o,model:d,chain:null,hop:0})}async function $(a,t,e,o){d=e,s=await b(a,t,e==="model-b"?["numpy","scikit-learn"]:["numpy"],i=>p({type:"progress",model:e,...i})),s.setStdout({batched:i=>p({type:"stdout",model:e,text:i})}),s.setStderr({batched:i=>p({type:"stderr",model:e,text:i})});const l={"data-cleanse":"data_cleanse","model-a":"model_a","model-b":"model_b"}[e]??`user_${e.replace(/-/g,"_")}`;o!=null&&(await s.loadPackagesFromImports(o),s.FS.writeFile(`/home/pyodide/models/${l}.py`,o)),s.globals.set("_rpc",k),s.globals.set("_post_tap",P),s.runPython(`
import importlib, csmodel
_mod = importlib.import_module(${JSON.stringify(l)})
model = _mod.MODEL()
api = csmodel.PortApi(model.id, _rpc, _post_tap)
runner = csmodel.Runner(model, api)

async def tick(t, playing):
    api.clock = {"t": t, "playing": playing}
    await runner.tick(playing)
    return [runner.phase, runner.detail, model.label]

def notify(js):
    runner.notify(js.to_py())
`),p({type:"progress",model:e,stage:"ready",detail:"model loaded",pct:100}),h()}function S(a){setTimeout(h,a==="catching up"?0:250)}async function h(){if(!s||m)return;m=!0;let a="live";try{const t=await s.globals.get("tick")(y.t,y.playing),[e,o,n]=t.toJs();t.destroy(),a=e,r.postMessage({type:"phase",phase:a,detail:o,label:n}),p({type:"status",model:d,phase:a,detail:o})}catch(t){const e=String((t==null?void 0:t.message)??t).split(`
`).slice(-2).join(" ");r.postMessage({type:"phase",phase:"failed",detail:e,label:d}),p({type:"status",model:d,phase:"failed",detail:e})}finally{m=!1}c.length&&(p({type:"tap",messages:c}),c=[]),S(a)}self.onmessage=a=>{const t=a.data;t.type==="start"?(r=a.ports[0],r.onmessage=e=>{var o;e.data.notify?s==null||s.globals.get("notify")(e.data.notify):(o=u.get(e.data.id))==null||o(e.data.reply),u.delete(e.data.id)},$(t.pyodideUrl,t.pyZipUrl,t.model,t.code??null).catch(e=>p({type:"progress",model:t.model,stage:"error",detail:String(e),pct:0}))):t.type==="clock"&&(y={t:t.state.t,playing:t.state.playing})};
//# sourceMappingURL=model.worker-BJsIKtl6.js.map
