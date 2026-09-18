import json,sys,re,collections
f=sys.argv[1]; mode=sys.argv[2] if len(sys.argv)>2 else 'timeline'
calls={};turn=0;seen=set();rows=[];out=collections.Counter();usage_out=0;turn_marker={}
cur=None
for line in open(f):
    d=json.loads(line);m=d.get('message') or {};c=m.get('content')
    if d.get('type')=='assistant':
        if m.get('id') not in seen:
            seen.add(m.get('id'));turn+=1;u=m.get('usage',{})
            cur={'t':turn,'ctx':u.get('input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0),'calls':[],'text':'','think':0}
            rows.append(cur);usage_out+=u.get('output_tokens',0)
        for x in c if isinstance(c,list) else []:
            if x.get('type')=='tool_use':
                i=x['input'];n=x['name']
                lab=re.sub(r'\s+',' ',i.get('command',''))[:150] if n=='Bash' else (i.get('file_path','').split('/')[-1]+(f" off={i.get('offset')}" if i.get('offset') else '') if n in('Read','Edit','Write') else i.get('description','')[:60] if n=='Agent' else '')
                calls[x['id']]=len(cur['calls']);cur['calls'].append([n,lab,'',0]);out['args']+=len(json.dumps(i))
            elif x.get('type')=='text':
                cur['text']+=x['text'];out['text']+=len(x['text'])
                mm=re.search(r'Turn (\d+)/25',x['text'])
                if mm:turn_marker[turn]=mm.group(1)
            elif x.get('type')=='thinking':cur['think']+=len(x.get('thinking',''));out['thinking']+=len(x.get('thinking',''))
    elif d.get('type')=='user' and isinstance(c,list):
        for x in c:
            if x.get('type')=='tool_result' and x['tool_use_id'] in calls:
                cc=x.get('content');t=cc if isinstance(cc,str) else ''.join(y.get('text','') for y in cc if isinstance(y,dict))
                idx=calls[x['tool_use_id']]
                # owning row: the latest row whose call at this index has no result yet
                for r in rows[::-1]:
                    if idx<len(r['calls']) and r['calls'][idx][2]=='' and r['calls'][idx][3]==0:
                        st='ERR' if x.get('is_error') else ('X'+re.search(r'Exit code (\d+)',t).group(1) if re.search(r'^Exit code (\d+)',t) else 'ok')
                        r['calls'][idx][2]=st;r['calls'][idx][3]=len(t);break
N=turn
if mode=='timeline':
    for r in rows:
        mk=f"[T{turn_marker[r['t']]}]" if r['t'] in turn_marker else '     '
        cs=' | '.join(f"{c[0]}:{c[2]}:{c[3]//4}t {c[1][:110]}" for c in r['calls']) or ('text:'+r['text'][:80].replace('\n',' '))
        print(f"{r['t']:3} {r['ctx']//1000:3}k th{r['think']//4:4} {mk} {cs}")
elif mode=='out':
    print(f"turns {N} usage output_tokens {usage_out} | chars/4: thinking {out['thinking']//4} text {out['text']//4} tool-args {out['args']//4}")
elif mode=='checks':
    cc=collections.Counter()
    for r in rows:
        for c in r['calls']:
            if c[0]=='Bash' and re.search(r'check-[a-z-]+\.sh|npm (run|test|ci|exec)|pnpm (run|test|exec|lint|typecheck|tsc)|npx |vitest|jest|tsc\b|eslint|pytest|ruff|mypy|cargo|bash scripts|uv run',c[1]):
                key=re.sub(r'/Users/\S+','<p>',c[1]);key=re.sub(r'\d+','N',key)[:120];cc[key]+=1
    for k,v in cc.most_common(25):print(f'{v:3} {k}')
