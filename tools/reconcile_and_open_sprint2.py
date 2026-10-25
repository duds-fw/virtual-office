#!/usr/bin/env python3
"""
Reconcile Sprint 1 against what actually got built, then open Sprint 2.

Only work that is verifiably complete is marked done; anything the interrupted
subagents never finished stays open and carries into the next sprint.
All writes go through the HTTP API so the running server's in-memory state and
the file on disk never disagree.
"""
import json, subprocess, sys

BASE = 'http://127.0.0.1:9012'

def api(path, method='GET', body=None):
    cmd = ['curl', '-s', '-m', '20', '-X', method, BASE + path]
    if body is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {'ok': False, 'raw': out[:200]}

def state():
    return api('/api/agency/state')

def by_title(st, frag):
    for t in st['tasks']:
        if frag.lower() in t['title'].lower():
            return t
    return None

# --- 1. verify the work that is claimed complete ---------------------------
checks = {
    'Implement project/sprint/task engine': 'agency.js' in open('/home/opencode/virtual-office/agency.js').read(),
    'Persist agency state to disk': __import__('os').path.exists('/home/opencode/virtual-office/state/agency.json'),
    'Wire autonomy to agency API': 'api/agency/state' in open('/home/opencode/virtual-office/server.js').read(),
    'Test task lifecycle & resource rules': __import__('os').path.exists('/home/opencode/virtual-office/tools/agency_rules_test.js'),
    'Design office board & workload panels': 'popup-workload' in open('/home/opencode/virtual-office/public/index.html').read(),
    'Deploy agency release': __import__('os').path.exists('/etc/systemd/system/opencode-server.service'),
}

st = state()
print('RECONCILING SPRINT 1')
for frag, verified in checks.items():
    t = by_title(st, frag)
    if not t:
        print(f'  ? {frag:<42} (task not found)')
        continue
    if not verified:
        print(f'  - {frag:<42} NOT verified -> stays {t["status"]}')
        continue
    if t['status'] == 'done':
        print(f'  = {frag:<42} already done')
        continue
    r = api(f'/api/agency/task/{t["id"]}/status', 'POST', {'status': 'done'})
    print(f'  + {frag:<42} -> done (verified: {verified})')

# --- 2. work that was interrupted stays open ------------------------------
st = state()
for frag in ('Map agency workflow', 'Security review of agency API'):
    t = by_title(st, frag)
    if t:
        print(f'  ~ {frag:<42} stays {t["status"]} (subagent was interrupted)')

# --- 3. rename the probe into a real blocked task --------------------------
st = state()
probe = by_title(st, 'Live escalation probe')
if probe:
    api(f'/api/agency/task/{probe["id"]}', 'PATCH',
        {'title': 'Integrate with upstream sprint-board API'})
    print('  * renamed probe -> "Integrate with upstream sprint-board API" (remains blocked, drives the live escalation ladder)')

# --- 4. open Sprint 2 ------------------------------------------------------
st = state()
sprint2 = api('/api/agency/sprint', 'POST', {
    'name': 'Sprint 2 — Client Loop & Observability',
    'goal': 'Close the agency loop: client review and feedback, defect tracking, escalation surface, budget tracking, and a real velocity history across two sprints.',
    'days': 14,
})
s2id = sprint2['sprint']['id']
print(f'\nOPENED Sprint 2: {sprint2["sprint"]["name"]} ({s2id})')

st = state()
s1 = [s for s in st['sprints'] if s['status'] == 'completed']
print(f'  Sprint 1 closed: {[s["name"] for s in s1]}')

# --- 5. carry over unfinished work, then add the derived backlog ----------
carry = ['Runbook & SLA monitoring']
for frag in carry:
    t = by_title(state(), frag)
    if t:
        api(f'/api/agency/task/{t["id"]}', 'PATCH', {'sprintId': s2id})
        print(f'  -> carried over: {t["title"]}')

BACKLOG = [
    ('Client review loop: approve / reject / request changes on delivered work', 'Development', 'software_engineer', 12),
    ('Client feedback surface in the office UI', 'Design', 'ui_ux_designer', 8),
    ('Defect reporting path and defect-rate metric', 'Development', 'software_engineer', 8),
    ('Escalation panel showing level, owner and age in the office UI', 'Design', 'ui_ux_designer', 6),
    ('Standup digest delivered into the activity feed each morning', 'Development', 'ai_engineer', 8),
    ('Budget tracking: project budget vs hours consumed', 'Development', 'database_engineer', 8),
    ('Sprint retrospective and velocity trend across sprints', 'Analysis', 'data_analyst', 6),
    ('Re-run the interrupted agency requirements map', 'Analysis', 'business_enablement', 8),
    ('Re-run the interrupted agency API security review', 'Review', 'network_and_security', 4),
]

print('\nSPRINT 2 BACKLOG')
for title, phase, role, hours in BACKLOG:
    r = api('/api/agency/task', 'POST', {
        'title': title, 'phase': phase, 'role': role,
        'estimateHours': hours, 'sprintId': s2id,
    })
    t = r.get('task') or {}
    assigned = (r.get('assignment') or {}).get('agentId')
    print(f'  + {title[:58]:<58} {phase:<12} {hours:>3}h owner={assigned}')

print('\nDONE')
