import json,sys,re,collections
f,lab=sys.argv[1],sys.argv[2]
seen=set();t=0;seg=[];cur=None;last_usage={}
def newseg(name):
    global cur;cur={'name':name,'turns':0,'reads':set(),'edits':set(),'checks':0,'other':0,'calls':0};seg.append(cur)
newseg('setup')
for line in open(f):
    d=json.loads(line);m=d.get('message') or {};c=m.get('content')
    if d.get('type')!='assistant':continue
    if m.get('id') not in seen:seen.add(m.get('id'));t+=1;cur['turns']+=1
    if m.get('usage'):last_usage[m['id']]=m['usage']
    for x in c if isinstance(c,list) else []:
        if x.get('type')=='text':
            mm=re.search(r'Turn (\d+)/25',x['text'])
            if mm:newseg('T'+mm.group(1));cur['turns']+=1
        if x.get('type')!='tool_use':continue
        cur['calls']+=1;n=x['name'];i=x['input']
        if n=='Read':cur['reads'].add(i.get('file_path','').split('/')[-1])
        elif n in('Edit','Write','MultiEdit'):cur['edits'].add(i.get('file_path','').split('/')[-1])
        elif n=='Bash':
            cmd=i.get('command','');head=re.sub(r"<<\s*'?\"?([A-Za-z_]+)'?\"?.*?\n\1\b",'<<H',cmd,flags=re.S)
            if re.search(r'(pnpm|npm|npx|node|bash|vitest|tsc|eslint|pytest)\b[^;&|<]*(test|lint|typecheck|tsc|vitest|check-[a-z-]+\.sh|--check|eslint)',head):cur['checks']+=1
            elif re.search(r"python3? -\s*<<|cat >{1,2} \S+ <<|sed -i",cmd):
                for mm in re.finditer(r"p\s*=\s*'([^']+)'|cat >{1,2} (\S+) <<|sed -i [^ ]* \S+ (\S+)$",cmd):
                    cur['edits'].add((mm.group(1) or mm.group(2) or mm.group(3) or '').split('/')[-1])
            elif re.search(r"\b(sed -n|cat|grep|head|tail|ls|find)\b",head):
                for mm in re.finditer(r"(?:sed -n '?\d+,\d+p'? |cat |grep [^ ]* (?:-[A-Za-z]+ )*(?:\"[^\"]*\" |'[^']*' )?|head -\d+ |tail -\d+ )(\S+\.[a-z]+)",head):cur['reads'].add(mm.group(1).split('/')[-1])
            else:cur['other']+=1
out=sum(u.get('output_tokens',0) for u in last_usage.values())
print(f'== {lab}: turns {t} output_tokens(terminal) {out}')
ideal=0
for s in seg:
    r,e=len(s['reads']),len(s['edits'])
    # ideal: 1 read turn (if reads), 1 edit turn per distinct-file wave (edits batched), 1 check turn, +1 per extra check (fix iteration)
    ideal_s=(1 if r else 0)+(1 if e else 0)+max(s['checks'],1 if e else 0)
    ideal+=ideal_s
    print(f"  {s['name']:6} turns {s['turns']:3} calls {s['calls']:3} read-files {r:2} edit-files {e:2} checks {s['checks']:2} other {s['other']:2}  -> batched-ideal ~{ideal_s}")
print(f'  batched-ideal total ~{ideal} vs actual {t}')
