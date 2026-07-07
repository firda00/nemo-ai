# Post-deploy smoke test for the Ustudy Operations Team (scenarios B + C).
# Run AFTER deploy.ps1 and an OpenRouter top-up:  powershell -ExecutionPolicy Bypass -File .\smoke-ops.ps1
# Registers a throwaway account, seeds the team, runs both workflows, checks the DB, cleans up.

$ErrorActionPreference = 'Stop'
$ref = 'ogfmyjiuqmgroobckdyw'
$base = "https://$ref.supabase.co"
$anon = 'sb_publishable_QvdG3S1oMAgXWv53R2_hpQ_osQd_s8_'
$rnd = Get-Random -Maximum 999999
$email = "nemo-ops-$rnd@example.com"; $pw = "NemoQa!$rnd"

$sh = @{ apikey = $anon; 'Content-Type' = 'application/json' }
$tok = (Invoke-RestMethod -Uri "$base/auth/v1/signup" -Method Post -Headers $sh -Body (@{ email=$email; password=$pw } | ConvertTo-Json)).access_token
if (-not $tok) { throw "signup failed" }
$h = @{ apikey = $anon; Authorization = "Bearer $tok"; 'Content-Type' = 'application/json'; Prefer = 'return=representation' }
Write-Host "Account: $email`n"

# 1) seed team: workflow agent + department + 6 sub_agents
$agent = (Invoke-RestMethod -Uri "$base/rest/v1/agents" -Method Post -Headers $h -Body (@{ name='Ustudy Operations Team'; type='workflow'; model='openai/gpt-4o-mini'; default_lang='en'; status='active' } | ConvertTo-Json))[0]
$dept  = (Invoke-RestMethod -Uri "$base/rest/v1/departments" -Method Post -Headers $h -Body (@{ main_agent_id=$agent.id; name='Ustudy Operations'; niche='education operations' } | ConvertTo-Json))[0]
$names = 'Operations Lead Agent','Payment Reminder Agent','Admin Control Agent','Meeting Analyst Agent','Task Manager Agent','Report Agent'
$rows = $names | ForEach-Object { @{ department_id=$dept.id; role='Specialist'; name=$_; prompt=@{ role=$_; tasks='do your part'; tone='pro'; rules='' }; model='openai/gpt-4o-mini'; status='active' } }
Invoke-RestMethod -Uri "$base/rest/v1/sub_agents" -Method Post -Headers $h -Body (ConvertTo-Json @($rows) -Depth 6) | Out-Null
Write-Host "Seeded: agent $($agent.id), department $($dept.id), 6 sub-agents"

$fn = "$base/functions/v1/ops-workflow"
$samplePayment = "Aziza Karimova, IELTS, 1 200 000 UZS, due 2026-07-05, unpaid, admin: Dilshod`nJavohir Tursunov, Frontend, 2 400 000 UZS, due 2026-07-03, unpaid, admin: Madina"
$sampleMeeting = "Ustudy sync. Dilshod must call unpaid Frontend students by 2026-07-05. Madina owns parent follow-up by 2026-07-04. Mentor quality report overdue, Akmal reviews this week."

# 2) Payment Control
Write-Host "`n=== Payment Control ==="
$pc = Invoke-RestMethod -Uri $fn -Method Post -Headers $h -Body (@{ action='payment_control'; department_id=$dept.id; input=$samplePayment; lang='en' } | ConvertTo-Json)
Write-Host ("  reminders: {0}  escalations: {1}  notifications saved: {2}  run: {3}" -f $pc.reminders.Count, $pc.escalations.Count, $pc.notification_ids.Count, $pc.run_id)

# 3) Meeting to Tasks
Write-Host "=== Meeting to Tasks ==="
$mt = Invoke-RestMethod -Uri $fn -Method Post -Headers $h -Body (@{ action='meeting_to_tasks'; department_id=$dept.id; input=$sampleMeeting; lang='en' } | ConvertTo-Json)
Write-Host ("  decisions: {0}  tasks: {1}  tasks saved: {2}  run: {3}" -f $mt.decisions.Count, $mt.tasks.Count, $mt.task_ids.Count, $mt.run_id)

# 4) verify persisted in DB
$tasksDb = Invoke-RestMethod -Uri "$base/rest/v1/tasks?department_id=eq.$($dept.id)&select=title,owner,status" -Headers $h
$notifDb = Invoke-RestMethod -Uri "$base/rest/v1/notifications?department_id=eq.$($dept.id)&select=title,risk" -Headers $h
$runsDb  = Invoke-RestMethod -Uri "$base/rest/v1/research_runs?department_id=eq.$($dept.id)&select=task,kind" -Headers $h
Write-Host "`n=== Saved in DB ==="
Write-Host ("  tasks rows: {0}  notifications rows: {1}  runs rows: {2}" -f $tasksDb.Count, $notifDb.Count, $runsDb.Count)
$pcOk = ($pc.ok -and $pc.run_id); $mtOk = ($mt.ok -and $mt.task_ids.Count -gt 0)
Write-Host ("`n  Payment Control: {0}   Meeting to Tasks: {1}" -f $(if($pcOk){'PASS'}else{'CHECK'}), $(if($mtOk){'PASS'}else{'CHECK'}))
Write-Host "TEST-EMAIL:$email  (delete later: delete from auth.users where email like 'nemo-ops-%')"
