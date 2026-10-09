// The same producer is embedded in native.ps1 and exercised by selected-PS7
// contract tests. A failed SID lookup is never permission to signal a process.
export const windowsReadOwnedSource = String.raw`
function Confirm-ExitedBeforeSid([int]$ownedId,[hashtable]$failure) {
  Write-TestProgress 'owner-sid-failed' $failure
  # Query all processes at this exact PID, independently of path and ownership.
  # Live/reused PID, query error, and ambiguous results must retain containment.
  $remaining = @(Get-CimInstance Win32_Process -Filter "ProcessId = $ownedId" -ErrorAction Stop)
  Write-TestProgress 'owner-sid-presence' @{ pid=$ownedId; count=$remaining.Count }
  if ($remaining.Count -ne 0) { throw "Cannot verify TEST process owner for PID $ownedId" }
  Write-TestProgress "owner-exited-before-sid-$ownedId" $failure
}
function Read-Owned([string]$file) {
  $full = Test-OwnedPath $file
  $items = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -eq $full })
  return @($items | ForEach-Object {
    $item = $_
    $ownedId = [int]$item.ProcessId
    try { $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid -ErrorAction Stop }
    catch [Microsoft.Management.Infrastructure.CimException] {
      if ($_.Exception.NativeErrorCode -ne [Microsoft.Management.Infrastructure.NativeErrorCode]::NotFound) { throw }
      Confirm-ExitedBeforeSid $ownedId @{ pid=$ownedId; returnValue=$null; nativeErrorCode=[string]$_.Exception.NativeErrorCode }
      return
    }
    if ($owner.ReturnValue -ne 0) {
      Confirm-ExitedBeforeSid $ownedId @{ pid=$ownedId; returnValue=$owner.ReturnValue; nativeErrorCode=$null }
      return
    }
    if ([string]::IsNullOrWhiteSpace($owner.Sid)) { throw "Missing TEST process owner SID for PID $ownedId" }
    @{ pid=$ownedId; parent=[int]$item.ParentProcessId; executable=$item.ExecutablePath; command=$item.CommandLine; start=$item.CreationDate.ToUniversalTime().ToString('o'); session=[int]$item.SessionId; sid=$owner.Sid }
  })
}
`;
