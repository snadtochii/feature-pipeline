import json,glob,os,sys
root=sys.argv[1]
for mf in sorted(glob.glob(root+'/subagents/*.meta.json'),key=os.path.getmtime):
    md=json.load(open(mf));f=mf.replace('.meta.json','.jsonl')
    plen=None;first=None
    for line in open(f):
        d=json.loads(line);m=d.get('message') or {}
        if d.get('type')=='user' and plen is None:
            c=m.get('content');plen=len(c) if isinstance(c,str) else sum(len(x.get('text','')) for x in c if isinstance(x,dict))
        u=m.get('usage')
        if u and first is None:
            first=u.get('input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0);break
    print(md['agentType'],'|',md['description'][:35],'| prompt_chars',plen,'~tok',plen//4,'| first_turn_ctx',first,'| overhead',first-plen//4)
