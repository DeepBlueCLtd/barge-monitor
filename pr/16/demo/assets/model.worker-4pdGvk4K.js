async function b(s,e,t,a){a({stage:"runtime",detail:"loading the Python runtime (Pyodide)",pct:2});const p=await(await import(s+"pyodide.mjs")).loadPyodide({indexURL:s});a({stage:"packages",detail:`loading ${t.join(", ")}`,pct:8}),await p.loadPackage(t,{messageCallback:()=>{}});const o=await fetch(e);if(!o.ok)throw new Error(`could not fetch ${e}: ${o.status}`);return p.unpackArchive(await o.arrayBuffer(),"zip",{extractDir:"/home/pyodide"}),p.runPython(`import sys
for p in ('/home/pyodide', '/home/pyodide/models'):
    p in sys.path or sys.path.insert(0, p)`),p}let i=null,y=null,c="",h="",m={t:0,playing:!1},_={},u=!1,d=[],$=0;const r=s=>self.postMessage(s);async function v(s,e,t,a){var f,g;const n=t!=null&&t.toJs?t.toJs({dict_converter:Object.fromEntries}):t,p=a!=null&&a.toJs?a.toJs():a??null;(f=t==null?void 0:t.destroy)==null||f.call(t),(g=a==null?void 0:a.destroy)==null||g.call(a);let o;try{o=await fetch(h+e,{method:s,headers:n,body:p,cache:"no-store"})}catch{return null}const l={};return o.headers.forEach((k,j)=>l[j.toLowerCase()]=k),[o.status,l,new Uint8Array(await o.arrayBuffer())]}function P(s,e,t,a,n){n||d.push({id:`${c}-${++$}`,t:m.t,src:s,dst:e,letter:"I",summary:t,content:a,model:c,chain:null,hop:0})}async function S(s,e,t,a,n){c=t,h=n,i=await b(s,e,t==="analysis"?["numpy","scikit-learn"]:["numpy"],l=>r({type:"progress",model:t,...l})),i.setStdout({batched:l=>r({type:"stdout",model:t,text:l})}),i.setStderr({batched:l=>r({type:"stderr",model:t,text:l})});const o={"data-cleanse":"data_cleanse",summaries:"summaries",analysis:"analysis"}[t]??`user_${t.replace(/-/g,"_")}`;a!=null&&(await i.loadPackagesFromImports(a),i.FS.writeFile(`/home/pyodide/models/${o}.py`,a)),i.globals.set("_http",v),i.globals.set("_post_tap",P),i.runPython(`
import importlib, json, csmodel
from js import Object
from pyodide.ffi import to_js

async def _transport(method, path, headers, body):
    r = await _http(method, path, to_js(headers, dict_converter=Object.fromEntries), to_js(body) if body else None)
    if r is None:
        raise csmodel.Unavailable("the data server does not answer")
    return int(r[0]), r[1].to_py(), r[2].to_bytes()

_mod = importlib.import_module(${JSON.stringify(o)})
model = _mod.MODEL()
api = csmodel.Api(model.id, _transport)
def _tap(dst, summary, content=None):
    src, to = ("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")
    _post_tap(src, to, f"{model.id}: {summary}", json.dumps(content, default=str)[:4000], api.quiet)
api.tap = _tap
runner = csmodel.Runner(model, api)

async def tick(t, playing, wake):
    api.clock = {"t": t, "playing": playing}
    await runner.tick(playing, wake=bool(wake.to_py().get(getattr(model, "system", None))) and not playing)
    return [runner.phase, runner.detail, model.label]
`),r({type:"progress",model:t,stage:"ready",detail:"model loaded",pct:100}),w()}function J(s){setTimeout(w,s==="catching up"?0:250)}async function w(){if(!i||u)return;u=!0;let s="live";try{const e=await i.globals.get("tick")(m.t,m.playing,_),[t,a,n]=e.toJs();e.destroy(),s=t,y.postMessage({type:"phase",phase:s,detail:a,label:n}),r({type:"status",model:c,phase:s,detail:a})}catch(e){const t=String((e==null?void 0:e.message)??e).split(`
`).slice(-2).join(" ");y.postMessage({type:"phase",phase:"failed",detail:t,label:c}),r({type:"status",model:c,phase:"failed",detail:t})}finally{u=!1}d.length&&(r({type:"tap",messages:d}),d=[]),J(s)}self.onmessage=s=>{const e=s.data;e.type==="start"?(y=s.ports[0],S(e.pyodideUrl,e.pyZipUrl,e.model,e.code??null,e.apiUrl).catch(t=>r({type:"progress",model:e.model,stage:"error",detail:String(t),pct:0}))):e.type==="clock"&&(m={t:e.state.t,playing:e.state.playing},_=e.pending??{})};
//# sourceMappingURL=model.worker-4pdGvk4K.js.map
