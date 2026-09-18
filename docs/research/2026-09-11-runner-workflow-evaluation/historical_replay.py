import json
from pathlib import Path
import sys

prototype = Path('/Users/serhiinadtochii/Projects/feature-pipeline/prototypes/codex-ticket-runner')
sys.path.insert(0, str(prototype))
from test_runner import RunnerFixture

f = RunnerFixture()
f.setUp()
try:
    evidence = Path('/Users/serhiinadtochii/Projects/feature-pipeline/docs/research/2026-09-11-pr-150-final-gates-evidence')
    selections = [
        ('scope', 'scope.cjs', "assert not data['approval']['foreignPreviewReturnedOwnerRequest'], 'Foreign scope read owner preview'"),
        ('receipt', 'ui.cjs', "assert 'undo-dispatched' not in data['unmountedRegistration'], 'Undo dispatched after unmount'"),
        ('purge', 'ui.cjs', "assert data['purge']['callsAfterFirstClick']['request'] == 0, 'Purge dispatched before confirmation'"),
    ]
    f.init()
    f.cli('next')
    f.cli('plan', str(f.plan_report()))
    checks = []
    cases = []
    for name, probe, assertion in selections:
        command = "import json,subprocess; data=json.loads(subprocess.check_output(['node'," + repr(str(evidence / probe)) + "],text=True)); " + assertion
        checks.append(f.check(name, command))
        cases.append({'id': name, 'invariant': 'Confirmed audited behavior must be repaired',
                      'setup': 'Run saved production-source or component audit probe against current personal-server source',
                      'expected': assertion, 'check': name})
    f.cli('challenge', str(f.challenge_report(cases=cases, checks=checks,
        selection_basis='Known-case replay selected by the audit author, not blind model discovery. Synthetic report identity.')))
    (f.repo / 'app.txt').write_text('hello')
    f.work()
    f.cli('check', 'unit')
    result = {'kind': 'known-case mechanical replay, not independent discovery', 'cases': {}}
    for name, _, _ in selections:
        outcome = f.cli('check', name, ok=False)
        result['cases'][name] = {'exit_code': outcome['exit_code'], 'log': Path(outcome['log']).read_text()}
    decision = f.cli('status')
    result['outcome'] = decision['outcome']
    result['missing_checks'] = decision['missing_checks']
    result['commit_rejection'] = f.cli('commit', '--message', 'DEMO-1: Unfixed historical fixture', ok=False)['outcome']
    result['head_unchanged'] = f.git('rev-parse', 'HEAD') == f.initial
    Path('/private/tmp/runner-historical-replay-results.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2))
finally:
    f.doCleanups()
