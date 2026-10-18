/**
 * C# engine sidecar source imported as text so `bun build --compile` embeds it
 * inside rc-agent.exe (see agent/src/powershell.d.ts for the same pattern
 * applied to the PowerShell helpers).
 */
declare module "*.cs" {
  const content: string;
  export default content;
}
