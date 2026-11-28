const k={owner:"Owner","viewer-emissions":"Viewer with emissions",viewer:"Viewer (weather only)",service:"Service (reads CO₂)","service-no-co2":"Service (no CO₂)"};({...Object.fromEntries(Object.keys(k).map(s=>[s,s])),...Object.fromEntries(Object.entries(k).map(([s,t])=>[t.toLowerCase(),s]))});const p="svc-demo";function j(){const s=[{user:"owner",password:"demo-owner",role:"owner",kind:"user",component:"client"},{user:"friend",password:"demo-friend",role:"viewer",kind:"user",component:"client"},{user:"analyst",password:"demo-analyst",role:"viewer-emissions",kind:"user",component:"client"},{user:"svc-importer",password:p,role:"service",kind:"service",component:"importer"},{user:"svc-data-cleanse",password:p,role:"service",kind:"service",component:"models"},{user:"svc-summaries",password:p,role:"service",kind:"service",component:"models"},{user:"svc-analysis",password:p,role:"service",kind:"service",component:"models"},{user:"svc-new-model-1",password:p,role:"service-no-co2",kind:"service",component:"models"},{user:"svc-new-model-2",password:p,role:"service-no-co2",kind:"service",component:"models"}];return new Map(s.map(t=>[t.user,t]))}[...new Set([...j().values()].map(s=>s.password))].sort();function P(s){return j().get(s).password}async function $(s,t,e,o){o({stage:"runtime",detail:"loading the Python runtime (Pyodide)",pct:2});const i=await(await import(s+"pyodide.mjs")).loadPyodide({indexURL:s});o({stage:"packages",detail:`loading ${e.join(", ")}`,pct:8}),await i.loadPackage(e,{messageCallback:()=>{}});const n=await fetch(t);if(!n.ok)throw new Error(`could not fetch ${t}: ${n.status}`);return i.unpackArchive(await n.arrayBuffer(),"zip",{extractDir:"/home/pyodide"}),i.runPython(`import sys
for p in ('/home/pyodide', '/home/pyodide/models'):
    p in sys.path or sys.path.insert(0, p)`),i}let a=null,h=null,d="",y="",_=!1,v=!1;const O=[];function S(){w.length&&(c({type:"tap",messages:w}),w=[])}const u=()=>v?new Promise(s=>O.push(s)):Promise.resolve();let w=[],x=0;const c=s=>self.postMessage(s);async function N(s,t,e,o){var f,b;const r=e!=null&&e.toJs?e.toJs({dict_converter:Object.fromEntries}):e,i=o!=null&&o.toJs?o.toJs():o??null;(f=e==null?void 0:e.destroy)==null||f.call(e),(b=o==null?void 0:o.destroy)==null||b.call(o);let n,l;S(),await u();try{n=await fetch(y+t,{method:s,headers:r,body:i,cache:"no-store"}),l=new Uint8Array(await n.arrayBuffer())}catch{return await u(),null}await u();const m={};return n.headers.forEach((E,J)=>m[J.toLowerCase()]=E),[n.status,m,l]}async function R(s,t,e){var n,l;const o=t!=null&&t.toJs?t.toJs({dict_converter:Object.fromEntries}):t;(n=t==null?void 0:t.destroy)==null||n.call(t);let r;await u();try{r=await fetch((e?y+"-internal":y)+s,{method:"GET",headers:o,cache:"no-store"})}catch{return null}await u();const i=(l=r.body)==null?void 0:l.getReader();return{status:r.status,next:async()=>{if(!i)return null;try{const{done:m,value:f}=await i.read();return m?null:f??new Uint8Array}catch{return null}}}}function U(s,t,e,o,r){r||w.push({id:`${d}-${++x}`,t:Date.now()/1e3,src:s,dst:t,letter:"I",summary:e,content:o,model:d,chain:null,hop:0})}async function A(s,t,e,o,r){d=e,y=r,a=await $(s,t,e==="analysis"?["numpy","scikit-learn"]:["numpy"],l=>c({type:"progress",model:e,...l})),a.setStdout({batched:l=>c({type:"stdout",model:e,text:l})}),a.setStderr({batched:l=>c({type:"stderr",model:e,text:l})});const n={"data-cleanse":"data_cleanse",summaries:"summaries",analysis:"analysis"}[e]??`user_${e.replace(/-/g,"_")}`;o!=null&&(await a.loadPackagesFromImports(o),a.FS.writeFile(`/home/pyodide/models/${n}.py`,o)),a.globals.set("_http",N),a.globals.set("_open_stream",R),a.globals.set("_post_tap",U),a.globals.set("_user",`svc-${e}`),a.globals.set("_password",P(`svc-${e}`)),a.runPython(`
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
api = csmodel.Api(model.id, _transport, _user, _password, stream=_stream)
def _tap(dst, summary, content=None):
    src, to = ("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")
    _post_tap(src, to, f"{model.id}: {summary}", json.dumps(content, default=str)[:4000], False)  # drawn, processing included (D-321)
api.tap = _tap
runner = csmodel.Runner(model, api)

async def tick():
    await runner.step()
    # Whether a run is in hand: a model only waiting for its inputs steps at the idle pace (D-342).
    return [runner.phase, runner.detail, model.label, runner.current is not None]
`),c({type:"progress",model:e,stage:"ready",detail:"model loaded",pct:100}),g()}function C(s){setTimeout(g,s?0:250)}async function g(){if(!a||_)return;if(v)return void setTimeout(g,100);_=!0;let s="live",t=!1;try{const e=await a.globals.get("tick")(),[o,r,i,n]=e.toJs();e.destroy(),s=o,t=o==="processing"&&n===!0,h.postMessage({type:"phase",phase:s,detail:r,label:i}),c({type:"status",model:d,phase:s,detail:r})}catch(e){const o=String((e==null?void 0:e.message)??e).split(`
`).slice(-2).join(" ");h.postMessage({type:"phase",phase:"failed",detail:o,label:d}),c({type:"status",model:d,phase:"failed",detail:o})}finally{_=!1}S(),C(t)}self.onmessage=s=>{const t=s.data;if(t.type==="hold"){if(v=!!t.on,!v)for(const e of O.splice(0))e()}else t.type==="start"&&(h=s.ports[0],A(t.pyodideUrl,t.pyZipUrl,t.model,t.code??null,t.apiUrl).catch(e=>c({type:"progress",model:t.model,stage:"error",detail:String(e),pct:0})))};
//# sourceMappingURL=model.worker-oAn3diHH.js.map
