import json,glob,os,sys,collections
root=sys.argv[1]
def use(f):
    seen={}
    for line in open(f):
        try:d=json.loads(line)
        except:continue
        m=d.get('message') or {}
        if m.get('usage') and m.get('id'):seen[m['id']]=(m['usage'],m.get('model'))
    g=lambda k:sum(u.get(k,0) for u,_ in seen.values())
    peak=max([u.get('input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0) for u,_ in seen.values()] or [0])
    mod={m for _,m in seen.values()}
    return len(seen),g('input_tokens'),g('cache_creation_input_tokens'),g('cache_read_input_tokens'),g('output_tokens'),peak,'/'.join(sorted(x.replace('claude-','') for x in mod if x))
# rough cost weight: relative to base input price of that model; fable assumed 5x opus? unknown -> report token-weighted units only per model
def units(i,cw,cr,o):return i+1.25*cw+0.1*cr+5*o
agg=collections.defaultdict(lambda:[0,0,0,0,0,0,0.0])
rows=[]
n,i,cw,cr,o,p,m=use(root+'.jsonl');rows.append(('ORCHESTRATOR','-',1,n,i,cw,cr,o,p,m))
for mf in sorted(glob.glob(root+'/subagents/*.meta.json'),key=os.path.getmtime):
    md=json.load(open(mf));f=mf.replace('.meta.json','.jsonl')
    n,i,cw,cr,o,p,m=use(f)
    rows.append((md.get('agentType'),md.get('description','')[:45],md.get('spawnDepth'),n,i,cw,cr,o,p,m))
for r in rows:
    print(' | '.join(str(x) for x in r), '| units=%.0fk'%(units(*r[4:8])/1000))
    k=(r[0],r[9]);a=agg[k];a[0]+=1
    for j,v in enumerate(r[4:8]):a[j+1]+=v
    a[6]+=units(*r[4:8])
print('\nBY ROLE: count input cw cr out units_k share')
T=sum(a[6] for a in agg.values())
for k,a in sorted(agg.items(),key=lambda x:-x[1][6]):
    print(k,a[0],a[1],a[2],a[3],a[4],'%.0fk'%(a[6]/1000),'%.0f%%'%(100*a[6]/T))
