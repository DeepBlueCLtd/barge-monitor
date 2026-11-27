const v={owner:"Owner","viewer-emissions":"Viewer with emissions",viewer:"Viewer (weather only)",service:"Service (reads CO₂)","service-no-co2":"Service (no CO₂)"};({...Object.fromEntries(Object.keys(v).map(s=>[s,s])),...Object.fromEntries(Object.entries(v).map(([s,e])=>[e.toLowerCase(),s]))});const p="svc-demo";function g(){const s=[{user:"owner",password:"demo-owner",role:"owner",kind:"user",component:"client"},{user:"friend",password:"demo-friend",role:"viewer",kind:"user",component:"client"},{user:"analyst",password:"demo-analyst",role:"viewer-emissions",kind:"user",component:"client"},{user:"svc-importer",password:p,role:"service",kind:"service",component:"importer"},{user:"svc-data-cleanse",password:p,role:"service",kind:"service",component:"models"},{user:"svc-summaries",password:p,role:"service",kind:"service",component:"models"},{user:"svc-analysis",password:p,role:"service",kind:"service",component:"models"},{user:"svc-new-model-1",password:p,role:"service-no-co2",kind:"service",component:"models"},{user:"svc-new-model-2",password:p,role:"service-no-co2",kind:"service",component:"models"}];return new Map(s.map(e=>[e.user,e]))}[...new Set([...g().values()].map(s=>s.password))].sort();function O(s){return g().get(s).password}async function S(s,e,t,o){o({stage:"runtime",detail:"loading the Python runtime (Pyodide)",pct:2});const c=await(await import(s+"pyodide.mjs")).loadPyodide({indexURL:s});o({stage:"packages",detail:`loading ${t.join(", ")}`,pct:8}),await c.loadPackage(t,{messageCallback:()=>{}});const r=await fetch(e);if(!r.ok)throw new Error(`could not fetch ${e}: ${r.status}`);return c.unpackArchive(await r.arrayBuffer(),"zip",{extractDir:"/home/pyodide"}),c.runPython(`import sys
for p in ('/home/pyodide', '/home/pyodide/models'):
    p in sys.path or sys.path.insert(0, p)`),c}let n=null,_=null,d="",f="",h={t:0},w=!1,y=[],E=0;const l=s=>self.postMessage(s);async function J(s,e,t,o){var m,u;const a=t!=null&&t.toJs?t.toJs({dict_converter:Object.fromEntries}):t,c=o!=null&&o.toJs?o.toJs():o??null;(m=t==null?void 0:t.destroy)==null||m.call(t),(u=o==null?void 0:o.destroy)==null||u.call(o);let r;try{r=await fetch(f+e,{method:s,headers:a,body:c,cache:"no-store"})}catch{return null}const i={};return r.headers.forEach((k,j)=>i[j.toLowerCase()]=k),[r.status,i,new Uint8Array(await r.arrayBuffer())]}async function $(s,e,t){var r,i;const o=e!=null&&e.toJs?e.toJs({dict_converter:Object.fromEntries}):e;(r=e==null?void 0:e.destroy)==null||r.call(e);let a;try{a=await fetch((t?f+"-internal":f)+s,{method:"GET",headers:o,cache:"no-store"})}catch{return null}const c=(i=a.body)==null?void 0:i.getReader();return{status:a.status,next:async()=>{if(!c)return null;try{const{done:m,value:u}=await c.read();return m?null:u??new Uint8Array}catch{return null}}}}function x(s,e,t,o,a){a||y.push({id:`${d}-${++E}`,t:h.t,src:s,dst:e,letter:"I",summary:t,content:o,model:d,chain:null,hop:0})}async function P(s,e,t,o,a){d=t,f=a,n=await S(s,e,t==="analysis"?["numpy","scikit-learn"]:["numpy"],i=>l({type:"progress",model:t,...i})),n.setStdout({batched:i=>l({type:"stdout",model:t,text:i})}),n.setStderr({batched:i=>l({type:"stderr",model:t,text:i})});const r={"data-cleanse":"data_cleanse",summaries:"summaries",analysis:"analysis"}[t]??`user_${t.replace(/-/g,"_")}`;o!=null&&(await n.loadPackagesFromImports(o),n.FS.writeFile(`/home/pyodide/models/${r}.py`,o)),n.globals.set("_http",J),n.globals.set("_open_stream",$),n.globals.set("_post_tap",x),n.globals.set("_user",`svc-${t}`),n.globals.set("_password",O(`svc-${t}`)),n.runPython(`
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

_mod = importlib.import_module(${JSON.stringify(r)})
model = _mod.MODEL()
api = csmodel.Api(model.id, _transport, _user, _password, stream=_stream)
def _tap(dst, summary, content=None):
    src, to = ("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")
    _post_tap(src, to, f"{model.id}: {summary}", json.dumps(content, default=str)[:4000], api.quiet)
api.tap = _tap
runner = csmodel.Runner(model, api)

async def tick():
    await runner.step()
    return [runner.phase, runner.detail, model.label]
`),l({type:"progress",model:t,stage:"ready",detail:"model loaded",pct:100}),b()}function N(s){setTimeout(b,s==="processing"?0:250)}async function b(){if(!n||w)return;w=!0;let s="live";try{const e=await n.globals.get("tick")(),[t,o,a]=e.toJs();e.destroy(),s=t,_.postMessage({type:"phase",phase:s,detail:o,label:a}),l({type:"status",model:d,phase:s,detail:o})}catch(e){const t=String((e==null?void 0:e.message)??e).split(`
`).slice(-2).join(" ");_.postMessage({type:"phase",phase:"failed",detail:t,label:d}),l({type:"status",model:d,phase:"failed",detail:t})}finally{w=!1}y.length&&(l({type:"tap",messages:y}),y=[]),N(s)}self.onmessage=s=>{const e=s.data;e.type==="start"?(_=s.ports[0],P(e.pyodideUrl,e.pyZipUrl,e.model,e.code??null,e.apiUrl).catch(t=>l({type:"progress",model:e.model,stage:"error",detail:String(t),pct:0}))):e.type==="clock"&&(h={t:e.state.t})};
//# sourceMappingURL=model.worker-DpfTcQx-.js.map
