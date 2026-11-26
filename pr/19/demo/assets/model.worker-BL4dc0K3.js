const g={owner:"Owner","viewer-emissions":"Viewer with emissions",viewer:"Viewer (weather only)",service:"Service (reads CO₂)","service-no-co2":"Service (no CO₂)"};({...Object.fromEntries(Object.keys(g).map(s=>[s,s])),...Object.fromEntries(Object.entries(g).map(([s,e])=>[e.toLowerCase(),s]))});const p="svc-demo";function h(){const s=[{user:"owner",password:"demo-owner",role:"owner",kind:"user",component:"client"},{user:"friend",password:"demo-friend",role:"viewer",kind:"user",component:"client"},{user:"analyst",password:"demo-analyst",role:"viewer-emissions",kind:"user",component:"client"},{user:"svc-importer",password:p,role:"service",kind:"service",component:"importer"},{user:"svc-data-cleanse",password:p,role:"service",kind:"service",component:"models"},{user:"svc-summaries",password:p,role:"service",kind:"service",component:"models"},{user:"svc-analysis",password:p,role:"service",kind:"service",component:"models"},{user:"svc-new-model-1",password:p,role:"service-no-co2",kind:"service",component:"models"},{user:"svc-new-model-2",password:p,role:"service-no-co2",kind:"service",component:"models"}];return new Map(s.map(e=>[e.user,e]))}[...new Set([...h().values()].map(s=>s.password))].sort();function O(s){return h().get(s).password}async function S(s,e,t,o){o({stage:"runtime",detail:"loading the Python runtime (Pyodide)",pct:2});const l=await(await import(s+"pyodide.mjs")).loadPyodide({indexURL:s});o({stage:"packages",detail:`loading ${t.join(", ")}`,pct:8}),await l.loadPackage(t,{messageCallback:()=>{}});const n=await fetch(e);if(!n.ok)throw new Error(`could not fetch ${e}: ${n.status}`);return l.unpackArchive(await n.arrayBuffer(),"zip",{extractDir:"/home/pyodide"}),l.runPython(`import sys
for p in ('/home/pyodide', '/home/pyodide/models'):
    p in sys.path or sys.path.insert(0, p)`),l}let r=null,v=null,d="",f="",w={t:0,playing:!1},_=!1,y=[],E=0;const c=s=>self.postMessage(s);async function J(s,e,t,o){var m,u;const a=t!=null&&t.toJs?t.toJs({dict_converter:Object.fromEntries}):t,l=o!=null&&o.toJs?o.toJs():o??null;(m=t==null?void 0:t.destroy)==null||m.call(t),(u=o==null?void 0:o.destroy)==null||u.call(o);let n;try{n=await fetch(f+e,{method:s,headers:a,body:l,cache:"no-store"})}catch{return null}const i={};return n.headers.forEach((k,j)=>i[j.toLowerCase()]=k),[n.status,i,new Uint8Array(await n.arrayBuffer())]}async function $(s,e,t){var n,i;const o=e!=null&&e.toJs?e.toJs({dict_converter:Object.fromEntries}):e;(n=e==null?void 0:e.destroy)==null||n.call(e);let a;try{a=await fetch((t?f+"-internal":f)+s,{method:"GET",headers:o,cache:"no-store"})}catch{return null}const l=(i=a.body)==null?void 0:i.getReader();return{status:a.status,next:async()=>{if(!l)return null;try{const{done:m,value:u}=await l.read();return m?null:u??new Uint8Array}catch{return null}}}}function P(s,e,t,o,a){a||y.push({id:`${d}-${++E}`,t:w.t,src:s,dst:e,letter:"I",summary:t,content:o,model:d,chain:null,hop:0})}async function x(s,e,t,o,a){d=t,f=a,r=await S(s,e,t==="analysis"?["numpy","scikit-learn"]:["numpy"],i=>c({type:"progress",model:t,...i})),r.setStdout({batched:i=>c({type:"stdout",model:t,text:i})}),r.setStderr({batched:i=>c({type:"stderr",model:t,text:i})});const n={"data-cleanse":"data_cleanse",summaries:"summaries",analysis:"analysis"}[t]??`user_${t.replace(/-/g,"_")}`;o!=null&&(await r.loadPackagesFromImports(o),r.FS.writeFile(`/home/pyodide/models/${n}.py`,o)),r.globals.set("_http",J),r.globals.set("_open_stream",$),r.globals.set("_post_tap",P),r.globals.set("_user",`svc-${t}`),r.globals.set("_password",O(`svc-${t}`)),r.runPython(`
import importlib, json, csmodel
from js import Object
from pyodide.ffi import to_js

def _absent(x):  # JavaScript's null arrives as JsNull, not None
    return x is None or type(x).__name__ == "JsNull"

async def _transport(method, path, headers, body):
    r = await _http(method, path, to_js(headers, dict_converter=Object.fromEntries), to_js(body) if body else None)
    if _absent(r):
        raise csmodel.Unavailable("the data server does not answer")
    return int(r[0]), r[1].to_py(), r[2].to_bytes()

async def _stream(path, headers, internal=False):
    s = await _open_stream(path, to_js(headers, dict_converter=Object.fromEntries), bool(internal))
    if _absent(s):
        raise csmodel.Unavailable("the data server does not answer")
    async def chunks():
        while True:
            c = await s.next()
            if _absent(c):
                return
            yield c.to_bytes()
    return int(s.status), chunks()

_mod = importlib.import_module(${JSON.stringify(n)})
model = _mod.MODEL()
api = csmodel.Api(model.id, _transport, _user, _password, stream=_stream, now=lambda: _clock["t"], epoch=csmodel.SIM_EPOCH_UNIX)
_clock = {"t": 0.0}
def _tap(dst, summary, content=None):
    src, to = ("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")
    _post_tap(src, to, f"{model.id}: {summary}", json.dumps(content, default=str)[:4000], api.quiet)
api.tap = _tap
runner = csmodel.Runner(model, api)

async def tick(t, playing):
    _clock["t"] = t
    await runner.tick(playing)
    return [runner.phase, runner.detail, model.label]
`),c({type:"progress",model:t,stage:"ready",detail:"model loaded",pct:100}),b()}function N(s){setTimeout(b,s==="catching up"?0:250)}async function b(){if(!r||_)return;_=!0;let s="live";try{const e=await r.globals.get("tick")(w.t,w.playing),[t,o,a]=e.toJs();e.destroy(),s=t,v.postMessage({type:"phase",phase:s,detail:o,label:a}),c({type:"status",model:d,phase:s,detail:o})}catch(e){const t=String((e==null?void 0:e.message)??e).split(`
`).slice(-2).join(" ");v.postMessage({type:"phase",phase:"failed",detail:t,label:d}),c({type:"status",model:d,phase:"failed",detail:t})}finally{_=!1}y.length&&(c({type:"tap",messages:y}),y=[]),N(s)}self.onmessage=s=>{const e=s.data;e.type==="start"?(v=s.ports[0],x(e.pyodideUrl,e.pyZipUrl,e.model,e.code??null,e.apiUrl).catch(t=>c({type:"progress",model:e.model,stage:"error",detail:String(t),pct:0}))):e.type==="clock"&&(w={t:e.state.t,playing:e.state.playing})};
//# sourceMappingURL=model.worker-BL4dc0K3.js.map
