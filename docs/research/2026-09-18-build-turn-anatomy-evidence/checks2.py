import json,sys,re,collections
f,lab=sys.argv[1],sys.argv[2]
seen=set();n=0;chk=0;edit_heredoc=0;read_slice=0;pyedit=0;pyedit_noassert=0
CHK=re.compile(r'(^|[;&|]\s*|\bcd [^;&|]*&&\s*|time |timeout \d+ )(pnpm|npm|npx|yarn|bun|node|bash|vitest|jest|tsc|eslint|pytest|ruff|mypy|cargo|go)\b[^;&|<]*(test|lint|typecheck|tsc|vitest|jest|check-[a-z-]+\.sh|--check|eslint|pytest|ruff|mypy|clippy|vet)')
for line in open(f):
    d=json.loads(line);m=d.get('message') or {};c=m.get('content')
    if d.get('type')!='assistant':continue
    if m.get('id') not in seen:seen.add(m.get('id'));n+=1
    for x in c if isinstance(c,list) else []:
        if x.get('type')!='tool_use' or x['name']!='Bash':continue
        cmd=x['input'].get('command','')
        head=re.sub(r"<<\s*'?\"?([A-Za-z_]+)'?\"?.*?\n\1\b",'<<HEREDOC',cmd,flags=re.S)  # strip heredoc bodies
        if CHK.search(head):chk+=1
        if re.search(r'python3? -\s*<<|python3? - "\$f" <<',cmd):
            pyedit+=1
            if 'assert' not in cmd and 'count(' not in cmd and 'not in s' not in cmd and 'raise' not in cmd:pyedit_noassert+=1
        if re.search(r"cat >{1,2} \S+ <<",cmd):edit_heredoc+=1
        if re.search(r"sed -n '?\d+,\d+p'?",head):read_slice+=1
print(f'{lab:13} turns {n:4} check-runs {chk:3}  python-heredoc-edits {pyedit:3} (no assert {pyedit_noassert:3})  cat-heredoc-writes {edit_heredoc:3}  sed-slice-reads {read_slice:3}')
