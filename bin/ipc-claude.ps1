param([Parameter(Mandatory)][string]$Name)
$env:IPC_NAME = $Name
claude --dangerously-load-development-channels server:ipc
