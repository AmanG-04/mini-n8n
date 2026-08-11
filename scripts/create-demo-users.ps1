param(
  [string]$Subdomain = "ewjqfthyydfvwoixtkyv",
  [string]$Region = "ap-south-1",
  [string]$OrgAName = "Org A",
  [string]$OrgBName = "Org B"
)

$ErrorActionPreference = "Stop"
$authUrl = "https://$Subdomain.auth.$Region.nhost.run/v1"
$graphqlUrl = "https://$Subdomain.graphql.$Region.nhost.run/v1"

function Read-SecretText([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$adminSecret = Read-SecretText "NHOST_ADMIN_SECRET"
$password = Read-SecretText "Temporary password for the four demo users"

function Invoke-Hasura([string]$Query, [hashtable]$Variables) {
  $headers = @{ "x-hasura-admin-secret" = $adminSecret }
  $body = @{ query = $Query; variables = $Variables } | ConvertTo-Json -Depth 10
  $result = Invoke-RestMethod -Method Post -Uri $graphqlUrl -Headers $headers -ContentType "application/json" -Body $body
  if ($result.errors) { throw ($result.errors | ConvertTo-Json -Depth 10 -Compress) }
  return $result.data
}

function Get-UserId([string]$Email, [string]$UserPassword) {
  $body = @{ email = $Email; password = $UserPassword } | ConvertTo-Json
  try {
    $result = Invoke-RestMethod -Method Post -Uri "$authUrl/signin/email-password" -ContentType "application/json" -Body $body
    if ($result.session.user.id) { return $result.session.user.id }
  } catch { }
  throw "Could not obtain a session for $Email. Disable Require Verified Emails first, then rerun."
}

function Create-OrGetUser([string]$Email, [string]$DisplayName) {
  $body = @{
    email = $Email
    password = $password
    options = @{ displayName = $DisplayName }
  } | ConvertTo-Json -Depth 5

  try {
    $result = Invoke-RestMethod -Method Post -Uri "$authUrl/signup/email-password" -ContentType "application/json" -Body $body
    if ($result.session.user.id) { return $result.session.user.id }
    throw "No session returned for $Email. Disable Require Verified Emails first."
  } catch {
    $message = $_.ErrorDetails.Message
    if ($message -and $message -match "already|exist|duplicate") {
      return Get-UserId $Email $password
    }
    throw $_
  }
}

$organizations = Invoke-Hasura `
  "query Organizations { organizations { id name } }" `
  @{}
$orgA = @($organizations.organizations | Where-Object name -eq $OrgAName)[0]
$orgB = @($organizations.organizations | Where-Object name -eq $OrgBName)[0]
if (-not $orgA -or -not $orgB) { throw "Could not find '$OrgAName' and '$OrgBName'. Update the script names or create both organizations first." }

$users = @(
  @{ email = "org-a-editor-2@example.com"; name = "Org A Editor 2"; org = $orgA.id; role = "editor" }
  @{ email = "org-a-viewer-2@example.com"; name = "Org A Viewer 2"; org = $orgA.id; role = "viewer" }
  @{ email = "org-b-owner-2@example.com"; name = "Org B Owner 2"; org = $orgB.id; role = "owner" }
  @{ email = "org-b-viewer-2@example.com"; name = "Org B Viewer 2"; org = $orgB.id; role = "viewer" }
)

foreach ($user in $users) {
  $userId = Create-OrGetUser $user.email $user.name
  $mutation = "mutation AddMember(`$org: uuid!, `$user: uuid!, `$role: org_role!) { insert_org_members_one(object: { org_id: `$org, user_id: `$user, role: `$role }, on_conflict: { constraint: org_members_pkey, update_columns: [role] }) { org_id user_id } }"
  Invoke-Hasura $mutation @{ org = $user.org; user = $userId; role = $user.role } | Out-Null
  Write-Output ("Created/updated {0} ({1}) in {2}" -f $user.email, $user.role, $(if ($user.org -eq $orgA.id) { $OrgAName } else { $OrgBName }))
}

Write-Output "Done. Use the same temporary password to sign in, then change it if needed."
