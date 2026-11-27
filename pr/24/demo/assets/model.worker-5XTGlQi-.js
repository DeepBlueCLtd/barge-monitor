const v={owner:"Owner","viewer-emissions":"Viewer with emissions",viewer:"Viewer (weather only)",service:"Service (reads CO₂)","service-no-co2":"Service (no CO₂)"};({...Object.fromEntries(Object.keys(v).map(s=>[s,s])),...Object.fromEntries(Object.entries(v).map(([s,t])=>[t.toLowerCase(),s]))});const p="svc-demo";function g(){const s=[{user:"owner",password:"demo-owner",role:"owner",kind:"user",component:"client"},{user:"friend",password:"demo-friend",role:"viewer",kind:"user",component:"client"},{user:"analyst",password:"demo-analyst",role:"viewer-emissions",kind:"user",component:"client"},{user:"svc-importer",password:p,role:"service",kind:"service",component:"importer"},{user:"svc-data-cleanse",password:p,role:"service",kind:"service",component:"models"},{user:"svc-summaries",password:p,role:"service",kind:"service",component:"models"},{user:"svc-analysis",password:p,role:"service",kind:"service",component:"models"},{user:"svc-new-model-1",password:p,role:"service-no-co2",kind:"service",component:"models"},{user:"svc-new-model-2",password:p,role:"service-no-co2",kind:"service",component:"models"}];return new Map(s.map(t=>[t.user,t]))}[...new Set([...g().values()].map(s=>s.password))].sort();function j(s){return g().get(s).password}async function O(s,t,e,n){n({stage:"runtime",detail:"loading the Python runtime (Pyodide)",pct:2});const i=await(await import(s+"pyodide.mjs")).loadPyodide({indexURL:s});n({stage:"packages",detail:`loading ${e.join(", ")}`,pct:8}),await i.loadPackage(e,{messageCallback:()=>{}});const o=await fetch(t);if(!o.ok)throw new Error(`could not fetch ${t}: ${o.status}`);return i.unpackArchive(await o.arrayBuffer(),"zip",{extractDir:"/home/pyodide"}),i.runPython(`import sys
for p in ('/home/pyodide', '/home/pyodide/models'):
    p in sys.path or sys.path.insert(0, p)`),i}let a=null,_=null,d="",y="",w=!1,f=[],S=0;const c=s=>self.postMessage(s);async function E(s,t,e,n){var u,m;const r=e!=null&&e.toJs?e.toJs({dict_converter:Object.fromEntries}):e,i=n!=null&&n.toJs?n.toJs():n??null;(u=e==null?void 0:e.destroy)==null||u.call(e),(m=n==null?void 0:n.destroy)==null||m.call(n);let o;try{o=await fetch(y+t,{method:s,headers:r,body:i,cache:"no-store"})}catch{return null}const l={};return o.headers.forEach((b,k)=>l[k.toLowerCase()]=b),[o.status,l,new Uint8Array(await o.arrayBuffer())]}async function J(s,t,e){var o,l;const n=t!=null&&t.toJs?t.toJs({dict_converter:Object.fromEntries}):t;(o=t==null?void 0:t.destroy)==null||o.call(t);let r;try{r=await fetch((e?y+"-internal":y)+s,{method:"GET",headers:n,cache:"no-store"})}catch{return null}const i=(l=r.body)==null?void 0:l.getReader();return{status:r.status,next:async()=>{if(!i)return null;try{const{done:u,value:m}=await i.read();return u?null:m??new Uint8Array}catch{return null}}}}function $(s,t,e,n,r){r||f.push({id:`${d}-${++S}`,t:Date.now()/1e3,src:s,dst:t,letter:"I",summary:e,content:n,model:d,chain:null,hop:0})}async function x(s,t,e,n,r){d=e,y=r,a=await O(s,t,e==="analysis"?["numpy","scikit-learn"]:["numpy"],l=>c({type:"progress",model:e,...l})),a.setStdout({batched:l=>c({type:"stdout",model:e,text:l})}),a.setStderr({batched:l=>c({type:"stderr",model:e,text:l})});const o={"data-cleanse":"data_cleanse",summaries:"summaries",analysis:"analysis"}[e]??`user_${e.replace(/-/g,"_")}`;n!=null&&(await a.loadPackagesFromImports(n),a.FS.writeFile(`/home/pyodide/models/${o}.py`,n)),a.globals.set("_http",E),a.globals.set("_open_stream",J),a.globals.set("_post_tap",$),a.globals.set("_user",`svc-${e}`),a.globals.set("_password",j(`svc-${e}`)),a.runPython(`
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

_mod = importlib.import_module(${JSON.stringify(o)})
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
`),c({type:"progress",model:e,stage:"ready",detail:"model loaded",pct:100}),h()}function N(s){setTimeout(h,s?0:250)}async function h(){if(!a||w)return;w=!0;let s="live",t=!1;try{const e=await a.globals.get("tick")(),[n,r,i,o]=e.toJs();e.destroy(),s=n,t=n==="processing"&&o===!0,_.postMessage({type:"phase",phase:s,detail:r,label:i}),c({type:"status",model:d,phase:s,detail:r})}catch(e){const n=String((e==null?void 0:e.message)??e).split(`
`).slice(-2).join(" ");_.postMessage({type:"phase",phase:"failed",detail:n,label:d}),c({type:"status",model:d,phase:"failed",detail:n})}finally{w=!1}f.length&&(c({type:"tap",messages:f}),f=[]),N(t)}self.onmessage=s=>{const t=s.data;t.type==="start"&&(_=s.ports[0],x(t.pyodideUrl,t.pyZipUrl,t.model,t.code??null,t.apiUrl).catch(e=>c({type:"progress",model:t.model,stage:"error",detail:String(e),pct:0})))};
//# sourceMappingURL=model.worker-5XTGlQi-.js.map
