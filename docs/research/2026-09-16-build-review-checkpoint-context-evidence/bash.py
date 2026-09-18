import json,sys,re,collections
calls={};res={};turnof={};turn=0;seen=set()
for line in open(sys.argv[1]):
    d=json.loads(line);m=d.get('message') or {};c=m.get('content')
    if d.get('type')=='assistant' and m.get('id') not in seen:seen.add(m.get('id'));turn+=1
    for x in c if isinstance(c,list) else []:
        if x.get('type')=='tool_use' and x['name']=='Bash':calls[x['id']]=x['input'].get('command','');turnof[x['id']]=turn
        if x.get('type')=='tool_result' and x['tool_use_id'] in calls:
            cc=x.get('content');res[x['tool_use_id']]=len(cc) if isinstance(cc,str) else sum(len(y.get('text','')) for y in cc if isinstance(y,dict))
def cat(c):
    s=c.strip()
    if re.search(r'check-[a-z-]+\.sh|npm (run|test|ci)|vitest|node |bash scripts',s):return 'run checks/tests'
    if re.search(r'\bgit (add|commit|push)|gh pr',s):return 'git/gh write'
    if re.search(r'\bgit ',s):return 'git read'
    if re.search(r'^(echo .*&& )?(cat|sed -n|head|tail|ls|grep|find|wc)\b',s) or re.search(r'\b(cat|sed -n|grep|ls)\b',s):return 'read/search files'
    return 'other'
k=collections.defaultdict(lambda:[0,0,0])
for i,c in calls.items():
    a=k[cat(c)];a[0]+=1;a[1]+=len(c)//4;a[2]+=res.get(i,0)//4
for kk,a in sorted(k.items(),key=lambda x:-x[1][0]):print(f'{kk:20} calls {a[0]:3} args_tok {a[1]:6} result_tok {a[2]:6}')
print('--- other samples');[print(' ',c[:110].replace('\n',' ')) for c in calls.values() if cat(c)=='other'][:8]
