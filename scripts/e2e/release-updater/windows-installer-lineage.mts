export const windowsInstallerLineageSource = String.raw`
  'installer-lineage' {
    $systemPS=@([IO.Path]::Combine($data.shell.systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),[IO.Path]::Combine($data.shell.systemRoot,'SysWOW64','WindowsPowerShell','v1.0','powershell.exe'))
    function Read-LineageRow([int]$processId) {
      $item=@(Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop)
      if ($item.Count -ne 1 -or -not $item[0].ExecutablePath) { throw 'Lineage identity unavailable' }
      $sid=Invoke-CimMethod -InputObject $item[0] -MethodName GetOwnerSid -ErrorAction Stop
      if ($sid.ReturnValue -ne 0) { throw 'Lineage SID unavailable' }
      @{ command=[string]$item[0].CommandLine; pid=$processId; parent=[int]$item[0].ParentProcessId; executable=$item[0].ExecutablePath; start=$item[0].CreationDate.ToUniversalTime().ToString('o'); sid=$sid.Sid; session=[int]$item[0].SessionId }
    }
    function Test-LineageParent($expected) {
      $fresh=Read-LineageRow $expected.pid
      if ($fresh.executable -ne $expected.executable -or -not (Test-SameStart $fresh.start $expected.start) -or $fresh.sid -ne $expected.sid -or $fresh.session -ne $expected.session) { throw 'Lineage parent identity changed' }
    }
    $owner=$data.owner; Test-OwnedPath $owner.executable | Out-Null
    if ($owner.sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $owner.session -ne (Get-Process -Id $PID).SessionId) { throw 'Installer owner/session mismatch' }
    Test-LineageParent $owner
    $rows=New-Object 'Collections.Generic.List[object]'; $queue=New-Object 'Collections.Generic.Queue[object]'
    $queue.Enqueue(@{ identity=$owner; depth=0 }); $limited=$false
    while ($queue.Count -gt 0 -and $rows.Count -lt 16) {
      $parent=$queue.Dequeue(); Test-LineageParent $parent.identity
      if ($parent.depth -ge 3) { $limited=$true; continue }
      $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($parent.identity.pid)" -ErrorAction Stop | Select-Object -First 17)
      foreach ($item in $children) {
        if ($rows.Count -ge 16) { $limited=$true; break }
        $child=Read-LineageRow $item.ProcessId; Test-LineageParent $parent.identity
        if ($child.parent -ne $parent.identity.pid -or $child.sid -ne $owner.sid -or $child.session -ne $owner.session -or (Get-StartUtcTicks $child.start) -lt (Get-StartUtcTicks $parent.identity.start)) { throw 'Lineage child relation changed' }
        $allowed=$child.executable.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $child.executable -in $systemPS
        if (-not $allowed) { $rows.Add(@{ pid=$child.pid; parent=$child.parent; rejected='Image outside TEST/systemPS bounds'; stopEligible=$false }); continue }
        if ($child.executable -notin $systemPS -or $child.command.Length -gt 4096 -or $child.command -notmatch '(?i)\bGet-Process\b' -or $child.command -match '(?i)token|secret|password|authorization|api.?key|encodedcommand') { $child.command=$null }
        Test-LineageParent $child
        $rows.Add(@{ identity=$child; depth=$parent.depth+1; stopEligible=$false })
        $queue.Enqueue(@{ identity=$child; depth=$parent.depth+1 })
      }
      Test-LineageParent $parent.identity
    }
    Test-LineageParent $owner
    $result=@{ root=$owner; descendants=@($rows.ToArray()); truncated=($limited -or $queue.Count -gt 0); source='CIM read-only ancestry observation'; ownershipAdopted=$false }
  }
`;
